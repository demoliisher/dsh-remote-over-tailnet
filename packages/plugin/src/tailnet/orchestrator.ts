import type { ResolvedConfig } from '../config.js'
import type { SafeLogger } from '../logging.js'
import { join } from 'node:path'
import { loadOrCreateRelayCredentials, saveRelayCredentials, type RelayCredentials } from './credentials.js'
import type { TsnetNode, TsnetNodeStatus } from './embedded-node.js'
import { connectEmbeddedNode } from './embedded-node.js'
import { RelayError, relayLogPath, startRelay, type RelayHandle } from './relay.js'

/** 节点在 tailnet 里的固定名称，对外地址形如 http://dsh-remote.<tailnet>.ts.net:<端口>。 */
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
  phase: TailnetPhase
  dnsName?: string
  publicUrl?: string
  relayPort?: number
  relayPid?: number
  /** 节点尚未登录时，交给用户点击的 Tailscale 授权链接。 */
  authUrl?: string
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
  /** 远程服务停止时保存中继账号密码，供下次启动使用。 */
  saveCredentials(credentials: RelayCredentials): Promise<TailnetSnapshot | undefined>
  /** 启动内嵌节点与本地中继；失败写入快照，不抛出。 */
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

/** 去掉 DNSName 末尾的点，生成对外地址。 */
function publicUrlFor(dnsName: string, relayPort: number): string {
  return 'http://' + dnsName.replace(/\.$/, '') + ':' + String(relayPort)
}

/**
 * 编排内嵌节点与本地中继：启动 wasm 节点 → 等待加入 tailnet（必要时给出授权链接）→
 * 固定端口起中继 → 在 tailnet 同端口监听并转发到中继 → 等 Host 设备授权。
 *
 * 失败不抛出：把错误写进快照，面板展示可操作的中文提示，插件其余部分继续运行。
 */
export class TailnetOrchestrator implements TailnetControl {
  private state?: TailnetSnapshot
  private relayCredentials?: RelayCredentials
  private relay?: RelayHandle
  private node?: TsnetNode
  private listeningPort?: number
  private advanceTimer?: NodeJS.Timeout
  private disposed = false

  constructor(private readonly options: TailnetOrchestratorOptions) {}

  snapshot(): TailnetSnapshot | undefined {
    if (this.state === undefined) return undefined
    return { ...this.state, steps: { ...this.state.steps } }
  }

  credentials(): RelayCredentials | undefined {
    return this.relayCredentials === undefined ? undefined : { ...this.relayCredentials }
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
   * 远程服务停止时保存中继账号密码，供下次启动使用。
   *
   * 此时中继没有运行，无法立即验证新凭据；下次 start() 启动中继时由 relay 的登录检查完成验证。
   */
  async saveCredentials(next: RelayCredentials): Promise<TailnetSnapshot | undefined> {
    const { config, logger } = this.options
    if (!config.tailnet.enabled || tailnetRelayPort(config.serverUrl) === undefined) {
      throw new TailnetOrchestrationError('TAILNET_NOT_APPLICABLE', '当前服务器地址不使用内置中继，没有可保存的中继账号密码。')
    }
    if (this.relay !== undefined || this.state?.enabled === true) {
      throw new TailnetOrchestrationError('TAILNET_RUNNING', '请先停止远程服务，再修改账号密码。')
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
    this.state = this.initialSnapshot(relayPort)
    if (!config.tailnet.enabled) {
      this.disabled('已在设置中关闭内嵌节点，未启动本地中继。')
      return
    }
    if (config.serverUrl === undefined || relayPort === undefined) {
      this.disabled('服务器地址不是 http://127.0.0.1:<端口> 这样的本机地址，按外部服务器处理，未启动内置中继。')
      return
    }
    this.state.phase = 'probing'
    this.state.steps.node = { ok: null, detail: '正在启动内嵌节点' }
    this.publish()
    try {
      this.relayCredentials = await loadOrCreateRelayCredentials(this.dataDirectory())
      this.state.account = this.relayCredentials.account
      const node = await connectEmbeddedNode(this.options.packageRoot)
      this.node = node
      const status = await node.start({
        dir: this.nodeDirectory(),
        hostname: TAILNET_NODE_HOSTNAME,
        ...(config.tailnet.authKey === undefined ? {} : { authKey: config.tailnet.authKey }),
      })
      const phase = this.applyStatus(status, relayPort)
      if (phase === 'auth-required') {
        this.scheduleAdvance(relayPort)
        logger.info('tailnet node needs authorization', { authUrl: this.state.authUrl ?? '' })
        return
      }
      await this.completeSetup(relayPort)
    } catch (error) {
      this.fail(error)
    }
  }

  /** 节点在等用户点授权链接时继续轮询，授权完成后自动推进到就绪。 */
  private scheduleAdvance(relayPort: number): void {
    if (this.advanceTimer !== undefined) clearInterval(this.advanceTimer)
    this.advanceTimer = setInterval(() => this.advance(relayPort), 1000)
  }

  private advance(relayPort: number): void {
    const node = this.node
    if (this.disposed || node === undefined) {
      this.clearAdvance()
      return
    }
    this.applyStatus(node.status(), relayPort)
    if (this.state?.phase === 'starting' && this.state.steps.node.ok === true) {
      this.clearAdvance()
      void this.completeSetup(relayPort)
    }
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
    if (backend !== 'Running' && status.authURL !== undefined && status.authURL !== '') {
      this.state.phase = 'auth-required'
      this.state.authUrl = status.authURL
      this.state.steps.node = { ok: null, detail: '等待在浏览器里完成 Tailscale 授权' }
      this.publish()
      return this.state.phase
    }
    if (backend === 'Running' && status.dnsName !== undefined) {
      const dnsName = status.dnsName.replace(/\.$/, '')
      this.state.phase = 'starting'
      this.state.authUrl = undefined
      this.state.dnsName = dnsName
      this.state.publicUrl = publicUrlFor(dnsName, relayPort)
      this.state.steps.node = { ok: true, detail: '节点已加入 tailnet：' + dnsName }
      this.publish()
      return this.state.phase
    }
    this.state.steps.node = { ok: null, detail: '节点状态：' + backend }
    this.publish()
    return this.state.phase
  }

  /** 节点入网后起中继并在 tailnet 端口监听，最后回调上层完成 Host 授权。 */
  private async completeSetup(relayPort: number): Promise<void> {
    const { logger } = this.options
    if (this.state === undefined) return
    try {
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
      const node = this.node
      if (node === undefined) {
        throw new TailnetOrchestrationError('TAILNET_NODE_STOPPED', '内嵌节点已停止，无法监听 tailnet 端口。')
      }
      if (this.listeningPort !== relayPort) {
        this.state.steps.listen = { ok: null, detail: '正在 tailnet 端口 ' + String(relayPort) + ' 监听' }
        this.publish()
        await node.listen(relayPort, relayPort)
        this.listeningPort = relayPort
      }
      await this.waitForRelay(publicUrl + '/health')
      this.state.steps.listen = {
        ok: true,
        detail: '已在 ' + publicUrl + ' 监听并转发到 127.0.0.1:' + String(relayPort),
      }
      this.state.steps.authorize = { ok: null, detail: '等待 Host 设备授权' }
      this.state.phase = 'ready'
      this.state.error = undefined
      this.publish()
      logger.info('tailnet node ready', { publicUrl, relayPort })
      await this.options.onReady?.()
    } catch (error) {
      this.fail(error)
    }
  }

  /** 经节点自己访问中继健康检查，确认 tailnet 入站链路已经通到本机中继。 */
  private async waitForRelay(url: string): Promise<void> {
    const deadline = Date.now() + 15_000
    let lastError = ''
    while (Date.now() < deadline) {
      const node = this.node
      if (node === undefined) throw new TailnetOrchestrationError('TAILNET_NODE_STOPPED', '内嵌节点已停止，无法确认通知地址。')
      try {
        const response = await node.probe(url)
        if (response.status === 200) return
        lastError = 'HTTP ' + String(response.status)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise<void>(resolve => setTimeout(resolve, 500))
    }
    throw new TailnetOrchestrationError(
      'TAILNET_LISTEN_UNREACHABLE',
      '内嵌节点已在 tailnet 端口监听，但经节点访问本机中继失败：' + lastError,
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
    const node = this.node
    this.node = undefined
    this.listeningPort = undefined
    if (node !== undefined) await node.close()
    this.markStopped('远程服务已关闭。')
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
    return {
      enabled: true,
      phase: 'probing',
      ...(relayPort === undefined ? {} : { relayPort }),
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
    const target = steps.node.ok === false ? 'node'
      : steps.relay.ok === false ? 'relay'
        : steps.listen.ok === false ? 'listen' : undefined
    if (target === undefined) {
      steps.relay = { ok: false, detail: info.message }
      return
    }
    steps[target] = { ok: false, detail: info.message }
  }

  private fail(error: unknown): void {
    if (this.state === undefined) return
    const info = toTailnetError(error)
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
