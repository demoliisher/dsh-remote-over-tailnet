/** 本机控制通道的应答封套，与 Host 侧 control-result.ts 的结构一致。 */
export type ControlResult<T = unknown> =
  | { ok: true; value: T }
  | {
      ok: false
      error?: {
        code?: string
        message?: string
        details?: { remoteCode?: string } & Record<string, unknown>
      }
    }

/** 面板上单个编排步骤的状态；ok 为 null 表示尚未执行。 */
export interface TailnetStepView {
  ok: boolean | null
  detail: string
}

/** 系统 Tailscale 客户端的安装与登录状态（视图）。 */
export interface SystemTailscaleView {
  state: 'not-installed' | 'not-logged-in' | 'stopped' | 'running'
  version?: string
  dnsName?: string
  ipv4?: string
  authUrl?: string
  detail?: string
}

/** wasm 扩展组件的下载状态（视图）。 */
export interface ExtensionView {
  state: 'absent' | 'downloading' | 'installed' | 'error'
  size?: number
  progress?: number
  error?: string
}

/** Host 侧节点与内置中继的状态快照（不含密码）。 */
export interface TailnetView {
  enabled: boolean
  mode: 'system' | 'embedded'
  phase: 'disabled' | 'probing' | 'starting' | 'auth-required' | 'ready' | 'error'
  dnsName?: string
  /** 节点的 tailnet IPv4 地址；面板可切换按域名或按 IP 呈现。 */
  ipv4?: string
  publicUrl?: string
  /** 对外中继端口：system 为 8080，embedded 为 80。 */
  publicPort: number
  relayPort?: number
  relayPid?: number
  /** 节点尚未登录时交给用户点击的 Tailscale 授权链接。 */
  authUrl?: string
  account?: string
  logPath?: string
  /** 当前 DSH Web 端口；面板用它显示客户端要填的端口。 */
  webPort?: number
  system?: SystemTailscaleView
  extension: ExtensionView
  /** SSH 模式：tailnet 上的监听端口、主机密钥指纹、转发目标端口与已固定端口；未启用时不存在。 */
  ssh?: { port: number; fingerprint: string; webPort: number; pinnedPort?: number }
  steps: {
    node: TailnetStepView
    relay: TailnetStepView
    listen: TailnetStepView
    authorize: TailnetStepView
  }
  error?: { code: string; message: string; actionUrl?: string }
  updatedAt: string
}

/** DSH Remote 客户端手动填写用的中继账号；按需单独请求，不随状态推送。 */
export interface TailnetCredentialsView {
  account: string
  password: string
}

/** 一台已经连上本机 Host 的客户端设备。 */
export interface RemoteConnectedClient {
  deviceId: string
  name: string
  platform?: string
  mode?: 'LAN' | 'P2P' | 'TURN' | 'Relay'
}

/** 本机 Host 侧的账号授权与客户端连接状态。 */
export interface RemoteHostStatus {
  deviceId?: string
  account?: string
  authorized: boolean
  accountRequired: boolean
  enabled: boolean
  online: boolean
  reconnecting: boolean
  lastActiveAt?: number
  recoveryExpiresAt?: number
  error?: string
  connectedClients: RemoteConnectedClient[]
}

export interface RemoteStatus {
  deviceName?: string
  startupError?: {
    code: string
    message: string
  }
  serviceAvailable: boolean
  tailnet?: TailnetView | null
  host?: RemoteHostStatus
}

/**
 * Where the Remote entry lives in the Desktop sidebar: among the footer actions
 * (Standard) or as an icon at the end of the account row (Compact).
 */
export type SidebarEntryStyle = 'standard' | 'compact'

/**
 * The entry style shared between the settings page and the sidebar entry, so a
 * toggle takes effect without a reload. Owned by the client entry point.
 */
export interface SidebarEntryPreference {
  read: () => SidebarEntryStyle
  subscribe: (listener: () => void) => () => void
  publish: (style: SidebarEntryStyle) => void
}

/** `ReactDOM.createPortal`, resolved once by the ModuleLoader factory. */
export type PortalRenderer = (children: unknown, container: Element) => unknown

/** The plugin's editable profile config, as read by the settings page. */
export interface PluginSettings {
  enabled?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  terminal?: { enabled?: boolean }
  sidebar?: { entry?: SidebarEntryStyle }
  service?: { enabled?: boolean }
  tailnet?: { enabled?: boolean; mode?: 'system' | 'embedded'; dataDirectory?: string; authKey?: string }
  ssh?: { enabled?: boolean; pinnedPort?: number }
}

export interface PluginSettingsView {
  config: PluginSettings
  deviceName: string
  writable: boolean
  startupError?: {
    code: string
    message: string
  }
}

/** React is supplied by Harness ModuleLoader, never bundled as a second runtime. */
export type ClientReact = {
  Fragment: unknown
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useEffect(effect: () => void | (() => void), deps: unknown[]): void
  useCallback<T>(callback: T, deps: unknown[]): T
  useMemo<T>(factory: () => T, deps: unknown[]): T
  useRef<T>(initial: T): { current: T }
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]
  useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T
}
