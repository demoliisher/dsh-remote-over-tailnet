import { runTailscale, normalizeDnsName, type TailnetOptions } from './detect.js'

/** serve 阶段失败时对用户可见的分类。 */
export type ServeErrorCode =
  | 'SERVE_STATUS_FAILED'
  | 'SERVE_APPLY_FAILED'
  | 'SERVE_VERIFY_FAILED'
  | 'HTTPS_CERTIFICATES_DISABLED'

export class ServeError extends Error {
  readonly code: ServeErrorCode
  readonly actionUrl?: string
  readonly detail?: string

  constructor(code: ServeErrorCode, message: string, options: { actionUrl?: string; detail?: string } = {}) {
    super(message)
    this.name = 'ServeError'
    this.code = code
    if (options.actionUrl !== undefined) this.actionUrl = options.actionUrl
    if (options.detail !== undefined) this.detail = options.detail
  }
}

export interface ServeHandler {
  Proxy?: string
  Path?: string
}

export interface ServeWeb {
  Handlers?: Record<string, ServeHandler>
}

export interface ServeStatusJson {
  TCP?: Record<string, { HTTPS?: boolean }>
  Web?: Record<string, ServeWeb>
}

export interface ServeState {
  /** 443 上现有的代理目标；未配置时为 null。 */
  currentTarget: string | null
  /** 443 对应的 Web 键，例如 win11-pc.tail81eea4.ts.net:443。 */
  webKey: string | null
  raw: ServeStatusJson
}

export interface EnsureServeOptions extends TailnetOptions {
  /** serve 的监听端口，阶段一固定 443。 */
  servePort?: number
  /** 期望的本地代理目标，例如 http://127.0.0.1:52341。 */
  target: string
  /** 写入 serve 配置的超时时间，默认 120 秒；首次签发证书要等 ACME。 */
  applyTimeoutMs?: number
}

export interface EnsureServeResult {
  changed: boolean
  /** 被替换掉的旧目标，用于面板提示。 */
  previousTarget: string | null
  webKey: string
  target: string
}

/** 读取 `tailscale serve status --json`。空配置时命令输出 `{}`。 */
export async function readServeState(
  binary: string,
  options: TailnetOptions & { servePort?: number } = {},
): Promise<ServeState> {
  const result = await runTailscale(binary, ['serve', 'status', '--json'], options.commandTimeoutMs)
  if (!result.ok) {
    throw new ServeError(
      'SERVE_STATUS_FAILED',
      `读取 tailscale serve 状态失败：${firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '')}`,
      { detail: result.stderr || result.stdout },
    )
  }
  let raw: ServeStatusJson
  try {
    raw = result.stdout.trim() === '' ? {} : JSON.parse(result.stdout) as ServeStatusJson
  } catch (error) {
    throw new ServeError('SERVE_STATUS_FAILED', 'tailscale serve 返回的状态不是合法 JSON。', {
      detail: String(error),
    })
  }
  const servePort = options.servePort ?? 443
  const web = raw.Web ?? {}
  const key = Object.keys(web).find(item => item.endsWith(`:${servePort}`)) ?? null
  const handler = key === null ? undefined : web[key]?.Handlers?.['/']
  return {
    currentTarget: typeof handler?.Proxy === 'string' ? handler.Proxy : null,
    webKey: key,
    raw,
  }
}

/**
 * 保证 `<dnsName>:<servePort>` 的 `/` 代理指向 target。
 * 已一致时不做任何修改；不一致时接管该端口并写日志，行为与「幂等修正」一致。
 */
export async function ensureServe(
  binary: string,
  dnsName: string,
  options: EnsureServeOptions,
): Promise<EnsureServeResult> {
  const servePort = options.servePort ?? 443
  const host = normalizeDnsName(dnsName)
  const state = await readServeState(binary, options)
  const webKey = state.webKey ?? `${host}:${servePort}`
  if (state.currentTarget === options.target) {
    return { changed: false, previousTarget: null, webKey, target: options.target }
  }
  const previousTarget = state.currentTarget
  const args = ['serve', '--bg', `--https=${servePort}`, options.target]
  const applied = await runTailscale(binary, args, options.applyTimeoutMs ?? 120_000)
  if (!applied.ok) {
    const detail = applied.stderr || applied.stdout
    if (looksLikeHttpsCertificateProblem(detail)) {
      throw new ServeError(
        'HTTPS_CERTIFICATES_DISABLED',
        'Tailscale 的 HTTPS 证书功能未开启，其他设备无法通过 https://域名 访问。请在 Tailscale 管理台的 DNS 页面启用 HTTPS Certificates，然后重启 DSH。',
        { actionUrl: 'https://login.tailscale.com/admin/dns', detail },
      )
    }
    throw new ServeError(
      'SERVE_APPLY_FAILED',
      `配置 tailscale serve 失败：${firstLine(detail) || String(applied.error ?? '')}`,
      { detail },
    )
  }
  const verified = await readServeState(binary, options)
  if (verified.currentTarget !== options.target) {
    throw new ServeError(
      'SERVE_VERIFY_FAILED',
      `tailscale serve 已执行，但 ${webKey} 的代理目标仍是 ${verified.currentTarget ?? '未配置'}。请在命令行运行 \`tailscale serve status\` 检查。`,
      { detail: JSON.stringify(verified.raw) },
    )
  }
  return { changed: true, previousTarget, webKey, target: options.target }
}

function looksLikeHttpsCertificateProblem(detail: string): boolean {
  return /https.*(not enabled|disabled)|enable https|https certificates|certificate|certdomains|getcert/i.test(detail)
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0)
  return line ?? ''
}
