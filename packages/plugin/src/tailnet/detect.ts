import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Tailscale 探测失败时对用户可见的分类。 */
export type TailnetErrorCode =
  | 'TAILSCALE_NOT_INSTALLED'
  | 'TAILSCALE_NOT_RUNNING'
  | 'TAILSCALE_NOT_LOGGED_IN'
  | 'TAILSCALE_OFFLINE'
  | 'TAILSCALE_NO_DNS_NAME'
  | 'TAILSCALE_COMMAND_FAILED'

export interface TailnetError {
  code: TailnetErrorCode
  /** 可直接展示给用户的中文提示，含下一步操作。 */
  message: string
  /** 命令原始输出，仅写日志，不展示。 */
  detail?: string
  actionUrl?: string
}

export interface TailnetStatus {
  /** 实际使用的 tailscale 可执行文件路径；未安装时为 null。 */
  binary: string | null
  backendState?: string
  loggedIn: boolean
  online: boolean
  /** tailnet 设备域名，已去掉 FQDN 末尾的点，例如 win11-pc.tail81eea4.ts.net。 */
  dnsName?: string
  /** `tailscale status --json` 报告的证书域名列表。 */
  certDomains: string[]
  tailscaleIPs: string[]
  error?: TailnetError
}

export interface TailnetOptions {
  /** 显式指定 tailscale 可执行文件；默认按平台常见位置与 PATH 查找。 */
  binaryPath?: string
  /** 单条 tailscale 命令的超时时间，默认 10 秒。 */
  commandTimeoutMs?: number
}

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: Error
}

const DEFAULT_TIMEOUT_MS = 10_000

export async function runTailscale(
  binary: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return await new Promise(resolve => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error === null ? {} : { error }),
        })
      },
    )
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function pathCandidates(): string[] {
  const binary = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  const paths = (process.env.PATH ?? '')
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(entry => entry.length > 0)
    .map(entry => join(entry, binary))
  if (process.platform === 'win32') {
    paths.push(
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Tailscale', binary),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', binary),
    )
  }
  return paths
}

/** 找到 tailscale 可执行文件；找不到返回 null。 */
export async function findTailscaleBinary(options: TailnetOptions = {}): Promise<string | null> {
  const override = options.binaryPath ?? process.env.DSH_REMOTE_TAILSCALE_BIN
  if (override !== undefined && override.trim() !== '') {
    return (await exists(override)) ? override : null
  }
  for (const candidate of pathCandidates()) {
    if (await exists(candidate)) return candidate
  }
  return null
}

interface RawStatus {
  BackendState?: unknown
  HaveNodeKey?: unknown
  /** 证书域名在顶层；旧版本 CLI 曾放在 Self 里，两处都读。 */
  CertDomains?: unknown
  Self?: {
    DNSName?: unknown
    Online?: unknown
    TailscaleIPs?: unknown
    CertDomains?: unknown
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 去掉 DNSName 的结尾点。Service 端与 serve 状态里的键都不带结尾点。 */
export function normalizeDnsName(value: string): string {
  return value.replace(/\.+$/, '')
}

/**
 * 读取 `tailscale status --json` 并翻译成插件可用的状态。
 * 只在「无法使用 tailnet」时返回 error；能拿到域名即视为成功，HTTPS 证书是否开启交给 serve 阶段判定。
 */
export async function detectTailnet(options: TailnetOptions = {}): Promise<TailnetStatus> {
  const binary = await findTailscaleBinary(options)
  if (binary === null) {
    return {
      binary: null,
      loggedIn: false,
      online: false,
      certDomains: [],
      tailscaleIPs: [],
      error: {
        code: 'TAILSCALE_NOT_INSTALLED',
        message: '未找到 Tailscale 客户端。请先安装 Tailscale 并登录，否则本机中继无法通过 tailnet 提供服务。',
        actionUrl: 'https://tailscale.com/download',
      },
    }
  }
  const result = await runTailscale(binary, ['status', '--json'], options.commandTimeoutMs)
  if (!result.ok) {
    return {
      binary,
      loggedIn: false,
      online: false,
      certDomains: [],
      tailscaleIPs: [],
      error: {
        code: 'TAILSCALE_COMMAND_FAILED',
        message: `无法执行 tailscale 命令：${firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '')}`,
        detail: result.stderr || result.stdout,
      },
    }
  }
  let raw: RawStatus
  try {
    raw = JSON.parse(result.stdout) as RawStatus
  } catch (error) {
    return {
      binary,
      loggedIn: false,
      online: false,
      certDomains: [],
      tailscaleIPs: [],
      error: {
        code: 'TAILSCALE_COMMAND_FAILED',
        message: 'tailscale 返回的状态不是合法 JSON，无法判断网络状态。',
        detail: String(error),
      },
    }
  }
  const backendState = asString(raw.BackendState)
  const loggedIn = raw.HaveNodeKey === true
  const online = raw.Self?.Online === true
  const dnsName = asString(raw.Self?.DNSName)
  const certDomains = asStringArray(raw.CertDomains ?? raw.Self?.CertDomains)
  const tailscaleIPs = asStringArray(raw.Self?.TailscaleIPs)
  const base = {
    binary,
    ...(backendState === undefined ? {} : { backendState }),
    loggedIn,
    ...(dnsName === undefined ? {} : { dnsName: normalizeDnsName(dnsName) }),
    certDomains,
    tailscaleIPs,
  }
  if (!loggedIn) {
    return {
      ...base,
      online: false,
      error: {
        code: 'TAILSCALE_NOT_LOGGED_IN',
        message: 'Tailscale 尚未登录。请打开 Tailscale 完成登录，然后重启 DSH。',
      },
    }
  }
  if (backendState !== 'Running') {
    return {
      ...base,
      online: false,
      error: {
        code: 'TAILSCALE_NOT_RUNNING',
        message: 'Tailscale 没有运行。请启动 Tailscale，等待状态变为 Connected 后重启 DSH。',
      },
    }
  }
  if (!online) {
    return {
      ...base,
      online: false,
      error: {
        code: 'TAILSCALE_OFFLINE',
        message: 'Tailscale 已登录但当前离线。请检查网络或重新连接 Tailscale。',
      },
    }
  }
  if (dnsName === undefined) {
    return {
      ...base,
      online,
      error: {
        code: 'TAILSCALE_NO_DNS_NAME',
        message: '未能获取 Tailscale 设备域名（DNSName）。请检查 Tailscale 是否已启用 MagicDNS。',
        actionUrl: 'https://login.tailscale.com/admin/dns',
      },
    }
  }
  return { ...base, online }
}

/** 把探测结果里的域名转成对外 HTTPS 地址。 */
export function tailnetHttpsUrl(status: TailnetStatus): string {
  if (status.dnsName === undefined) throw new Error('Tailnet 状态没有 DNSName，无法生成公开地址。')
  return `https://${status.dnsName}`
}

/** 是否具备 HTTPS 证书前置条件。仅作提示，最终以 serve 结果为准。 */
export function httpsCertificateReady(status: TailnetStatus): boolean {
  if (status.dnsName === undefined) return false
  return status.certDomains.some(domain => normalizeDnsName(domain) === status.dnsName)
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0)
  return line ?? ''
}
