import type { ResolvedConfig } from '../config.js'
import type { SafeLogger } from '../logging.js'
import { join } from 'node:path'
import { loadOrCreateRelayCredentials, saveRelayCredentials, type RelayCredentials } from './credentials.js'
import { connectEmbeddedNode, type TsnetNodeStatus } from './embedded-node.js'
import { EmbeddedBackend, SystemBackend, type TailnetBackend } from './backend.js'
import { detectSystemTailscale, type SystemTailscaleInfo } from './system-cli.js'
import { readExtensionInfo, downloadExtension, removeExtension, type ExtensionInfo } from './extension-downloader.js'
import { RelayError, relayLogPath, startRelay, type RelayHandle } from './relay.js'
import { startPortProxy, type PortProxyHandle } from './port-proxy.js'
import { startSshServer, type SshServerHandle } from './ssh-server.js'
import { SSH_LISTEN_PORT, TAILNET_LISTEN_PORT, SYSTEM_RELAY_PORT, SYSTEM_SSH_PORT } from '../embedded-ports.js'

/** 节点在 tailnet 里的固定名称，对外地址形如 http://dsh-remote.<tailnet>.ts.net。 */
export const TAILNET_NODE_HOSTNAME = 'dsh-remote'

/** 面板上展示的单个步骤状态；ok 为 null 表示还没走到这一步。 */
export interface TailnetStep {
  ok: boolean | null
  detail: string
}

export interface TailnetSteps {
  /** 内嵌节点是否已加入 tailnet。 */
  node: TailnetStep
  /** 本地中继 server 是否运行。 */
  relay: TailnetStep
  /** 节点是否已在 tailnet 端口监听并转发到本地中继。 */
  listen: TailnetStep
  /** Host 设备是否已用中继账号完成授权。 */
  authorize: TailnetStep
}

export interface TailnetErrorInfo {
  code: string
  message: string
  actionUrl?: string
}

export type TailnetPhase = 'disabled' | 'probing' | 'starting' | 'auth-required' | 'ready' | 'error'

/** 面板与状态接口共用的快照；不含密码。 */
export interface TailnetSnapshot {
  enabled: boolean
  /** 当前组网模式：system 用系统客户端，embedded 用按需下载的 wasm 节点。 */
  mode: 'system' | 'embedded'
  phase: TailnetPhase
  dnsName?: string
  /** 节点的 tailnet IPv4 地址；面板可切换按域名或按 IP 呈现。 */
  ipv4?: string
  publicUrl?: string
  /** 对外中继端口：system 模式为 8080，embedded 模式为 80。 */
  publicPort: number
  relayPort?: number
  relayPid?: number
  /** 节点尚未登录时，交给用户点击的 Tailscale 授权链接。 */
  authUrl?: string
  account?: string
  logPath?: string
  /** 当前 DSH Web 端口；面板用它显示客户端要填的端口。 */
  webPort?: number
  /** 系统 Tailscale 客户端的安装与登录状态。 */
  system?: SystemTailscaleInfo
  /** wasm 扩展组件的下载状态。 */
  extension: ExtensionInfo
  steps: TailnetSteps
  /** SSH 模式：tailnet 上的监听端口、主机密钥指纹、转发目标端口与已固定端口；未启用时不存在。 */
  ssh?: { port: number; fingerprint: string; webPort: number; pinnedPort?: number }
  error?: TailnetErrorInfo
  updatedAt: string
}

/** 控制层消费的接口。 */
export interface TailnetControl {
  snapshot(): TailnetSnapshot | undefined
  credentials(): RelayCredentials | undefined
  /** 中继服务停止时保存中继账号密码，供下次启动使用。 */
  saveCredentials(credentials: RelayCredentials): Promise<TailnetSnapshot | undefined>
  /** SSH 模式的登录信息；未启用或尚未就绪时为空。 */
  sshCredentials(): { username: string; password: string; port: number; token?: string } | undefined
  /** 运行中开关 SSH 服务，不重启节点；失败抛出由控制层回报。 */
  applySsh(ssh: ResolvedConfig['ssh']): Promise<TailnetSnapshot | undefined>
  /** 固定当前 DSH 端口，或取消固定；运行中改固定端口会顺带启停本机代理。 */
  applyPin(pinned: boolean): Promise<TailnetSnapshot | undefined>
  /** 运行中修改「中继服务」开关：只起停中继，节点留给 SSH 模式继续用。 */
  applyService(enabled: boolean): Promise<TailnetSnapshot | undefined>
  /** 切换组网模式：system 用系统客户端，embedded 用 wasm 节点。 */
  applyMode(mode: 'system' | 'embedded'): Promise<TailnetSnapshot | undefined>
  /** 重新探测系统 Tailscale 客户端状态，供面板在未登录时刷新。 */
  refreshSystem(): Promise<TailnetSnapshot | undefined>
  /** 下载 wasm 扩展组件；内嵌模式前置步骤。 */
  downloadExtension(): Promise<TailnetSnapshot | undefined>
  /** 删除已下载的 wasm 扩展组件。 */
  removeExtension(): Promise<TailnetSnapshot | undefined>
  /** 启动节点与本地中继；失败写入快照，不抛出。 */
  start(): Promise<void>
  /** 停止中继并关闭节点，快照转为已停止。 */
  stop(): Promise<void>
  /** 中继与对外监听都已就绪。 */
  relayReady(): boolean
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
  /** 插件包根目录，其中含 server/ 与 tsnet/ 产物目录。 */
  packageRoot: string
  /** 本插件版本，用于校验中继产物。 */
  pluginVersion: string
  /** 当前 DSH Web 端口；SSH 只允许把隧道通到这个端口。 */
  webPort: () => number | undefined
  /** 当前 DSH Web 登录令牌，DSH Go 的「只连接」要填它；取不到时面板留空。 */
  webToken?: () => string | undefined
  /** 节点就绪、可以授权 Host 时回调；授权结果由回调自己写回快照。 */
  onReady?: () => void | Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 需要插件自己做中继时返回端口，否则返回 undefined。
 *
 * 只有「http + 回环地址」才由插件编排：中继本身只监听 127.0.0.1，对外由内嵌节点
 * 在 tailnet 上监听同一端口；若 serverUrl 是 https 或局域网地址，说明用户在用外部服务器，
 * 插件保持上游行为。
 */
export function tailnetRelayPort(serverUrl: string | undefined): number | undefined {
  if (serverUrl === undefined) return undefined
  const url = new URL(serverUrl)
  if (url.protocol !== 'http:') return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  if (url.port === '') return undefined
  return Number(url.port)
}

/** 去掉 DNSName 末尾的点，生成对外地址；节点监听 80 端口，地址里不写端口。 */
export function publicUrlFor(dnsName: string): string {
  return 'http://' + dnsName.replace(/\.$/, '')
}

/**
 * 编排内嵌节点与本地中继：启动 wasm 节点 → 等待加入 tailnet（必要时给出授权链接）→
 * 在回环端口起中继 → 节点在 tailnet 的 80 端口监听并转发到中继 → 等 Host 设备授权。
 *
 * 失败不抛出：把错误写进快照，面板展示可操作的中文提示，插件其余部分继续运行。
 */
export class TailnetOrchestrator implements TailnetControl {
  private state?: TailnetSnapshot
  private relayCredentials?: RelayCredentials
  private relay?: RelayHandle
  private backend?: TailnetBackend
  private wasmPath?: string
  private cachedExtension?: ExtensionInfo
  private listeningPort?: number
  private ssh?: SshServerHandle
  private sshPort?: number
  private proxy?: PortProxyHandle
  private advanceTimer?: NodeJS.Timeout
  private disposed = false

  constructor(private readonly options: TailnetOrchestratorOptions) {
    // 启动时确认扩展状态；面板首次渲染前就能显示「已下载／未下载」。
    void readExtensionInfo(this.dataDirectory()).then(info => {
      this.cachedExtension = info
      if (this.state !== undefined) {
        this.state.extension = info
        this.publish()
      }
    }).catch(() => undefined)
  }

  snapshot(): TailnetSnapshot | undefined {
    if (this.state === undefined) return undefined
    return { ...this.state, steps: { ...this.state.steps } }
  }

  credentials(): RelayCredentials | undefined {
    return this.relayCredentials === undefined ? undefined : { ...this.relayCredentials }
  }

  sshCredentials(): { username: string; password: string; port: number; token?: string } | undefined {
    const ssh = this.ssh
    const port = this.state?.ssh?.port
    const credentials = this.relayCredentials
    if (ssh === undefined || port === undefined || credentials === undefined) return undefined
    return { username: credentials.account, password: credentials.password, port, token: this.options.webToken?.() }
  }

  /**
   * 面板开关 SSH 服务时就地生效。
   *
   * 节点与中继不动，只关掉或打开 SSH 监听。
   * 主机密钥与账号密码都与 DSH Remote 共用，客户端已信任的指纹不会失效。
   */
  async applySsh(ssh: ResolvedConfig['ssh']): Promise<TailnetSnapshot | undefined> {
    const current = this.options.config.ssh
    if (current.enabled === ssh.enabled) return this.snapshot()
    this.options.config = { ...this.options.config, ssh }
    if (!ssh.enabled) {
      await this.stopSsh()
      if (this.wantsRelay()) {
        if (this.state !== undefined) {
          this.state.phase = 'ready'
          this.publish()
        }
        return this.snapshot()
      }
      await this.stop()
      this.markStopped('内嵌节点已关闭。')
      return this.snapshot()
    }
    // 只开 SSH 时节点本来没跑：把节点拉起来；中继这一半看「中继服务」开关。
    if (this.backend === undefined) {
      await this.start()
      return this.snapshot()
    }
    if (this.state?.phase === 'ready') await this.startSsh()
    return this.snapshot()
  }

  /**
   * 面板上固定当前 DSH 端口。
   *
   * 固定之后客户端只认这个端口；实例下次换了端口，由本机回环上的反向代理接住旧端口
   * 再转给新端口。端口没变时不需要代理，固定端口上就是 DSH 自己。取消固定则撤掉代理。
   */
  async applyPin(pinned: boolean): Promise<TailnetSnapshot | undefined> {
    const webPort = this.options.webPort()
    if (pinned && webPort === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NO_WEB_PORT', '取不到当前 DSH Web 端口，无法固定端口。')
    }
    const current = this.options.config
    const target = pinned ? webPort : undefined
    if (current.ssh.pinnedPort === target) return this.snapshot()
    this.options.config = {
      ...current,
      ssh: target === undefined ? { enabled: current.ssh.enabled } : { enabled: current.ssh.enabled, pinnedPort: target },
    }
    if (this.state !== undefined && this.state.phase === 'ready' && this.wantsSsh()) await this.startSsh()
    return this.snapshot()
  }

  /** 中继已就绪且节点已在 tailnet 端口监听。 */
  relayReady(): boolean {
    return this.relay !== undefined && this.state?.steps.listen.ok === true
  }

  /** 中继状态、日志、账号密码与 state.json 所在目录。 */
  dataDirectory(): string {
    return this.options.config.tailnet.dataDirectory ?? this.options.defaultDataDirectory()
  }

  /** 内嵌节点的状态目录，Tailscale 的密钥与数据库落在这里。 */
  nodeDirectory(): string {
    return join(this.dataDirectory(), 'node')
  }

  /** 切换服务器地址后重建中继与节点；失败同样只写快照，不抛出。 */
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
   * 保存 DSH Remote 与 SSH 共用的账号密码。
   *
   * 账号密码由中继与 SSH 共用，任一服务运行中都拒绝改动：中继把旧凭据带进下次启动，
   * SSH 每次认证都读现值，运行期改动会让两条通道的凭据不一致。
   */
  async saveCredentials(next: RelayCredentials): Promise<TailnetSnapshot | undefined> {
    const { config, logger } = this.options
    if (!config.tailnet.enabled || tailnetRelayPort(config.serverUrl) === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NOT_APPLICABLE', '当前服务器地址不使用内置中继，没有可保存的中继账号密码。')
    }
    // 账号密码由中继与 SSH 共用，任一服务在运行时都锁住，避免改到一半两条通道用上不同凭据。
    if (this.relay !== undefined || this.ssh !== undefined) {
      throw new TailnetOrchestrationError('TAILNET_RUNNING', '请先停止中继服务与 SSH 服务，再修改账号密码。')
    }
    const saved = await saveRelayCredentials(this.dataDirectory(), next)
    this.relayCredentials = saved
    if (this.state !== undefined) {
      this.state.account = saved.account
      this.state.error = undefined
      this.publish()
    }
    logger.info('relay credentials saved for next start', { account: saved.account })
    return this.snapshot()
  }

  async start(): Promise<void> {
    const { config, logger } = this.options
    this.disposed = false
    const relayPort = tailnetRelayPort(config.serverUrl)
    if (this.state === undefined) this.state = this.initialSnapshot(relayPort)
    this.state.mode = config.tailnet.mode
    this.state.publicPort = this.publicRelayPort()
    if (!config.tailnet.enabled) {
      this.disabled('已在设置中关闭 Tailscale 组网，未启动本地中继。')
      return
    }
    this.state.enabled = true
    if (config.serverUrl === undefined || relayPort === undefined) {
      this.disabled('服务器地址不是 http://127.0.0.1:<端口> 这样的本机地址，按外部服务器处理，未启动内置中继。')
      return
    }
    // 节点是两套服务共用的底座：只切中继开关时不重建节点，直接补齐中继这一半。
    if (this.backend !== undefined) {
      await this.completeSetup(relayPort)
      return
    }
    // 重建节点意味着换了一次入网：先清掉上次的域名与对外地址。否则系统模式切到内嵌模式、
    // 新节点又没就绪时，面板会一直显示旧模式的域名和端口（例如 wsl.*.ts.net:8080）。
    this.clearStaleAddress()
    this.state.phase = 'probing'
    this.state.steps.node = { ok: null, detail: config.tailnet.mode === 'system' ? '正在检测系统 Tailscale 客户端' : '正在启动内嵌节点' }
    this.publish()
    try {
      this.relayCredentials = await loadOrCreateRelayCredentials(this.dataDirectory())
      this.state.account = this.relayCredentials.account
      const backend = await this.createBackend()
      this.backend = backend
      if (config.tailnet.mode === 'system') this.state.system = (backend as SystemBackend).currentInfo()
      const status = await backend.start({
        dir: this.nodeDirectory(),
        hostname: TAILNET_NODE_HOSTNAME,
        ...(config.tailnet.authKey === undefined ? {} : { authKey: config.tailnet.authKey }),
      })
      const phase = this.applyStatus(status, relayPort)
      if (phase === 'auth-required') {
        this.scheduleAdvance(relayPort)
        logger.info('tailnet node needs authorization', { authUrl: this.state.authUrl ?? '', mode: config.tailnet.mode })
        return
      }
      await this.completeSetup(relayPort)
    } catch (error) {
      this.fail(error)
    }
  }

  /** 按当前模式创建节点后端；内嵌模式先确认 wasm 扩展已下载。 */
  private async createBackend(): Promise<TailnetBackend> {
    const { config, logger } = this.options
    if (config.tailnet.mode === 'system') {
      return new SystemBackend(logger)
    }
    const extension = await readExtensionInfo(this.dataDirectory())
    this.state!.extension = extension
    if (extension.state !== 'installed' || extension.path === undefined) {
      throw new TailnetOrchestrationError(
        'EMBEDDED_EXTENSION_MISSING',
        '尚未下载内嵌节点组件，请先在面板中下载后再切换到内嵌模式。',
      )
    }
    this.wasmPath = extension.path
    return new EmbeddedBackend(await connectEmbeddedNode(this.options.packageRoot, extension.path))
  }

  /** 对外中继端口：system 模式 8080，embedded 模式 80。 */
  private publicRelayPort(): number {
    return this.options.config.tailnet.mode === 'system' ? SYSTEM_RELAY_PORT : TAILNET_LISTEN_PORT
  }

  /** 对外 SSH 端口：system 模式 2222，embedded 模式 22。 */
  private publicSshPort(): number {
    return this.options.config.tailnet.mode === 'system' ? SYSTEM_SSH_PORT : SSH_LISTEN_PORT
  }

  /** 对外中继地址：system 模式带 8080 端口，embedded 模式走 80 不带端口。 */
  private publicUrl(dnsName: string): string {
    const base = publicUrlFor(dnsName)
    return this.options.config.tailnet.mode === 'system' ? base + ':' + String(SYSTEM_RELAY_PORT) : base
  }

  /** 切换组网模式：停止当前后端后按新模式重启。 */
  async applyMode(mode: 'system' | 'embedded'): Promise<TailnetSnapshot | undefined> {
    const current = this.options.config
    if (current.tailnet.mode === mode) return this.snapshot()
    if (mode === 'embedded') {
      const extension = await readExtensionInfo(this.dataDirectory())
      this.state && (this.state.extension = extension)
      if (extension.state !== 'installed') {
        throw new TailnetOrchestrationError('EMBEDDED_EXTENSION_MISSING', '尚未下载内嵌节点组件，请先下载后再切换。')
      }
    }
    await this.stop()
    this.options.config = { ...current, tailnet: { ...current.tailnet, mode } }
    await this.start()
    return this.snapshot()
  }

  /** 重新探测系统客户端状态；未登录时登录成功后点它可推进到就绪。 */
  async refreshSystem(): Promise<TailnetSnapshot | undefined> {
    if (this.state === undefined) return undefined
    this.state.system = await detectSystemTailscale()
    this.publish()
    return this.snapshot()
  }

  /** 下载 wasm 扩展组件，过程中把进度写进快照。 */
  async downloadExtension(): Promise<TailnetSnapshot | undefined> {
    if (this.state === undefined) return undefined
    if (this.backend !== undefined) {
      throw new TailnetOrchestrationError('TAILNET_RUNNING', '请先停止组网服务再下载组件。')
    }
    this.state.extension = { state: 'downloading', progress: 0 }
    this.publish()
    try {
      this.state.extension = await downloadExtension(this.dataDirectory(), progress => {
        if (this.state === undefined) return
        this.state.extension = { state: 'downloading', progress }
        this.publish()
      })
    } catch (error) {
      this.state.extension = { state: 'error', error: error instanceof Error ? error.message : String(error) }
      this.publish()
      throw error
    }
    return this.snapshot()
  }

  /** 删除 wasm 扩展组件。 */
  async removeExtension(): Promise<TailnetSnapshot | undefined> {
    if (this.state === undefined) return undefined
    if (this.backend !== undefined) {
      throw new TailnetOrchestrationError('TAILNET_RUNNING', '请先停止组网服务再删除组件。')
    }
    await removeExtension(this.dataDirectory())
    this.state.extension = { state: 'absent' }
    this.publish()
    return this.snapshot()
  }

  /** 节点在等用户点授权链接时继续轮询，授权完成后自动推进到就绪。 */
  private scheduleAdvance(relayPort: number): void {
    if (this.advanceTimer !== undefined) clearInterval(this.advanceTimer)
    this.advanceTimer = setInterval(() => this.advance(relayPort), 1000)
  }

  private advance(relayPort: number): void {
    const backend = this.backend
    if (this.disposed || backend === undefined) {
      this.clearAdvance()
      return
    }
    void backend.status().then(status => {
      if (this.options.config.tailnet.mode === 'system') {
        const info = (backend as SystemBackend).currentInfo()
        if (this.state !== undefined && info !== undefined) this.state.system = info
      }
      this.applyStatus(status, relayPort)
      if (this.state?.phase === 'starting' && this.state.steps.node.ok === true) {
        this.clearAdvance()
        void this.completeSetup(relayPort)
      }
    }).catch(error => {
      this.clearAdvance()
      this.fail(error)
    })
  }

  private clearAdvance(): void {
    if (this.advanceTimer === undefined) return
    clearInterval(this.advanceTimer)
    this.advanceTimer = undefined
  }

  /** 把节点状态映射到面板阶段：等授权、已加入或仍在启动，返回映射后的阶段。 */
  private applyStatus(status: TsnetNodeStatus, relayPort: number): TailnetPhase {
    if (this.state === undefined) return 'disabled'
    const backend = status.backendState ?? 'NoState'
    // 系统客户端未安装、未运行等异常由后端写成 error 字段，转成可操作的面板错误。
    if (status.error !== undefined && status.error !== '') {
      throw new TailnetOrchestrationError('SYSTEM_TAILSCALE_UNAVAILABLE', status.error,
        this.options.config.tailnet.mode === 'system' ? 'https://tailscale.com/download' : undefined)
    }
    const needsAuth = (status.authURL !== undefined && status.authURL !== '')
      || (this.options.config.tailnet.mode === 'system' && backend === 'NeedsLogin')
    if (backend !== 'Running' && needsAuth) {
      this.state.phase = 'auth-required'
      this.state.authUrl = status.authURL
      this.state.steps.node = { ok: null, detail: this.options.config.tailnet.mode === 'system'
        ? '请在系统 Tailscale 客户端完成登录，完成后会自动继续'
        : '等待在浏览器里完成 Tailscale 授权' }
      this.publish()
      return this.state.phase
    }
    if (backend === 'Running' && status.dnsName !== undefined) {
      const dnsName = status.dnsName.replace(/\.$/, '')
      this.state.phase = 'starting'
      this.state.authUrl = undefined
      this.state.dnsName = dnsName
      this.state.ipv4 = status.tailscaleIPs?.find((address: string) => !address.includes(':'))
      this.state.publicUrl = this.publicUrl(dnsName)
      this.state.steps.node = { ok: true, detail: '节点已加入 tailnet：' + dnsName }
      this.publish()
      return this.state.phase
    }
    this.state.steps.node = { ok: null, detail: '节点状态：' + backend }
    this.publish()
    return this.state.phase
  }

  /** 节点入网后按需补齐中继与 SSH 两套服务，中继这一套最后回调上层完成 Host 授权。 */
  private async completeSetup(relayPort: number): Promise<void> {
    const { logger } = this.options
    if (this.state === undefined) return
    try {
      if (this.wantsRelay()) await this.startRelay(relayPort)
      else this.clearRelaySteps('中继服务已关闭')
      await this.startSsh()
      if (this.wantsRelay()) {
        this.state.steps.authorize = { ok: null, detail: '等待 Host 设备授权' }
      }
      this.state.phase = 'ready'
      this.state.error = undefined
      this.publish()
      if (!this.wantsRelay()) {
        logger.info('tailnet node ready for ssh only', { dnsName: this.state.dnsName ?? '' })
        return
      }
      logger.info('tailnet node ready', { publicUrl: this.state.publicUrl ?? '', relayPort })
      await this.options.onReady?.()
    } catch (error) {
      this.fail(error)
    }
  }

  /** 起本地中继，并在 tailnet 的 80 端口监听转发；只在「中继服务」开着时执行。 */
  private async startRelay(relayPort: number): Promise<void> {
    const { logger } = this.options
    if (this.state === undefined) return
    const credentials = this.relayCredentials
    if (credentials === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NO_CREDENTIALS', '尚未生成中继账号密码，无法启动本地中继。')
    }
    const publicUrl = this.state.publicUrl
    if (publicUrl === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NO_DNS_NAME', '内嵌节点已运行，但没有拿到设备域名。请检查 MagicDNS 设置。', 'https://login.tailscale.com/admin/dns')
    }
    if (this.relay === undefined) {
      this.state.steps.relay = { ok: null, detail: '正在启动本地中继' }
      this.publish()
      this.relay = await startRelay({
        serverRoot: join(this.options.packageRoot, 'server'),
        pluginVersion: this.options.pluginVersion,
        dataDirectory: this.dataDirectory(),
        port: relayPort,
        publicUrl,
        account: credentials.account,
        password: credentials.password,
        logger,
        onExit: info => this.onRelayExit(info),
      })
      this.state.relayPid = this.relay.pid
      this.state.logPath = relayLogPath(this.dataDirectory())
      this.state.steps.relay = { ok: true, detail: '中继运行在 127.0.0.1:' + String(relayPort) }
      this.publish()
    }
    const backend = this.backend
    if (backend === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NODE_STOPPED', '节点已停止，无法监听 tailnet 端口。')
    }
    const listenPort = this.publicRelayPort()
    if (this.listeningPort !== relayPort) {
      this.state.steps.listen = { ok: null, detail: '正在 tailnet 端口 ' + String(listenPort) + ' 监听' }
      this.publish()
      await backend.listen(listenPort, relayPort)
      this.listeningPort = relayPort
    }
    await this.waitForRelay()
    this.state.steps.listen = {
      ok: true,
      detail: '已在 tailnet 端口 ' + String(listenPort) + ' 监听并转发到 127.0.0.1:' + String(relayPort) + '（' + publicUrl + '）',
    }
  }

  /**
   * 只关掉中继这一套：停中继进程并关掉节点上的 80 端口监听，节点与 SSH 保持运行。
   *
   * 「中继服务」和「SSH 服务」是两个独立模块，关掉一个不影响另一个用同一个节点。
   */
  private async stopRelay(): Promise<void> {
    const relay = this.relay
    this.relay = undefined
    this.listeningPort = undefined
    if (this.state !== undefined) {
      this.state.relayPid = undefined
      this.state.steps.relay = { ok: null, detail: '未运行' }
      this.state.steps.listen = { ok: null, detail: '未监听' }
      this.state.steps.authorize = { ok: null, detail: '不需要' }
      this.publish()
    }
    if (this.backend !== undefined) await this.backend.closeListener()
    if (relay !== undefined) await relay.stop()
  }

  /** 中继关掉时把相关步骤写成未运行，面板不显示残留的旧地址与旧进度。 */
  private clearRelaySteps(detail: string): void {
    if (this.state === undefined) return
    this.state.relayPid = undefined
    this.state.steps.relay = { ok: null, detail }
    this.state.steps.listen = { ok: null, detail: '未监听' }
    this.state.steps.authorize = { ok: null, detail: '不需要' }
    this.publish()
  }

  /** 中继服务（中继）是否应该在运行。 */
  private wantsRelay(): boolean {
    return this.options.config.service.enabled !== false
  }

  /** SSH 服务是否应该在运行。 */
  private wantsSsh(): boolean {
    return this.options.config.ssh.enabled
  }

  /** 节点由自己的开关决定；中继与 SSH 都依赖节点，节点关时两者都无法运行。 */
  private wantsNode(): boolean {
    return this.options.config.tailnet.enabled
  }

  /**
   * 面板改「中继服务」开关时就地生效。
   *
   * 打开时补齐节点与中继；关闭时只停中继，SSH 还开着就保留节点，两边都关才整体停止。
   */
  async applyService(enabled: boolean): Promise<TailnetSnapshot | undefined> {
    if (this.options.config.service.enabled !== enabled) {
      this.options.config = { ...this.options.config, service: { enabled } }
    }
    if (enabled) {
      await this.start()
      return this.snapshot()
    }
    await this.stopRelay()
    if (this.wantsSsh()) {
      if (this.state !== undefined) {
        this.state.phase = 'ready'
        this.state.error = undefined
        this.publish()
      }
      return this.snapshot()
    }
    await this.stop()
    this.markStopped('内嵌节点已关闭。')
    return this.snapshot()
  }

  /**
   * 起 SSH 服务，并在 tailnet 上监听固定端口。
   *
   * 端口上的每条连接都交给 ssh2 处理，认证通过后只允许 direct-tcpip 到当前 DSH Web 端口，
   * 因此这条通道能做的只有「替客户端打通到本机这个实例」。
   */
  private async startSsh(): Promise<void> {
    const { config, logger } = this.options
    if (this.state === undefined) return
    if (!config.ssh.enabled) return
    const webPort = this.options.webPort()
    if (webPort === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NO_WEB_PORT', '取不到当前 DSH Web 端口，SSH 模式无法确定转发目标。')
    }
    const backend = this.backend
    if (backend === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NODE_STOPPED', '节点已停止，无法监听 SSH 端口。')
    }
    await this.syncProxy(webPort)
    this.ssh ??= await startSshServer({
      directory: join(this.dataDirectory(), 'ssh'),
      account: () => this.relayCredentials?.account ?? '',
      password: () => this.relayCredentials?.password ?? '',
      targetPort: () => this.sshTargetPort(),
      logger,
    })
    const handle = this.ssh
    const sshPort = this.publicSshPort()
    if (this.sshPort !== sshPort) {
      await backend.listenStream(sshPort, socket => handle.handleConnection(socket))
      this.sshPort = sshPort
    }
    const pinnedPort = config.ssh.pinnedPort
    this.state.ssh = {
      port: sshPort,
      fingerprint: handle.fingerprint,
      webPort,
      ...(pinnedPort === undefined ? {} : { pinnedPort }),
    }
    this.publish()
  }

  /**
   * SSH 隧道要拨的端口：固定之后是固定端口（由本机代理转给当前实例），否则是当前实例。
   */
  private sshTargetPort(): number | undefined {
    return this.options.config.ssh.pinnedPort ?? this.options.webPort()
  }

  /**
   * 让本机代理与固定端口保持一致。
   *
   * 固定端口与当前实例端口不同时才需要代理：旧端口由插件接住，转给新端口。两者相同时
   * 固定端口上就是 DSH 自己，代理必须撤掉，否则会抢端口。
   */
  private async syncProxy(webPort: number): Promise<void> {
    const pinned = this.options.config.ssh.pinnedPort
    if (!this.wantsSsh() || pinned === undefined || pinned === webPort) {
      await this.closeProxy()
      return
    }
    if (this.proxy?.port === pinned) return
    await this.closeProxy()
    try {
      this.proxy = await startPortProxy({
        listenPort: pinned,
        targetPort: () => this.options.webPort(),
        logger: this.options.logger,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new TailnetOrchestrationError('TAILNET_PIN_PORT_UNAVAILABLE', '固定端口 ' + String(pinned) + ' 无法监听：' + reason)
    }
  }

  private async closeProxy(): Promise<void> {
    const proxy = this.proxy
    this.proxy = undefined
    if (proxy !== undefined) await proxy.close()
  }

  /** 只关掉 tailnet 上的 SSH 监听，SSH 服务与凭据保留。 */
  private async closeSshStream(): Promise<void> {
    const backend = this.backend
    this.sshPort = undefined
    if (this.state !== undefined) this.state.ssh = undefined
    this.publish()
    if (backend !== undefined) await backend.closeStream()
  }

  /** 关闭监听与 SSH 服务；面板关掉 SSH 模式时调用。 */
  private async stopSsh(): Promise<void> {
    const ssh = this.ssh
    this.ssh = undefined
    if (this.state !== undefined) this.state.ssh = undefined
    this.publish()
    await this.closeSshStream()
    if (ssh !== undefined) await ssh.close()
    await this.closeProxy()
  }

  /** 经节点访问本机中继健康检查，确认入站链路已经通到本机中继。 */
  private async waitForRelay(): Promise<void> {
    const relayPort = tailnetRelayPort(this.options.config.serverUrl)
    const url = 'http://127.0.0.1:' + String(relayPort) + '/health'
    const deadline = Date.now() + 15_000
    let lastError = ''
    while (Date.now() < deadline) {
      const backend = this.backend
      if (backend === undefined) throw new TailnetOrchestrationError('TAILNET_NODE_STOPPED', '节点已停止，无法确认通知地址。')
      try {
        const response = await backend.probe(url)
        if (response.status === 200) return
        lastError = 'HTTP ' + String(response.status)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 500))
    }
    throw new TailnetOrchestrationError(
      'TAILNET_LISTEN_UNREACHABLE',
      '节点已在 tailnet 端口监听，但访问本机中继失败：' + lastError,
    )
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

  async stop(): Promise<void> {
    this.disposed = true
    this.clearAdvance()
    const relay = this.relay
    this.relay = undefined
    if (relay !== undefined) await relay.stop()
    const ssh = this.ssh
    this.ssh = undefined
    this.sshPort = undefined
    if (ssh !== undefined) await ssh.close()
    await this.closeProxy()
    const backend = this.backend
    this.backend = undefined
    this.wasmPath = undefined
    this.listeningPort = undefined
    if (backend !== undefined) await backend.close()
    this.markStopped('节点已关闭。')
  }

  /** 停止后保留域名与地址，面板显示已停止而不是错误。 */
  private markStopped(detail: string): void {
    const base = this.state ?? this.initialSnapshot(tailnetRelayPort(this.options.config.serverUrl))
    this.state = {
      ...base,
      enabled: false,
      phase: 'disabled',
      relayPid: undefined,
      authUrl: undefined,
      ssh: undefined,
      error: undefined,
      steps: {
        node: { ok: null, detail: '未运行' },
        relay: { ok: null, detail: '未运行' },
        listen: { ok: null, detail: '未监听' },
        authorize: { ok: null, detail },
      },
      updatedAt: new Date().toISOString(),
    }
    this.publish()
  }

  private initialSnapshot(relayPort: number | undefined): TailnetSnapshot {
    const webPort = this.options.webPort()
    const mode = this.options.config.tailnet.mode
    return {
      enabled: true,
      mode,
      phase: 'probing',
      publicPort: mode === 'system' ? SYSTEM_RELAY_PORT : TAILNET_LISTEN_PORT,
      extension: this.cachedExtension ?? { state: 'absent' },
      ...(relayPort === undefined ? {} : { relayPort }),
      ...(webPort === undefined ? {} : { webPort }),
      steps: {
        node: { ok: null, detail: '未启动' },
        relay: { ok: null, detail: '未启动' },
        listen: { ok: null, detail: '未监听' },
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
      node: { ok: null, detail },
      relay: { ok: null, detail: '未启动' },
      listen: { ok: null, detail: '未监听' },
      authorize: { ok: null, detail: '不需要' },
    }
    this.publish()
  }

  /** 把本次失败记到第一个未完成的步骤上，面板据此定位。 */
  private markFailedStep(info: TailnetErrorInfo): void {
    if (this.state === undefined) return
    const steps = this.state.steps
    const target = steps.node.ok !== true ? 'node'
      : steps.relay.ok !== true ? 'relay'
        : 'listen'
    steps[target] = { ok: false, detail: info.message }
  }

  /** 重建节点时清掉上一次的地址，避免切换模式或重启后残留旧域名与旧端口。 */
  private clearStaleAddress(): void {
    if (this.state === undefined) return
    this.state.dnsName = undefined
    this.state.ipv4 = undefined
    this.state.publicUrl = undefined
  }

  /** 内嵌节点启动阶段的超时来自 wasm，补一句可操作的排查方向再展示。 */
  private explainError(error: unknown): TailnetErrorInfo {
    const info = toTailnetError(error)
    if (this.options.config.tailnet.mode !== 'embedded') return info
    if (!info.message.includes('启动超时') && !info.message.includes('仍未加入 tailnet')) return info
    return {
      code: 'EMBEDDED_NODE_START_TIMEOUT',
      message: '内嵌节点未能加入 tailnet：' + info.message
        + '。请确认本机能访问 controlplane.tailscale.com、DNS 解析正常后重试。',
      ...(info.actionUrl === undefined ? {} : { actionUrl: info.actionUrl }),
    }
  }

  private fail(error: unknown): void {
    if (this.state === undefined) return
    const info = this.explainError(error)
    this.clearAdvance()
    this.state.error = info
    this.state.phase = 'error'
    this.markFailedStep(info)
    this.publish()
    this.options.logger.warn('tailnet orchestration failed', { code: info.code, message: info.message })
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
    const webPort = this.options.webPort()
    if (webPort !== undefined) this.state.webPort = webPort
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
