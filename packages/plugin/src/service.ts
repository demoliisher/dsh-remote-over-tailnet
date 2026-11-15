import { LanUploadHost } from './lan-upload.js'
import { WorkspaceUploadHost } from './workspace-upload.js'
import { workspaceUploadRootResolver } from './workspace-upload-authority.js'
import { LoopbackHost } from './loopback-host.js'
import { TerminalPolicy } from './terminal-policy.js'
import { createEvent, REMOTE_SESSION_EVENTS_CAPABILITY, type RemoteWorkspaceTypeDescription } from '@dsh-remote/protocol'
import { ConnectionController } from './connection-controller.js'
import type { ResolvedConfig } from './config.js'
import type { HostIdentity, IdentityStore } from './identity-store.js'
import {
  harnessSessionGeneration,
  isLiveSessionEventsHarnessVersion,
  readHarnessDistributionVersion,
} from './harness-version.js'
import type { SafeLogger } from './logging.js'
import { RpcRouter } from './rpc-router.js'
import { RemoteFileViewerBridge, type FileViewerHostServiceLike } from './file-viewer-bridge.js'
import {
  HostServerApi,
  ServerApiError,
  type DeviceAuthorization,
} from './server-api.js'
import { HostServerConnection } from './server-connection.js'
import { ServerCredentialStore } from './server-credentials.js'
import { dispatchCommandForHost, HarnessRemoteBridge, type ScheduleCreateService } from './harness-remote-bridge.js'
import { readCompactionConfirmation, RemoteCompactionOperations } from './remote-compaction-operations.js'
import type { PluginRouteDispatcher } from './plugin-route-bridge.js'
import { PluginRouteBridge } from './plugin-route-bridge.js'
import type { LocalTypertGateway } from './typert-gateway-contract.js'
import { loadNodeRtcFactory } from './werift-rtc.js'
import type { AuthenticatedPeerChannel } from './types.js'
import { CodexRemoteDomain } from './codex/domain.js'
import type { CodexPeerBridge, PublishCodexFrame } from './codex/peer-bridge.js'
import { RpcError } from './safe-error.js'
import { CodexWorkspaceBridge, CodexWorkspaceState, type RemoteTerminalSpawner } from './codex-workspace-bridge.js'

export interface HostConnectedClient {
  deviceId: string
  name: string
  platform?: string
  mode?: 'LAN' | 'P2P' | 'TURN' | 'Relay'
}

export interface HostRemoteStatus {
  deviceId?: string
  deviceName?: string
  configured: boolean
  /** 「远程服务」总开关：关闭时控制连接不启动，设备身份与授权保留。 */
  enabled: boolean
  online: boolean
  reconnecting: boolean
  recoveryExpiresAt?: number
  lastActiveAt?: number
  error?: string
  account?: string
  authorized: boolean
  accountRequired: boolean
  connectedClients: HostConnectedClient[]
}

export class HostPluginRuntime {
  readonly connections: ConnectionController
  private readonly terminalOwners = new Map<string, string>()
  private readonly loopbackHosts = new Set<LoopbackHost>()
  private terminalEnabled: boolean
  private loopbackPorts: readonly number[]
  private identity?: HostIdentity
  private deviceName: string
  private readonly serverApi?: HostServerApi
  private serverConnection?: HostServerConnection
  private harnessVersion?: string
  private controlEnabled: boolean
  private closed = false
  private readonly codex: CodexRemoteDomain
  private readonly codexWorkspaceState = new CodexWorkspaceState(key => TerminalPolicy.releaseOwner(this.terminalOwners, key))
  private localCodexPeer?: CodexPeerBridge
  private localCodexPublish: PublishCodexFrame = async () => undefined
  /**
   * 异步压缩的登记表挂在运行时上，而不是挂在某条连接上：客户端断线不能中断压缩。
   */
  private readonly compactionOperations: RemoteCompactionOperations
  private warnedMissingHostApi = false

  constructor(
    private readonly config: ResolvedConfig,
    private readonly identities: IdentityStore,
    private readonly logger: SafeLogger,
    private readonly localGateway?: LocalTypertGateway,
    private readonly fileViewerHost?: () => FileViewerHostServiceLike | undefined,
    /** PTY-backed terminal provider from the Host `subprocess` service, when present. */
    private readonly terminalSpawner?: RemoteTerminalSpawner,
    private readonly pluginRoutes?: (peer?: unknown) => PluginRouteDispatcher | undefined,
    /** Host `schedule` service; absent on Hosts whose composition omits reminders. */
    private readonly schedule?: ScheduleCreateService,
  ) {
    this.deviceName = config.deviceName
    this.terminalEnabled = config.terminal.enabled
    this.loopbackPorts = [...config.loopback.ports]
    this.controlEnabled = config.service.enabled
    this.codex = new CodexRemoteDomain(config.codex, logger)
    // 每个压缩任务用自己从 Host 网关注出来的 Peer 执行，生命周期与提交它的连接无关。
    this.compactionOperations = new RemoteCompactionOperations(async (sessionId, signal) => {
      const gateway = this.localGateway?.createPeer?.() ?? this.localGateway
      if (gateway === undefined) throw new RpcError('HARNESS_UNAVAILABLE', 'The Host Harness gateway is unavailable.')
      try {
        return await dispatchCommandForHost(
          gateway,
          { args: { agentId: sessionId, line: '/compact' } },
          signal,
          this.harnessVersion,
        )
      } finally {
        await gateway.dispose?.()
      }
    }, {
      logger,
      // `commands/execute` 在调用方中止后不再等待处理函数，所以最终结果只能看 Session 日志。
      confirm: async (sessionId, acceptedAt, commandId) => {
        const gateway = this.localGateway?.createPeer?.() ?? this.localGateway
        if (gateway === undefined) return { kind: 'unknown' }
        try {
          const result = await gateway.dispatch('session/events', {
            args: { request: { address: { kind: 'session', sessionId }, maxMessages: 128 } },
          }, AbortSignal.timeout(5_000))
          return readCompactionConfirmation(result, acceptedAt, commandId)
        } catch {
          return { kind: 'unknown' }
        } finally {
          await gateway.dispose?.()
        }
      },
    })
    this.connections = new ConnectionController(this.identities, (context, send) => {
      const peerGateway = this.localGateway?.createPeer?.() ?? this.localGateway
      const uploadDispatcher = this.pluginRoutes?.(peerGateway?.peer)
      const uploadBridge = uploadDispatcher === undefined ? undefined : new PluginRouteBridge(uploadDispatcher, this.logger)
      const harnessRemote = peerGateway?.supportsCarrier === true
        ? new HarnessRemoteBridge(
            peerGateway,
            (event, data) => send(createEvent(event, data)),
            this.logger,
            this.harnessVersion,
            new TerminalPolicy(() => this.terminalEnabled, context.peerDeviceId, this.terminalOwners),
            new CodexWorkspaceBridge(
              (threadId, signal) => this.codex.resolveThreadWorkspace(context.connectionId, threadId),
              () => this.terminalEnabled,
              this.codexWorkspaceState,
              this.terminalSpawner,
            ),
            workspaceUploadRootResolver(
              peerGateway,
              () => harnessSessionGeneration(this.harnessVersion) === 'v3',
              threadId => this.codex.resolveThreadWorkspace(context.connectionId, threadId),
              undefined,
            ),
            this.schedule,
            uploadBridge === undefined ? undefined : body => uploadBridge.call({ route: 'api/session/uploadFileBinary', body }, true),
          )
        : undefined
      const fileViewer = new RemoteFileViewerBridge(
        () => this.fileViewerHost?.(),
        this.logger,
      )
      const codex = this.codex.createPeer(
        context,
        (event, data) => send(createEvent(event, data)),
      )
      // The dispatcher must resolve inside the callback: the DSH connection
      // service (and its shared fetch handler) may become ready after this
      // plugin is activated.
      const dispatcher = this.pluginRoutes?.(peerGateway?.peer)
      const pluginRoute = dispatcher === undefined ? undefined : new PluginRouteBridge(dispatcher, this.logger)
      const workspaceUpload = new WorkspaceUploadHost(workspaceUploadRootResolver(
        peerGateway,
        () => harnessSessionGeneration(this.harnessVersion) === 'v3',
        threadId => this.codex.resolveThreadWorkspace(context.connectionId, threadId),
        undefined,
      ), undefined, context.transportMode)
      // LAN 直连上传只在已知对端身份、且通道确实走了局域网时才开放。
      const lanUpload = context.peerIdentityKey !== undefined && context.transportMode !== undefined
        ? new LanUploadHost(workspaceUpload, {
            connectionId: context.connectionId,
            peerIdentityKey: context.peerIdentityKey,
            identity: () => this.currentIdentity(),
            mode: context.transportMode,
          })
        : undefined
      return new RpcRouter(
        undefined,
        this.logger,
        fileViewer,
        harnessRemote,
        () => this.transportCapabilities(peerGateway),
        codex,
        // Handles and their lifetime belong to this connection; only policy is shared.
        this.createLoopbackHost(),
        () => this.hostWorkspaceTypes(),
        pluginRoute,
        workspaceUpload,
        {
          operations: this.compactionOperations,
          owner: { deviceId: context.peerDeviceId, connectionId: context.connectionId },
        },
        lanUpload,
      )
    }, this.logger)
    if (config.serverUrl !== undefined) {
      this.serverApi = new HostServerApi(config.serverUrl, new ServerCredentialStore(identities.directory))
    }
  }

  setTerminalEnabled(enabled: boolean): void {
    this.terminalEnabled = enabled
  }

  setLoopbackPorts(ports: readonly number[]): void {
    this.loopbackPorts = [...ports]
    for (const loopback of this.loopbackHosts) loopback.setPorts(this.loopbackPorts)
  }

  private backendUpdate: Promise<void> = Promise.resolve()

  setAgentBackends(config: ResolvedConfig): Promise<void> {
    const update = this.backendUpdate.catch(() => undefined).then(async () => {
      if (this.closed) throw new Error('remote runtime is closed')
      const codexChanged = JSON.stringify(this.config.codex) !== JSON.stringify(config.codex)
      await this.codex.reconfigure(config.codex)
      if (codexChanged) await this.codexWorkspaceState.dispose()
      this.config.codex = config.codex
    })
    this.backendUpdate = update
    return update
  }

  private createLoopbackHost(): LoopbackHost {
    let loopback: LoopbackHost
    loopback = new LoopbackHost(() => this.loopbackPorts, () => this.loopbackHosts.delete(loopback))
    this.loopbackHosts.add(loopback)
    return loopback
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('remote runtime is closed')
    this.identity = await this.identities.loadOrCreate(this.deviceName)
    this.logger.info('host identity ready', {
      deviceId: shortId(this.identity.deviceId),
      fingerprint: this.identity.fingerprint,
      server: this.config.serverUrl ?? 'not configured',
    })
    await this.codex.start()
    if (this.serverApi !== undefined) {
      this.harnessVersion = await this.readHarnessVersion()
      this.serverApi.setHarnessVersion(this.harnessVersion)
      this.serverApi.bindIdentity(this.identity)
      this.serverConnection = this.createServerConnection(this.identity)
    }
  }

  currentIdentity(): HostIdentity {
    if (this.identity === undefined) throw new Error('remote runtime has not started')
    return this.identity
  }

  acceptAuthenticatedPeer(channel: AuthenticatedPeerChannel): Promise<void> {
    this.currentIdentity()
    return this.connections.accept(channel)
  }

  hostStatus(): HostRemoteStatus {
    const error = this.serverConnection?.lastError()
    const authorization = this.serverApi?.currentAuthorization()
    return {
      ...(this.identity === undefined ? {} : { deviceId: this.identity.deviceId, deviceName: this.identity.name }),
      configured: this.serverApi !== undefined,
      enabled: this.controlEnabled,
      online: this.serverConnection?.isOnline() ?? false,
      reconnecting: this.serverConnection?.isReconnecting() ?? false,
      recoveryExpiresAt: this.serverConnection?.recoveryExpiresAt(),
      ...(this.serverConnection?.lastActivity() === undefined
        ? {}
        : { lastActiveAt: this.serverConnection.lastActivity() }),
      ...(error === undefined ? {} : { error }),
      ...(authorization?.account === undefined ? {} : { account: authorization.account }),
      authorized: authorization !== undefined,
      accountRequired: error === 'ACCOUNT_AUTH_REQUIRED' || error === 'AUTH_REQUIRED' || error === 'AUTH_INVALID' || error === 'TOKEN_EXPIRED' || error === 'DEVICE_REVOKED' || error === 'DEVICE_OWNERSHIP_REQUIRED',
      connectedClients: this.listConnectedClients(),
    }
  }

  private listConnectedClients(): HostConnectedClient[] {
    return this.connections.connectedPeers().map(peer => {
      const trusted = this.identities.trustedPeer(peer.deviceId)
      return {
        deviceId: peer.deviceId,
        name: trusted?.name.trim() ?? '',
        ...(trusted === undefined ? {} : { platform: trusted.platform }),
        ...(peer.mode === undefined ? {} : { mode: peer.mode }),
      }
    })
  }

  localHarnessVersion(): string | undefined {
    return this.harnessVersion
  }

  reconnectHost(): void {
    if (this.closed) throw new Error('remote runtime is closed')
    if (this.serverConnection === undefined) {
      throw new ServerApiError('SERVER_NOT_CONFIGURED', 'Configure serverUrl before reconnecting.', false)
    }
    this.serverConnection.reconnect()
  }

  /**
   * 「远程服务」总开关的 Host 侧动作。关闭只停控制连接，设备授权与身份保持不变；
   * 重新打开时直接恢复连接，本机凭据缺失时由调用方先重新授权。
   *
   * connect 为 false 只记录开关状态，不建立连接：内嵌节点还在等 Tailscale 授权时，
   * 中继尚未运行，提前连接只会触发一轮必定失败的重连。
   */
  async setHostControl(enabled: boolean, options: { connect?: boolean } = {}): Promise<void> {
    if (this.closed) throw new Error('remote runtime is closed')
    if (this.serverConnection === undefined) {
      throw new ServerApiError('SERVER_NOT_CONFIGURED', 'Configure serverUrl before changing Host access.', false)
    }
    this.controlEnabled = enabled
    if (!enabled) {
      await this.serverConnection.stop()
      return
    }
    if (options.connect !== false) this.serverConnection.resume()
  }

  /**
   * 改名保留同一设备身份；控制连接在构造时捕获身份，所以先停旧连接再重建。
   * 传入中继账号密码时重新注册，让服务器上的设备目录同步新名称。
   */
  async renameHost(deviceName: string, credentials?: { account: string; password: string }): Promise<HostRemoteStatus> {
    if (this.closed) throw new Error('remote runtime is closed')
    const name = deviceName.trim()
    if (name === '' || name.length > 80) throw new ServerApiError('INVALID_DEVICE_NAME', 'The device name must be 1 to 80 characters.', false)
    await this.serverConnection?.stop()
    this.deviceName = name
    this.identity = await this.identities.rename(name)
    if (this.serverApi !== undefined) {
      this.serverApi.bindIdentity(this.identity)
      this.serverConnection = this.createServerConnection(this.identity)
      if (credentials !== undefined) await this.authorizeHostWithAccount(credentials.account, credentials.password)
      else if (this.controlEnabled) this.serverConnection.resume()
    }
    this.logger.info('Host device renamed', { deviceId: shortId(this.identity.deviceId) })
    return this.hostStatus()
  }

  async authorizeHostWithAccount(email: string, password: string): Promise<DeviceAuthorization> {
    if (this.serverApi === undefined) {
      throw new ServerApiError('SERVER_NOT_CONFIGURED', 'Configure serverUrl before signing in.', false)
    }
    const result = await this.serverApi.authorizeWithAccount(this.currentIdentity(), email, password, async () => {
      await this.serverConnection?.stop()
      this.identity = await this.identities.reset(this.deviceName)
      this.serverApi!.bindIdentity(this.identity)
      this.serverConnection = this.createServerConnection(this.identity)
      this.logger.info('Rotated revoked Host identity before account authorization')
      return this.identity
    })
    if (this.controlEnabled) this.serverConnection?.resume()
    this.logger.info('Host account authorized')
    return result
  }

  async revokePeer(deviceId: string): Promise<boolean> {
    const revoked = await this.identities.revokePeer(deviceId)
    if (revoked) await this.connections.revoke(deviceId)
    return revoked
  }

  codexStatus(): ReturnType<CodexRemoteDomain['status']> {
    return this.codex.status()
  }

  codexCall(input: unknown): Promise<unknown> {
    return this.requireLocalCodexPeer().call(input)
  }

  codexRespond(input: unknown): Promise<{ resolved: true }> {
    return this.requireLocalCodexPeer().respond(input)
  }

  codexOpenStream(input: unknown, publish: PublishCodexFrame): Promise<unknown> {
    this.localCodexPublish = publish
    return this.requireLocalCodexPeer().openStream(input)
  }

  async codexCloseStream(input: unknown): Promise<unknown> {
    const peer = this.localCodexPeer
    if (peer !== undefined) return peer.closeStream(input)
    const streamId = isPlainRecord(input) && typeof input.streamId === 'string' ? input.streamId : undefined
    if (streamId === undefined) throw new RpcError('INVALID_MESSAGE', 'A Codex stream is required.')
    return { closed: false, streamId }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serverApi?.close()
    await this.serverConnection?.stop()
    this.compactionOperations.closeAll()
    await this.connections.close()
    await this.localCodexPeer?.closeAll()
    this.localCodexPeer = undefined
    const shutdown = await Promise.allSettled([this.codexWorkspaceState.dispose(), this.codex.close()])
    if (shutdown.some(result => result.status === 'rejected')) throw new RpcError('HOST_SHUTDOWN_FAILED', 'Some Host backend processes could not be stopped.')
    this.logger.info('host runtime stopped')
  }

  diagnostics() {
    return {
      loaded: this.identity !== undefined,
      deviceId: this.identity === undefined ? undefined : shortId(this.identity.deviceId),
      identityValid: this.identity !== undefined,
      serverConfigured: this.config.serverUrl !== undefined,
      serverOnline: this.serverConnection?.isOnline() ?? false,
      serverError: this.serverConnection?.lastError(),
      online: this.connections.isOnline(),
      activeConnections: this.connections.connectionCount(),
      peerDeviceId: this.connections.peerDeviceId() === undefined ? undefined : shortId(this.connections.peerDeviceId()!),
      peerDeviceIds: this.connections.peerDeviceIds().map(shortId),
      trustedPeers: this.identities.listTrustedPeers().length,
      capabilities: this.hostCapabilities(),
      workspaceTypes: this.hostWorkspaceTypes(),
      codex: this.codex.status(),
    }
  }

  private createServerConnection(identity: HostIdentity): HostServerConnection {
    return new HostServerConnection(
      this.config,
      identity,
      this.identities,
      this.serverApi!,
      this.connections,
      this.logger,
      undefined,
      this.config.forceRelay
        ? undefined
        : () => loadNodeRtcFactory({ routeTargets: this.config.serverUrl === undefined ? [] : [this.config.serverUrl] }),
      () => this.hostCapabilities(),
      this.harnessVersion,
    )
  }

  private async readHarnessVersion(): Promise<string | undefined> {
    const version = await readHarnessDistributionVersion()
    if (version === undefined) this.logger.warn('Harness version is unavailable')
    return version
  }

  private hostCapabilities(): string[] {
    const capabilities: string[] = ['workspace.upload.v1']
    if (this.loopbackPorts.length > 0) capabilities.push('loopback.http-ws.v1')
    if (this.localGateway?.supportsCarrier === true) {
      capabilities.push(
        harnessSessionGeneration(this.harnessVersion) === 'v3' ? 'harness.remote.v3' : 'harness.remote.v1',
        'harness.remote.transfer.v1',
      )
    }
    if (this.localGateway?.supportsCarrier && this.terminalEnabled) capabilities.push('harness.terminal.v1')
    if (this.fileViewerHost?.() !== undefined) capabilities.push('fileviewer.read.v1')
    if (this.pluginRoutes?.() !== undefined) capabilities.push('plugin.route.v1')
    if (this.codex.isAvailable()) capabilities.push('codex.appserver.v1', 'codex.appserver.transfer.v1')
    return capabilities
  }

  /**
   * 有能力协商时才行探测：Host 的 Session API 是否真的挂上了，决定能不能给
   * 会话事件与异步压缩这两项能力。探测失败连接直接拒绝，避免客户端按能力
   * 下单却在 Host 侧落空。
   */
  private async transportCapabilities(gateway?: LocalTypertGateway): Promise<string[]> {
    const capabilities = this.hostCapabilities()
    if (gateway?.supportsCarrier !== true) return capabilities
    let result: Awaited<ReturnType<LocalTypertGateway['dispatch']>>
    try {
      result = await gateway.dispatch('session/list', { args: { _request: {} } }, AbortSignal.timeout(5_000))
    } catch {
      throw new RpcError('CONNECTION_FAILED', 'Cannot verify the Host Session API.', undefined, true)
    }
    if (result.ok) {
      if (isLiveSessionEventsHarnessVersion(this.harnessVersion) && await this.probeLiveSessionEvents(gateway)) {
        capabilities.push(REMOTE_SESSION_EVENTS_CAPABILITY)
      }
      return capabilities
    }
    if (result.error.code === 'gateway/service-unavailable') {
      throw new RpcError('CONNECTION_FAILED', 'The Host Session API is not ready.', undefined, true)
    }
    if (result.error.code !== 'gateway/invocation-unavailable') {
      throw new RpcError('CONNECTION_FAILED', 'Cannot verify the Host Session API.', undefined, true)
    }
    if (!this.warnedMissingHostApi) {
      this.warnedMissingHostApi = true
      this.logger.warn('Host Remote API is incomplete. Install @deepseek-ai/dsh-api-remotes and its Host API packages.')
    }
    return capabilities.filter(value => !value.startsWith('harness.remote.') && value !== 'harness.terminal.v1')
  }

  private async probeLiveSessionEvents(gateway: LocalTypertGateway): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    let iterator: AsyncIterator<unknown> | undefined
    try {
      const stream = await gateway.open('$events', { args: {} }, controller.signal)
      iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next()
      return !first.done
        && typeof first.value === 'object'
        && first.value !== null
        && !Array.isArray(first.value)
        && (first.value as { type?: unknown }).type === 'ready'
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
      controller.abort()
      await iterator?.return?.().catch(() => undefined)
    }
  }

  private hostWorkspaceTypes(): RemoteWorkspaceTypeDescription[] {
    const types: RemoteWorkspaceTypeDescription[] = []
    if (this.codex.isAvailable()) {
      types.push({
        id: 'codex',
        name: 'CodeX',
        capability: 'codex.appserver.v1',
        available: true,
      })
    }
    return types
  }

  private requireLocalCodexPeer(): CodexPeerBridge {
    if (!this.codex.isAvailable()) {
      throw new RpcError('CODEX_UNAVAILABLE', 'Local CodeX is disabled or unavailable on this Host.')
    }
    if (this.localCodexPeer !== undefined) return this.localCodexPeer
    const identity = this.currentIdentity()
    const peer = this.codex.createPeer({
      connectionId: `loopback:${identity.deviceId}`,
      peerDeviceId: identity.deviceId,
    }, (event, data) => this.localCodexPublish(event, data))
    if (peer === undefined) {
      throw new RpcError('CODEX_UNAVAILABLE', 'Local CodeX is disabled or unavailable on this Host.')
    }
    this.localCodexPeer = peer
    return peer
  }
}

function shortId(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}` }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
