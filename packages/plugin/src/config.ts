import { hostname } from 'node:os'
import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'

export const DEFAULT_REMOTE_SERVER_URL = 'http://127.0.0.1:8080'

export interface Config {
  enabled?: boolean
  serverUrl?: string
  deviceName?: string
  terminal?: { enabled?: boolean }
  /** Where the Desktop client shows the Remote entry: beside Settings or in the account row. */
  sidebar?: { entry?: 'standard' | 'compact' }
  /** 「远程服务」总开关：中继、Tailscale 转发与 Host 控制连接一起启停。 */
  service?: { enabled?: boolean }
  loopback?: { ports?: number[] }
  /**
   * 内嵌 Tailscale 节点与本地中继编排：节点运行在插件进程里，不依赖系统安装的 Tailscale。
   * 仅当 serverUrl 是本机 http 地址时才启用，见 `tailnetRelayPort`。
   */
  tailnet?: {
    enabled?: boolean
    /** 中继状态、日志与账号密码所在目录；默认在插件数据目录下的 tailnet 子目录。 */
    dataDirectory?: string
    /** 预先在管理台申请好的节点授权密钥；留空时首次启动给出授权链接。 */
    authKey?: string
  }
  /**
   * 在 tailnet 节点上额外暴露一个 SSH 端口，供 DSH Go 之类的客户端以「只连接」模式接入。
   * 只放行到当前 DSH Web 端口的转发，不提供远端 shell。
   */
  ssh?: {
    enabled?: boolean
    /** tailnet 上的监听端口，与中继的 80 端口分开。 */
    port?: number
  }
  forceRelay?: boolean
  /**
   * When a known peer device presents a NEW identity key after re-authorizing with the
   * same account membership (e.g. the peer reinstalled the Harness), rotate the pinned
   * key instead of rejecting the connection. The new key is validated against the
   * account directory before this policy applies. Default: false (pin strictly).
   */
  rotatePinnedPeerKey?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  reconnect?: boolean | {
    initialDelayMs?: number
    maxDelayMs?: number
    jitter?: number
  }
  /** Optional Codex domain carried by the existing authenticated Remote Plugin. */
  codex?: {
    enabled?: boolean
    binary?: string
  }
}

export interface ResolvedCodexConfig {
  enabled: boolean
  binary: string
}

 export interface ResolvedConfig {
  enabled: boolean
  serverUrl?: string
  deviceName: string
  forceRelay: boolean
  rotatePinnedPeerKey: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  reconnect: {
    enabled: boolean
    initialDelayMs: number
    maxDelayMs: number
    jitter: number
  }
  terminal: { enabled: boolean }
  sidebar: { entry: 'standard' | 'compact' }
  service: { enabled: boolean }
  loopback: { ports: number[] }
  tailnet: {
    enabled: boolean
    dataDirectory?: string
    authKey?: string
  }
  ssh: { enabled: boolean; port: number }
  codex: ResolvedCodexConfig
}

/** The entry's volatile Cordis config: one stable reference for the whole section. */
export type EntryConfig = Volatile<Config>

/** Config accepted by {@link resolveConfig}: the composition seed or a live snapshot. */
export type ConfigInput = Config | VolatileSnapshot<Config>

/**
 * Schemastery schema for the plugin entry. On DSH 0.1.7-rc.1 and newer the
 * whole section is `.volatile()` (DSH-0.1.7-RC1-04): the Loader hands `apply`
 * a single live reference whose `.get()` always returns the latest committed
 * value, and the settings service persists edits in the active profile's
 * `cordis.patch.yml` under this entry id. On older hosts the helper above keeps
 * the plain schema required by the namespace-registration API.
 */
export const entryConfigSchema = s.object({
  enabled: s.boolean(),
  serverUrl: s.string(),
  deviceName: s.string(),
  terminal: s.object({ enabled: s.boolean() }),
  sidebar: s.object({ entry: s.union(['standard', 'compact'] as const) }),
  service: s.object({ enabled: s.boolean() }),
  loopback: s.object({ ports: s.array(s.number()) }),
  tailnet: s.object({ enabled: s.boolean(), dataDirectory: s.string(), authKey: s.string() }),
  ssh: s.object({ enabled: s.boolean(), port: s.number() }),
  forceRelay: s.boolean(),
  rotatePinnedPeerKey: s.boolean(),
  logLevel: s.union(['debug', 'info', 'warn', 'error'] as const),
  reconnect: s.union([
    s.boolean(),
    s.object({
      initialDelayMs: s.number(),
      maxDelayMs: s.number(),
      jitter: s.number(),
    }),
  ]),
  codex: s.object({
    enabled: s.boolean(),
    binary: s.string(),
  }),
})

/**
 * Mark the entry as live-editable when the host Schemastery supports the
 * 0.1.7 volatile schema mode. Older DSH releases ship an earlier Schemastery
 * where the method does not exist; their settings registry expects the plain
 * schema and must still be able to import the plugin without throwing.
 */
export function withVolatileSchema<T>(schema: T): T {
  const volatile = (schema as { volatile?: unknown }).volatile
  return typeof volatile === 'function'
    ? (volatile as (this: T) => T).call(schema)
    : schema
}

export const Config: s<Config> = withVolatileSchema(entryConfigSchema) as unknown as s<Config>

const reconnectSchema = z.union([
  z.boolean(),
  z.object({
    initialDelayMs: z.number().int().min(100).max(60_000).optional(),
    maxDelayMs: z.number().int().min(1_000).max(300_000).optional(),
    jitter: z.number().min(0).max(1).optional(),
  }).strict(),
])

const configSchema = z.object({
  enabled: z.boolean().optional(),
  serverUrl: z.string().url().optional(),
  deviceName: z.string().trim().min(1).max(80).optional(),
  terminal: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  sidebar: z.object({ entry: z.enum(['standard', 'compact']).optional() }).strict().optional(),
  service: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  loopback: z.object({ ports: z.array(z.number().int().min(1024).max(65535)).max(16).optional() }).strict().optional(),
  tailnet: z.object({
    enabled: z.boolean().optional(),
    dataDirectory: z.string().trim().min(1).max(4096).optional(),
    authKey: z.string().trim().min(1).max(512).optional(),
  }).strict().optional(),
  ssh: z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
  }).strict().optional(),
  forceRelay: z.boolean().optional(),
  rotatePinnedPeerKey: z.boolean().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  reconnect: reconnectSchema.optional(),
  codex: z.object({
    enabled: z.boolean().optional(),
    binary: z.string().trim().min(1).max(4096).optional(),
  }).strict().optional(),
}).strict()

export function resolveConfig(input: ConfigInput = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const parsed = configSchema.parse(input)
  const reconnect = typeof parsed.reconnect === 'object' ? parsed.reconnect : {}
  const configuredServerUrl = parsed.serverUrl ?? env.DSH_REMOTE_SERVER
  const serverUrl = configuredServerUrl === undefined ? undefined : normalizeServerUrl(configuredServerUrl)
  const initialDelayMs = reconnect.initialDelayMs ?? 4_000
  const maxDelayMs = reconnect.maxDelayMs ?? 30_000
  if (maxDelayMs < initialDelayMs) {
    throw new TypeError('reconnect.maxDelayMs must be greater than or equal to reconnect.initialDelayMs')
  }
  return {
    enabled: parsed.enabled ?? true,
    ...(serverUrl === undefined ? {} : { serverUrl }),
    deviceName: parsed.deviceName ?? env.DSH_REMOTE_DEVICE_NAME ?? hostname(),
    service: { enabled: parsed.service?.enabled ?? true },
    terminal: { enabled: parsed.terminal?.enabled ?? (env.DSH_REMOTE_TERMINAL_ENABLED === undefined || env.DSH_REMOTE_TERMINAL_ENABLED === 'true') },
    sidebar: { entry: parsed.sidebar?.entry === 'compact' ? 'compact' : 'standard' },
    loopback: { ports: [...new Set(parsed.loopback?.ports ?? [])] },
    tailnet: {
      enabled: parsed.tailnet?.enabled ?? true,
      ...(parsed.tailnet?.dataDirectory === undefined ? {} : { dataDirectory: parsed.tailnet.dataDirectory }),
      ...(parsed.tailnet?.authKey === undefined ? {} : { authKey: parsed.tailnet.authKey }),
    },
    ssh: {
      enabled: parsed.ssh?.enabled ?? false,
      port: parsed.ssh?.port ?? 2222,
    },
    forceRelay: parsed.forceRelay ?? false,
    rotatePinnedPeerKey: parsed.rotatePinnedPeerKey ?? false,
    logLevel: parsed.logLevel ?? 'info',
    reconnect: {
      enabled: parsed.reconnect !== false,
      initialDelayMs,
      maxDelayMs,
      jitter: reconnect.jitter ?? 0.2,
    },
    codex: {
      enabled: parsed.codex?.enabled ?? true,
      binary: parsed.codex?.binary ?? 'codex',
    },
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function isPrivateIpv6(hostname: string): boolean {
  const host = (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname).toLowerCase()
  if (!host.includes(':') || !/^[0-9a-f:]+$/.test(host)) return false
  if (host === '::1') return true
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
}

/** IPv4/IPv6 hosts that are only reachable on loopback, a LAN, link-local, or CGNAT/VPN networks. */
function isPrivateNetworkHostname(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) return true
  if (isPrivateIpv6(hostname)) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  if (octets.some(value => value > 255)) return false
  const [a, b] = octets
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value)
  const privateHttp = url.protocol === 'http:' && isPrivateNetworkHostname(url.hostname)
  if (url.protocol !== 'https:' && !privateHttp) {
    throw new TypeError('serverUrl must use HTTPS (HTTP is allowed only for localhost or private-network addresses)')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('serverUrl must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('serverUrl must not contain query parameters or fragments')
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new TypeError('serverUrl must be an origin without a path')
  }
  return url.origin
}
