import type { ControlResult } from './control-result.js'
import { resolveConfig, type Config, type ConfigInput, type ResolvedConfig } from './config.js'
import { safeStartupError } from './safe-error.js'
import type { HostRemoteStatus } from './service.js'
import {
  registerControlRoute,
  type ControlRouteHandler,
  type HostConnectionHandleLike,
  type HostWebServerLike,
} from './control-route.js'
import { ControlStatusStream } from './control-stream.js'
import type { TailnetControl } from './tailnet/orchestrator.js'

/** 插件设置页读取的配置视图。 */
export interface PluginSettingsView {
  config: Config
  deviceName: string
  writable: boolean
  startupError?: {
    code: string
    message: string
  }
}

/**
 * Live read/write face of the plugin's profile-owned entry Config.
 *
 * DSH 0.1.7-rc.1 (DSH-0.1.7-RC1-04) removed the settings-namespace registry
 * and its scope type: the entry's editable fields are a single
 * `.volatile()` Cordis Config, read through `.get()`, and writes go to
 * `ctx.settings.replace(entryId, section)` (persisted in the active profile's
 * `cordis.patch.yml` under the entry id).
 */
export interface PluginSettingsBinding {
  /** The current config, read from the entry's live volatile reference. */
  get(): ConfigInput
  /** Replace the entry's editable fields in the active profile. */
  replace(section: Config): Promise<void>
}

/** Host 运行时暴露给控制面的最小接口。 */
export interface HostControl {
  hostStatus(): HostRemoteStatus
  authorizeHostWithAccount(email: string, password: string): Promise<unknown>
  reconnectHost(): void
  setHostControl(enabled: boolean, options?: { connect?: boolean }): Promise<void>
  renameHost(deviceName: string, credentials?: { account: string; password: string }): Promise<HostRemoteStatus>
  setTerminalEnabled?(enabled: boolean): void
  setLoopbackPorts?(ports: readonly number[]): void
}

/** 控制面返回给界面的业务错误，保留便于界面判断的错误码。 */
export class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ControlError'
  }
}

/** Loopback-only control plane used by the settings page and the workbench. */
export class PluginControlRuntime {
  private startupFailure?: unknown

  setStartupFailure(error: unknown): void {
    this.startupFailure = error
    this.host = undefined
  }

  clearStartupFailure(): void {
    this.startupFailure = undefined
  }

  constructor(
    private config: ResolvedConfig,
    private readonly settings: PluginSettingsBinding | undefined,
    private host: HostControl | undefined,
    /** 内嵌节点与本地中继的编排；未启用时为 undefined。 */
    private readonly tailnet?: TailnetControl,
  ) {}

  register(connection: HostConnectionHandleLike, webServer?: HostWebServerLike): () => Promise<void> {
    const statusStream = new ControlStatusStream(() => this.streamStatus())
    return registerControlRoute(
      connection,
      (endpoint, payload, signal) => this.handle(endpoint, payload, signal),
      webServer,
      statusStream,
    )
  }

  /**
   * Read the value the status event stream pushes. It resolves through the same
   * endpoint handler as the unary `status` control call, so a pushed status and
   * a polled one can never diverge.
   */
  private async streamStatus(): Promise<unknown> {
    const result = await this.handle('status', {}, new AbortController().signal)
    if (!result.ok) throw new ControlError('STATUS_UNAVAILABLE', result.error.message)
    return result.value
  }

  private async handle(endpoint: string, payload: unknown, _signal: AbortSignal): Promise<ControlResult<unknown>> {
    try {
      if (endpoint === 'settings.development.set') return ok(await this.setDevelopment(payload))
      if (endpoint === 'settings.appearance.set') return ok(await this.setAppearance(payload))
      if (endpoint === 'settings.get') return ok(this.settingsView())
      if (endpoint === 'service.set') return this.withTailnet(ok(await this.setService(payload)))
      if (endpoint === 'settings.deviceName.set') return this.withTailnet(ok(await this.setDeviceName(payload)))
      if (endpoint === 'host.reconnect') {
        if (this.host === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '插件当前没有运行 Host。')
        this.host.reconnectHost()
        return this.withTailnet(ok(this.hostOnlyStatus()))
      }
      if (endpoint === 'tailnet.status') return ok(this.tailnet?.snapshot() ?? null)
      if (endpoint === 'tailnet.credentials') return ok(this.credentials())
      if (endpoint === 'tailnet.ssh.credentials') return ok(this.sshCredentials())
      if (endpoint === 'ssh.set') return this.withTailnet(ok(await this.setSsh(payload)))
      if (endpoint === 'ssh.pin') return this.withTailnet(ok(await this.setSshPin(payload)))
      if (endpoint === 'tailnet.set') return this.withTailnet(ok(await this.setTailnet(payload)))
      if (endpoint === 'tailnet.mode.set') return this.withTailnet(ok(await this.setMode(payload)))
      if (endpoint === 'tailnet.system.refresh') return this.withTailnet(ok(await this.refreshSystem()))
      if (endpoint === 'tailnet.extension.download') return this.withTailnet(ok(await this.downloadExtension()))
      if (endpoint === 'tailnet.extension.remove') return this.withTailnet(ok(await this.removeExtension()))
      if (endpoint === 'tailnet.credentials.save') return ok(await this.saveCredentials(payload))
      if (endpoint === 'status') {
        if (this.startupFailure !== undefined) {
          return this.withTailnet(ok({
            deviceName: this.config.deviceName,
            startupError: safeStartupError(this.startupFailure),
            serviceAvailable: false,
          }))
        }
        return this.withTailnet(ok(this.hostOnlyStatus()))
      }
      throw new ControlError('METHOD_NOT_ALLOWED', `Unknown control endpoint: ${endpoint}`)
    } catch (error) {
      return fail(error)
    }
  }

  private credentials(): { account: string; password: string } {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '内嵌节点未启用。')
    const credentials = this.tailnet.credentials()
    if (credentials === undefined) throw new ControlError('CREDENTIALS_UNAVAILABLE', '中继账号尚未生成，请等待内嵌节点与中继就绪。')
    return credentials
  }

  private sshCredentials(): { username: string; password: string; port: number; token?: string } {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '内嵌节点未启用。')
    const credentials = this.tailnet.sshCredentials()
    if (credentials === undefined) throw new ControlError('CREDENTIALS_UNAVAILABLE', 'SSH 模式尚未就绪，请等待内嵌节点启动完成。')
    return credentials
  }

  /** 切换组网模式；写入配置后由编排停掉旧后端再按新模式启动。 */
  private async setMode(payload: unknown): Promise<Record<string, unknown>> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (value.mode !== 'system' && value.mode !== 'embedded') throw new ControlError('INVALID_MESSAGE', '需要提供有效的组网模式。')
    const current = resolveConfig(this.settings.get())
    const next = resolveConfig({ ...editableConfig(current), tailnet: { ...current.tailnet, mode: value.mode } })
    await this.settings.replace(editableConfig(next))
    this.config = next
    if (this.tailnet !== undefined) await this.tailnet.applyMode(value.mode)
    return this.hostOnlyStatus()
  }

  /** 重新探测系统客户端状态。 */
  private async refreshSystem(): Promise<Record<string, unknown>> {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '组网未启用。')
    await this.tailnet.refreshSystem()
    return this.hostOnlyStatus()
  }

  /** 下载 wasm 扩展组件。 */
  private async downloadExtension(): Promise<Record<string, unknown>> {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '组网未启用。')
    await this.tailnet.downloadExtension()
    return this.hostOnlyStatus()
  }

  /** 删除 wasm 扩展组件。 */
  private async removeExtension(): Promise<Record<string, unknown>> {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '组网未启用。')
    await this.tailnet.removeExtension()
    return this.hostOnlyStatus()
  }
  /**
   * 切换内嵌节点开关。节点是中继与 SSH 共用的底座，关闭时两者都无法运行。
   */
  private async setTailnet(payload: unknown): Promise<Record<string, unknown>> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_MESSAGE', '需要提供内嵌节点的开关状态。')
    const current = resolveConfig(this.settings.get())
    if (!value.enabled && (current.service.enabled !== false || current.ssh.enabled)) {
      throw new ControlError('TAILNET_IN_USE', '请先关闭中继服务与 SSH 服务，再关闭内嵌节点。')
    }
    const next = resolveConfig({ ...editableConfig(current), tailnet: { ...current.tailnet, enabled: value.enabled } })
    await this.settings.replace(editableConfig(next))
    this.config = next
    if (this.tailnet === undefined) return this.hostOnlyStatus()
    if (value.enabled) await this.tailnet.start()
    else await this.tailnet.stop()
    return this.hostOnlyStatus()
  }

  /**
   * 「中继服务」总开关：打开时先启动内嵌节点与本地中继，节点仍在等 Tailscale 授权时
   * 只打开开关、由编排在就绪回调里完成 Host 授权与连接；关闭时先断开 Host 连接，再停止中继与节点。
   */
  private async setService(payload: unknown): Promise<Record<string, unknown>> {
    const value = record(payload)
    if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_MESSAGE', '需要提供中继服务的开关状态。')
    if (value.enabled && this.config.tailnet.enabled === false) {
      throw new ControlError('TAILNET_DISABLED', '请先打开内嵌节点，再开启中继服务。')
    }
    await this.persistService(value.enabled)
    if (!value.enabled) {
      await this.host?.setHostControl(false)
      await this.tailnet?.applyService(false)
      return this.hostOnlyStatus()
    }
    if (this.host === undefined) throw new ControlError('METHOD_NOT_ALLOWED', '插件当前没有运行 Host。')
    if (this.tailnet === undefined) {
      await this.host.setHostControl(true)
      return this.hostOnlyStatus()
    }
    await this.tailnet.applyService(true)
    const snapshot = this.tailnet.snapshot()
    if (snapshot?.phase === 'error') {
      throw new ControlError('REMOTE_SERVICE_UNAVAILABLE', snapshot.error?.message ?? '中继服务启动失败。')
    }
    if (snapshot?.phase !== 'disabled' && !this.tailnet.relayReady()) {
      // 节点还没入网（等授权或仍在启动）：先打开开关但不连接，
      // 授权完成后由编排的 onReady 回调授权并恢复控制连接。
      await this.host.setHostControl(true, { connect: false })
      return this.hostOnlyStatus()
    }
    await this.host.setHostControl(true)
    return this.hostOnlyStatus()
  }

  /** 面板上开关 SSH 服务；写入配置后由编排就地生效。 */
  private async setSsh(payload: unknown): Promise<Record<string, unknown>> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (typeof value.enabled !== 'boolean') throw new ControlError('INVALID_MESSAGE', '需要提供 SSH 服务的开关状态。')
    if (value.enabled && this.config.tailnet.enabled === false) {
      throw new ControlError('TAILNET_DISABLED', '请先打开内嵌节点，再开启 SSH 服务。')
    }
    const current = resolveConfig(this.settings.get())
    // 开关只改 enabled；固定值照旧保留，固定端口不会因为关一次 SSH 就丢。
    const pinnedPort = current.ssh.pinnedPort
    const next = resolveConfig({
      ...editableConfig(current),
      ssh: pinnedPort === undefined
        ? { enabled: value.enabled }
        : { enabled: value.enabled, pinnedPort },
    })
    await this.settings.replace(editableConfig(next))
    this.config = next
    await this.tailnet?.applySsh(next.ssh)
    return this.hostOnlyStatus()
  }

  /**
   * 面板上固定端口；已固定时点击解绑，撤掉记录与回环代理。
   *
   * 客户端只认这个端口，实例换端口后由编排在本机回环上做反向代理。
   */
  private async setSshPin(payload: unknown): Promise<Record<string, unknown>> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (typeof value.pinned !== 'boolean') throw new ControlError('INVALID_MESSAGE', '需要提供固定端口的操作。')
    const current = resolveConfig(this.settings.get())
    const target = value.pinned ? this.tailnet?.snapshot()?.webPort : undefined
    if (value.pinned && target === undefined) {
      throw new ControlError('TAILNET_NO_WEB_PORT', '取不到当前 DSH Web 端口，请等待内嵌节点启动完成后再固定端口。')
    }
    const next = resolveConfig({
      ...editableConfig(current),
      ssh: target === undefined
        ? { enabled: current.ssh.enabled }
        : { enabled: current.ssh.enabled, pinnedPort: target },
    })
    await this.settings.replace(editableConfig(next))
    this.config = next
    await this.tailnet?.applyPin(value.pinned)
    return this.hostOnlyStatus()
  }

  /** 中继服务停止时保存账号密码；启动服务时再读取新凭据并完成 Host 授权。 */
  private async saveCredentials(payload: unknown): Promise<unknown> {
    if (this.tailnet === undefined) throw new ControlError('METHOD_NOT_ALLOWED', 'Tailscale 组网未启用。')
    const value = record(payload)
    if (typeof value.account !== 'string' || value.account.trim() === '' || typeof value.password !== 'string' || value.password === '') {
      throw new ControlError('INVALID_MESSAGE', '中继邮箱与密码不能为空。')
    }
    const snapshot = await this.tailnet.saveCredentials({ account: value.account.trim(), password: value.password })
    return snapshot ?? null
  }

  private async setDeviceName(payload: unknown): Promise<Record<string, unknown>> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (typeof value.deviceName !== 'string') throw new ControlError('INVALID_MESSAGE', '需要提供本机名称。')
    const deviceName = value.deviceName.trim()
    if (deviceName === '' || deviceName.length > 80) throw new ControlError('INVALID_MESSAGE', '本机名称需为 1 到 80 个字符。')
    await this.persistDeviceName(deviceName)
    if (this.host === undefined) return this.hostOnlyStatus()
    // 中继就绪时把新名称重新注册到服务器；外部服务器或服务停用时只改本机身份。
    const credentials = this.tailnet?.relayReady() === true ? this.credentials() : undefined
    try {
      await this.host.renameHost(deviceName, credentials)
      if (credentials !== undefined) this.tailnet?.reportAuthorized()
    } catch (error) {
      if (credentials !== undefined) this.tailnet?.reportAuthorizeFailure(error)
      throw error
    }
    return this.hostOnlyStatus()
  }

  private async persistDeviceName(deviceName: string): Promise<void> {
    const current = resolveConfig(this.settings === undefined ? this.config : this.settings.get())
    const next = resolveConfig({ ...editableConfig(current), deviceName })
    this.config = next
    if (this.settings !== undefined) await this.settings.replace(editableConfig(next))
  }

  private async persistService(enabled: boolean): Promise<void> {
    const current = resolveConfig(this.settings === undefined ? this.config : this.settings.get())
    const next = resolveConfig({ ...editableConfig(current), service: { enabled } })
    this.config = next
    if (this.settings !== undefined) await this.settings.replace(editableConfig(next))
  }

  private async setDevelopment(payload: unknown): Promise<PluginSettingsView> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const value = record(payload)
    if (value.debugLogging !== undefined && typeof value.debugLogging !== 'boolean') throw new ControlError('INVALID_MESSAGE', 'The debug logging switch must be a boolean.')
    if (value.terminalEnabled !== undefined && typeof value.terminalEnabled !== 'boolean') throw new ControlError('INVALID_MESSAGE', 'The terminal switch must be a boolean.')
    if (value.ports !== undefined && (!Array.isArray(value.ports) || value.ports.some((port) => !Number.isInteger(port)))) throw new ControlError('INVALID_MESSAGE', 'Loopback ports must be integers.')
    if (value.terminalEnabled === undefined && value.ports === undefined && value.debugLogging === undefined) throw new ControlError('INVALID_MESSAGE', 'A development setting is required.')
    const current = resolveConfig(this.settings.get())
    const next = resolveConfig({ ...editableConfig(current),
      logLevel: value.debugLogging === undefined ? current.logLevel : value.debugLogging ? 'debug' : 'info',
      terminal: { enabled: value.terminalEnabled === undefined ? (current.terminal?.enabled ?? true) : value.terminalEnabled },
      loopback: { ports: value.ports === undefined ? (current.loopback?.ports ?? []) : value.ports },
    })
    await this.settings.replace(editableConfig(next))
    this.config = next
    if (value.terminalEnabled !== undefined) this.host?.setTerminalEnabled?.(value.terminalEnabled)
    if (value.ports !== undefined) this.host?.setLoopbackPorts?.(value.ports)
    return this.settingsView()
  }

  private async setAppearance(payload: unknown): Promise<PluginSettingsView> {
    if (this.settings === undefined) throw new ControlError('SETTINGS_UNAVAILABLE', 'DSH user settings are unavailable in this profile.')
    const entry = record(payload).sidebarEntry
    if (entry !== 'standard' && entry !== 'compact') throw new ControlError('INVALID_MESSAGE', 'The sidebar entry style must be Standard or Compact.')
    const next = resolveConfig({ ...editableConfig(resolveConfig(this.settings.get())), sidebar: { entry } })
    await this.settings.replace(editableConfig(next))
    this.config = next
    return this.settingsView()
  }

  private settingsView(): PluginSettingsView {
    const config = this.settings === undefined
      ? editableConfig(this.config)
      : editableConfig(resolveConfig(this.settings.get()))
    return {
      config,
      deviceName: this.currentDeviceName(),
      writable: this.settings !== undefined,
      ...(this.startupFailure === undefined ? {} : { startupError: safeStartupError(this.startupFailure) }),
    }
  }

  /**
   * Attach the local Tailscale orchestration snapshot to a status-shaped
   * result so the settings page can render both from one payload.
   */
  private withTailnet(result: ControlResult<unknown>): ControlResult<unknown> {
    const tailnet = this.tailnet?.snapshot()
    if (tailnet === undefined || !result.ok || !isRecord(result.value)) return result
    return ok({ ...result.value, tailnet })
  }

  private currentDeviceName(): string {
    const config = this.settings === undefined ? this.config : resolveConfig(this.settings.get())
    return this.host?.hostStatus().deviceName ?? config.deviceName
  }

  private hostOnlyStatus(): Record<string, unknown> {
    return {
      deviceName: this.currentDeviceName(),
      serviceAvailable: this.host !== undefined,
      ...(this.host === undefined ? {} : { host: this.host.hostStatus() }),
    }
  }
}

function editableConfig(config: ResolvedConfig): Config {
  return {
    enabled: config.enabled,
    deviceName: config.deviceName,
    ...(config.serverUrl === undefined ? {} : { serverUrl: config.serverUrl }),
    terminal: config.terminal,
    sidebar: config.sidebar,
    service: config.service,
    loopback: config.loopback,
    tailnet: {
      enabled: config.tailnet.enabled,
      mode: config.tailnet.mode,
      ...(config.tailnet.dataDirectory === undefined ? {} : { dataDirectory: config.tailnet.dataDirectory }),
      ...(config.tailnet.authKey === undefined ? {} : { authKey: config.tailnet.authKey }),
    },
    ssh: config.ssh,
    forceRelay: config.forceRelay,
    logLevel: config.logLevel,
    reconnect: config.reconnect.enabled
      ? {
          initialDelayMs: config.reconnect.initialDelayMs,
          maxDelayMs: config.reconnect.maxDelayMs,
          jitter: config.reconnect.jitter,
        }
      : false,
    codex: {
      enabled: config.codex.enabled,
      binary: config.codex.binary,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ControlError('INVALID_MESSAGE', 'The control request payload is invalid.')
  return value
}

function ok(value: unknown): ControlResult<unknown> { return { ok: true, value } }

function fail(error: unknown): ControlResult<unknown> {
  const failure = error instanceof Error ? error : undefined
  const remoteCode = failure !== undefined && 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined
  return {
    ok: false,
    error: {
      code: 'internal',
      message: failure?.message ?? 'The plugin control operation failed.',
      details: remoteCode === undefined ? {} : { remoteCode },
    },
  }
}
