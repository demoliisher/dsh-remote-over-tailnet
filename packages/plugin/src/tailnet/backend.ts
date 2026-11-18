import type { Duplex } from 'node:stream'
import type { SafeLogger } from '../logging.js'
import type { TsnetNode, TsnetNodeStatus } from './embedded-node.js'
import { detectSystemTailscale, type SystemTailscaleInfo } from './system-cli.js'
import { exposeRelay, exposeSsh, type TailnetExposure } from './system-exposure.js'

/** 节点启动参数，两种模式共用同一形状。 */
export interface BackendStartOptions {
  dir: string
  hostname: string
  authKey?: string
}

/** 编排层依赖的节点能力：内嵌 wasm 与系统客户端各自实现。 */
export interface TailnetBackend {
  start(options: BackendStartOptions): Promise<TsnetNodeStatus>
  status(): Promise<TsnetNodeStatus>
  listen(tailPort: number, targetPort: number): Promise<number>
  listenStream(tailPort: number, onConnection: (socket: Duplex) => void): Promise<number>
  closeStream(): Promise<void>
  closeListener(): Promise<void>
  probe(url: string): Promise<{ status: number; body: string }>
  close(): Promise<void>
}

/** 把现有 wasm 节点包装成统一接口；status 改为异步以对齐系统模式。 */
export class EmbeddedBackend implements TailnetBackend {
  constructor(private readonly node: TsnetNode) {}
  start(options: BackendStartOptions): Promise<TsnetNodeStatus> { return this.node.start(options) }
  async status(): Promise<TsnetNodeStatus> { return this.node.status() }
  listen(tailPort: number, targetPort: number): Promise<number> { return this.node.listen(tailPort, targetPort) }
  listenStream(tailPort: number, onConnection: (socket: Duplex) => void): Promise<number> {
    return this.node.listenStream(tailPort, onConnection)
  }
  closeStream(): Promise<void> { return this.node.closeStream() }
  closeListener(): Promise<void> { return this.node.closeListener() }
  probe(url: string): Promise<{ status: number; body: string }> { return this.node.probe(url) }
  close(): Promise<void> { return this.node.close() }
}

/** 未登录、未安装这类状态转成面板可读的错误说明。 */
function describe(info: SystemTailscaleInfo): string {
  switch (info.state) {
    case 'not-installed': return '未检测到系统 Tailscale 客户端，请先安装并登录后再开启组网。'
    case 'not-logged-in': return info.authUrl === undefined
      ? '系统 Tailscale 客户端尚未登录，请运行 tailscale up 完成登录。'
      : '系统 Tailscale 客户端尚未登录，请点击下方的授权链接完成登录。'
    case 'stopped': return info.detail ?? '系统 Tailscale 客户端未运行，请启动它后重试。'
    default: return '系统 Tailscale 客户端状态异常。'
  }
}

/**
 * 系统客户端模式：不再在 tailnet 上虚拟监听端口，而是直接把真实 TCP 端口绑定在
 * 系统客户端分配的本机 tailnet 地址上。中继与 SSH 的认证、转发逻辑与内嵌模式共用。
 */
export class SystemBackend implements TailnetBackend {
  private info?: SystemTailscaleInfo
  private relay?: TailnetExposure
  private ssh?: TailnetExposure

  constructor(private readonly logger: SafeLogger) {}

  async start(_options: BackendStartOptions): Promise<TsnetNodeStatus> {
    return this.toStatus(await this.refreshInfo())
  }

  async status(): Promise<TsnetNodeStatus> {
    return this.toStatus(await this.refreshInfo())
  }

  /** 当前检测到的系统客户端信息，供面板展示安装与登录状态。 */
  currentInfo(): SystemTailscaleInfo | undefined {
    return this.info
  }

  private async refreshInfo(): Promise<SystemTailscaleInfo> {
    this.info = await detectSystemTailscale()
    return this.info
  }

  private toStatus(info: SystemTailscaleInfo): TsnetNodeStatus {
    if (info.state === 'running') {
      return {
        backendState: 'Running',
        dnsName: info.dnsName,
        tailscaleIPs: info.ipv4 === undefined ? [] : [info.ipv4],
        version: info.version,
      }
    }
    if (info.state === 'not-logged-in') {
      return { backendState: 'NeedsLogin', ...(info.authUrl === undefined ? {} : { authURL: info.authUrl }) }
    }
    return { backendState: 'NoState', error: describe(info) }
  }

  private requireHost(): string {
    const host = this.info?.ipv4
    if (host === undefined) throw new Error('系统 Tailscale 客户端没有可用的 tailnet 地址。')
    return host
  }

  async listen(tailPort: number, targetPort: number): Promise<number> {
    await this.closeListener()
    this.relay = await exposeRelay({ host: this.requireHost(), port: tailPort, targetPort, logger: this.logger })
    return tailPort
  }

  async listenStream(tailPort: number, onConnection: (socket: Duplex) => void): Promise<number> {
    await this.closeStream()
    this.ssh = await exposeSsh({ host: this.requireHost(), port: tailPort, onConnection, logger: this.logger })
    return tailPort
  }

  async closeStream(): Promise<void> {
    const ssh = this.ssh
    this.ssh = undefined
    if (ssh !== undefined) await ssh.close()
  }

  async closeListener(): Promise<void> {
    const relay = this.relay
    this.relay = undefined
    if (relay !== undefined) await relay.close()
  }

  /** 系统模式下经回环确认中继进程可用；对外监听已在 listen 时验证过绑定成功。 */
  async probe(url: string): Promise<{ status: number; body: string }> {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.text() }
  }

  async close(): Promise<void> {
    await Promise.all([this.closeListener(), this.closeStream()])
  }
}
