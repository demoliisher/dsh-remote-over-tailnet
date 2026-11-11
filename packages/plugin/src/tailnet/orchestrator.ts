import type { ResolvedConfig } from '../config.js'
import type { SafeLogger } from '../logging.js'
import { join } from 'node:path'
import { loadOrCreateRelayCredentials, saveRelayCredentials, type RelayCredentials } from './credentials.js'
import { detectTailnet, httpsCertificateReady, tailnetHttpsUrl } from './detect.js'
import { ensureServe, ServeError } from './serve.js'
import { RelayError, relayLogPath, startRelay, type RelayHandle } from './relay.js'

/** 面板上展示的单个步骤状态；ok 为 null 表示还没走到这一步。 */
export interface TailnetStep {
  ok: boolean | null
  detail: string
}

export interface TailnetSteps {
  /** 系统 Tailscale 是否可用。 */
  tailscale: TailnetStep
  /** 本地中继 server 是否运行。 */
  relay: TailnetStep
  /** 公共 HTTPS 地址是否已转发到本地中继。 */
  serve: TailnetStep
  /** Host 设备是否已用中继账号完成授权。 */
  authorize: TailnetStep
}

export interface TailnetErrorInfo {
  code: string
  message: string
  actionUrl?: string
}

export type TailnetPhase = 'disabled' | 'probing' | 'starting' | 'ready' | 'error'

/** 面板与状态接口共用的快照；不含密码。 */
export interface TailnetSnapshot {
  enabled: boolean
  phase: TailnetPhase
  dnsName?: string
  publicUrl?: string
  relayPort?: number
  relayPid?: number
  serveTarget?: string
  serveChanged?: boolean
  httpsCertificateReady?: boolean
  tailscaleBinary?: string
  account?: string
  logPath?: string
  steps: TailnetSteps
  error?: TailnetErrorInfo
  updatedAt: string
}

/** 控制层消费的接口。 */
export interface TailnetControl {
  snapshot(): TailnetSnapshot | undefined
  credentials(): RelayCredentials | undefined
  /** 修改中继账号密码并重启中继；成功后由调用方重新授权 Host。 */
  updateCredentials(credentials: RelayCredentials): Promise<TailnetSnapshot | undefined>
  /** 记录 Host 授权结果，供面板展示。 */
  reportAuthorized(): void
  reportAuthorizeFailure(error: unknown): void
}

export interface TailnetOrchestratorOptions {
  /** 当前生效的配置；切换服务器地址时由 {@link TailnetOrchestrator.restart} 替换。 */
  config: ResolvedConfig
  logger: SafeLogger
  /** 未在配置里指定 tailnet.dataDirectory 时使用的中继目录。 */
  defaultDataDirectory: () => string
  /** 插件包根目录，其中含 server/ 产物目录。 */
  packageRoot: string
  /** 本插件版本，用于校验中继产物。 */
  pluginVersion: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 需要插件自己做中继时返回端口，否则返回 undefined。
 *
 * 只有「http + 回环地址」才由插件编排：中继本身只监听 127.0.0.1，对外由 tailscale serve
 * 提供 https；若 serverUrl 是 https 或局域网地址，说明用户在用外部服务器，插件保持上游行为。
 */
export function tailnetRelayPort(serverUrl: string | undefined): number | undefined {
  if (serverUrl === undefined) return undefined
  const url = new URL(serverUrl)
  if (url.protocol !== 'http:') return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  if (url.port === '') return undefined
  return Number(url.port)
}

/** 由 DNSName 与 serve 端口生成对外地址。 */
function publicUrlFor(dnsName: string, servePort: number): string {
  return servePort === 443 ? 'https://' + dnsName : 'https://' + dnsName + ':' + String(servePort)
}

/**
 * 阶段一编排：检测系统 Tailscale → 生成/读取中继账号密码 → 固定端口起中继 →
 * 幂等确保 tailscale serve → 等 Host 设备授权。
 *
 * 失败不抛出：把错误写进快照，面板展示可操作的中文提示，插件其余部分继续运行。
 */
export class TailnetOrchestrator implements TailnetControl {
  private state?: TailnetSnapshot
  private relayCredentials?: RelayCredentials
  private relay?: RelayHandle
  private disposed = false

  constructor(private readonly options: TailnetOrchestratorOptions) {}

  snapshot(): TailnetSnapshot | undefined {
    if (this.state === undefined) return undefined
    return { ...this.state, steps: { ...this.state.steps } }
  }

  credentials(): RelayCredentials | undefined {
    return this.relayCredentials === undefined ? undefined : { ...this.relayCredentials }
  }

  /** 中继已就绪且对外地址可用。 */
  relayReady(): boolean {
    return this.relay !== undefined && this.state?.steps.serve.ok === true
  }

  /** 中继状态、日志、账号密码与 state.json 所在目录。 */
  dataDirectory(): string {
    return this.options.config.tailnet.dataDirectory ?? this.options.defaultDataDirectory()
  }

  /** 切换服务器地址后重建中继；失败同样只写快照，不抛出。 */
  async restart(config: ResolvedConfig): Promise<void> {
    await this.stop()
    this.disposed = false
    this.relay = undefined
    this.relayCredentials = undefined
    this.state = undefined
    this.options.config = config
    await this.start()
  }

  /**
   * 面板修改中继账号密码：先写盘再重启中继。密码变化会让 state.json 里旧令牌全部失效，
   * 调用方必须在成功后立刻用新凭据重新授权 Host。
   */
  async updateCredentials(next: RelayCredentials): Promise<TailnetSnapshot | undefined> {
    const { config, logger } = this.options
    const relayPort = tailnetRelayPort(config.serverUrl)
    const publicUrl = this.state?.publicUrl
    if (this.state === undefined || relayPort === undefined || publicUrl === undefined || this.relayCredentials === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NOT_READY', '本地中继尚未启动，暂时不能修改账号密码。')
    }
    const saved = await saveRelayCredentials(this.dataDirectory(), next)
    const previous = this.relay
    this.relay = undefined
    if (previous !== undefined) await previous.stop()
    this.relayCredentials = saved
    this.state.account = saved.account
    this.state.error = undefined
    this.state.phase = 'starting'
    this.state.steps.relay = { ok: null, detail: '正在用新账号密码重启中继' }
    this.state.steps.authorize = { ok: null, detail: '账号密码已更新，等待 Host 重新授权' }
    this.publish()
    try {
      this.relay = await startRelay({
        serverRoot: join(this.options.packageRoot, 'server'),
        pluginVersion: this.options.pluginVersion,
        dataDirectory: this.dataDirectory(),
        port: relayPort,
        publicUrl,
        account: saved.account,
        password: saved.password,
        logger,
        onExit: info => this.onRelayExit(info),
      })
      this.state.relayPid = this.relay.pid
      this.state.logPath = relayLogPath(this.dataDirectory())
      this.state.steps.relay = { ok: true, detail: '中继运行在 127.0.0.1:' + String(relayPort) + '（进程 ' + String(this.relay.pid) + '）' }
      this.state.phase = 'ready'
      this.publish()
      logger.info('relay credentials updated', { account: saved.account, relayPort })
      return this.snapshot()
    } catch (error) {
      const info = toTailnetError(error)
      this.state.error = info
      this.state.phase = 'error'
      this.state.steps.relay = { ok: false, detail: info.message }
      this.publish()
      throw error
    }
  }

  async start(): Promise<void> {
    const { config, logger } = this.options
    const relayPort = tailnetRelayPort(config.serverUrl)
    this.state = this.initialSnapshot(relayPort)
    if (!config.tailnet.enabled) {
      this.disabled('已在设置中关闭 Tailscale 组网，未启动本地中继。')
      return
    }
    if (config.role === 'client') {
      this.disabled('当前是客户端模式，本地中继只在 Host 模式下启动。')
      return
    }
    if (config.serverUrl === undefined || relayPort === undefined) {
      this.disabled('服务器地址不是 http://127.0.0.1:<端口> 这样的本机地址，按外部服务器处理，未启动内置中继。')
      return
    }
    this.state.phase = 'probing'
    this.publish()
    try {
      this.state.steps.tailscale = { ok: null, detail: '正在检测 Tailscale 状态' }
      this.publish()
      const tailnet = await detectTailnet({ commandTimeoutMs: 15_000 })
      if (tailnet.error !== undefined) {
        this.state.steps.tailscale = { ok: false, detail: tailnet.error.message }
        throw new TailnetOrchestrationError(tailnet.error.code, tailnet.error.message, tailnet.error.actionUrl)
      }
      if (tailnet.dnsName === undefined || tailnet.binary === null) {
        const message = 'Tailscale 已运行，但没有拿到设备域名（DNSName）。请检查 MagicDNS 设置。'
        this.state.steps.tailscale = { ok: false, detail: message }
        throw new TailnetOrchestrationError('TAILNET_NO_DNS_NAME', message, 'https://login.tailscale.com/admin/dns')
      }
      const dnsName = tailnet.dnsName
      const servePort = config.tailnet.servePort
      const publicUrl = publicUrlFor(dnsName, servePort)
      const httpsReady = httpsCertificateReady(tailnet)
      this.state = {
        ...this.state,
        dnsName,
        publicUrl,
        relayPort,
        tailscaleBinary: tailnet.binary,
        httpsCertificateReady: httpsReady,
        steps: {
          ...this.state.steps,
          tailscale: {
            ok: true,
            detail: 'Tailscale 已连接，设备域名 ' + dnsName + (httpsReady ? '' : '（HTTPS 证书尚未启用）'),
          },
        },
      }
      this.publish()

      this.relayCredentials = await loadOrCreateRelayCredentials(this.dataDirectory())
      this.state.account = this.relayCredentials.account
      this.state.steps.relay = { ok: null, detail: '正在启动本地中继' }
      this.state.phase = 'starting'
      this.publish()
      this.relay = await startRelay({
        serverRoot: join(this.options.packageRoot, 'server'),
        pluginVersion: this.options.pluginVersion,
        dataDirectory: this.dataDirectory(),
        port: relayPort,
        publicUrl,
        account: this.relayCredentials.account,
        password: this.relayCredentials.password,
        logger,
        onExit: info => this.onRelayExit(info),
      })
      this.state.relayPid = this.relay.pid
      this.state.logPath = relayLogPath(this.dataDirectory())
      this.state.steps.relay = { ok: true, detail: '中继运行在 127.0.0.1:' + String(relayPort) + '（进程 ' + String(this.relay.pid) + '）' }
      this.publish()

      this.state.steps.serve = { ok: null, detail: '正在配置 tailscale serve' }
      this.publish()
      const target = 'http://127.0.0.1:' + String(relayPort)
      const serve = await ensureServe(tailnet.binary, dnsName, {
        target,
        servePort,
        applyTimeoutMs: 180_000,
      })
      this.state.serveTarget = target
      this.state.serveChanged = serve.changed
      this.state.steps.serve = {
        ok: true,
        detail: serve.changed
          ? '已把 ' + publicUrl + ' 转发到 ' + target
          : publicUrl + ' 已转发到 ' + target,
      }
      this.state.httpsCertificateReady = true
      this.state.steps.authorize = { ok: null, detail: '等待 Host 设备授权' }
      this.state.phase = 'ready'
      this.publish()
      logger.info('tailnet relay ready', { publicUrl, relayPort, servePort })
    } catch (error) {
      const info = toTailnetError(error)
      this.state.error = info
      this.state.phase = 'error'
      this.markFailedStep(info)
      this.publish()
      logger.warn('tailnet orchestration failed', { code: info.code, message: info.message })
    }
  }

  /** Host 已授权（或本就无需授权）。 */
  reportAuthorized(): void {
    if (this.state === undefined) return
    this.state.steps.authorize = { ok: true, detail: '客户端可用面板上的账号密码登录' }
    this.publish()
  }

  reportAuthorizeFailure(error: unknown): void {
    if (this.state === undefined) return
    const info = toTailnetError(error)
    this.state.steps.authorize = { ok: false, detail: info.message }
    this.publish()
  }

  reportAuthorizeSkipped(detail: string): void {
    if (this.state === undefined) return
    this.state.steps.authorize = { ok: null, detail }
    this.publish()
  }

  async stop(): Promise<void> {
    this.disposed = true
    const relay = this.relay
    this.relay = undefined
    if (relay !== undefined) await relay.stop()
  }

  private initialSnapshot(relayPort: number | undefined): TailnetSnapshot {
    return {
      enabled: true,
      phase: 'probing',
      ...(relayPort === undefined ? {} : { relayPort }),
      steps: {
        tailscale: { ok: null, detail: '未检测' },
        relay: { ok: null, detail: '未启动' },
        serve: { ok: null, detail: '未配置' },
        authorize: { ok: null, detail: '未授权' },
      },
      updatedAt: new Date().toISOString(),
    }
  }

  private disabled(detail: string): void {
    if (this.state === undefined) return
    this.state.enabled = false
    this.state.phase = 'disabled'
    this.state.steps = {
      tailscale: { ok: null, detail },
      relay: { ok: null, detail: '未启动' },
      serve: { ok: null, detail: '未配置' },
      authorize: { ok: null, detail: '不需要' },
    }
    this.publish()
  }

  /** 把本次失败记到第一个未完成的步骤上，面板据此定位。 */
  private markFailedStep(info: TailnetErrorInfo): void {
    if (this.state === undefined) return
    const steps = this.state.steps
    const target = steps.tailscale.ok === false ? 'tailscale'
      : steps.relay.ok === false ? 'relay'
        : steps.serve.ok === false ? 'serve' : undefined
    if (target === undefined) {
      steps.relay = { ok: false, detail: info.message }
      return
    }
    steps[target] = { ok: false, detail: info.message }
  }

  private onRelayExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.disposed || this.state === undefined) return
    this.relay = undefined
    const message = '本地中继意外退出（退出码 ' + String(info.code) + '）。请重启 DSH；若反复出现请查看日志：' + (this.state.logPath ?? '')
    this.state.phase = 'error'
    this.state.steps.relay = { ok: false, detail: message }
    this.state.error = { code: 'RELAY_EXITED', message }
    this.publish()
  }

  private publish(): void {
    if (this.state === undefined) return
    this.state.updatedAt = new Date().toISOString()
  }
}

class TailnetOrchestrationError extends Error {
  readonly code: string
  readonly actionUrl?: string

  constructor(code: string, message: string, actionUrl?: string) {
    super(message)
    this.name = 'TailnetOrchestrationError'
    this.code = code
    if (actionUrl !== undefined) this.actionUrl = actionUrl
  }
}

function toTailnetError(error: unknown): TailnetErrorInfo {
  if (error instanceof RelayError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.actionUrl === undefined ? {} : { actionUrl: error.actionUrl }),
    }
  }
  if (error instanceof ServeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.actionUrl === undefined ? {} : { actionUrl: error.actionUrl }),
    }
  }
  if (error instanceof TailnetOrchestrationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.actionUrl === undefined ? {} : { actionUrl: error.actionUrl }),
    }
  }
  return {
    code: 'TAILNET_ORCHESTRATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}