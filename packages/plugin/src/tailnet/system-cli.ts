import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 系统客户端当前状态。 */
export type SystemTailscaleState =
  | 'not-installed'
  | 'not-logged-in'
  | 'stopped'
  | 'running'

/** 一次探测的完整结果；面板据此提示安装、登录或展示地址。 */
export interface SystemTailscaleInfo {
  state: SystemTailscaleState
  /** 命中的可执行文件绝对路径；PATH 里的名称也记录在这里。 */
  executable?: string
  version?: string
  /** 去掉末尾点的 MagicDNS 名称，例如 win11-pc.tail81eea4.ts.net。 */
  dnsName?: string
  ipv4?: string
  /** 未登录时客户端给出的授权链接。 */
  authUrl?: string
  /** 状态补充说明，命令异常时展示。 */
  detail?: string
}

/** tailscale status --json 里本插件用到的字段。 */
interface StatusJson {
  Version?: string
  BackendState?: string
  AuthURL?: string
  TailscaleIPs?: string[]
  Self?: {
    DNSName?: string
    HostName?: string
    TailscaleIPs?: string[]
  }
}

/** 各平台常见安装位置；PATH 在列表之后兜底。 */
function candidateExecutables(): string[] {
  const paths: string[] = []
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env['ProgramFiles(x86)']
    const localAppData = process.env.LOCALAPPDATA
    if (programFiles !== undefined) paths.push(join(programFiles, 'Tailscale', 'tailscale.exe'))
    if (programFilesX86 !== undefined) paths.push(join(programFilesX86, 'Tailscale', 'tailscale.exe'))
    if (localAppData !== undefined) paths.push(join(localAppData, 'Tailscale', 'tailscale.exe'))
    paths.push('tailscale.exe')
  } else if (process.platform === 'darwin') {
    // Standalone 版把 CLI 装进 /usr/local/bin 或 Homebrew 目录；App Store 版的可执行文件在应用包内。
    paths.push('/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale')
    paths.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    paths.push('tailscale')
  } else {
    paths.push('/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale')
  }
  return paths
}

/** 找出第一个存在的可执行文件；PATH 里的名称交给 execFile 自己解析。 */
async function findExecutable(): Promise<string | undefined> {
  for (const candidate of candidateExecutables()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        await access(candidate)
        return candidate
      } catch {
        continue
      }
    }
    try {
      await execFileAsync(candidate, ['version'], { timeout: 5000, windowsHide: true })
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/** App Store 版默认会拉起图形界面，设置这个变量强制按命令行方式运行。 */
function cliEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, TAILSCALE_BE_CLI: '1' }
}

async function runCli(executable: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    timeout: 10000,
    windowsHide: true,
    env: cliEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/** 把 BackendState 映射为面板状态；未登录时保留授权链接。 */
function toInfo(raw: StatusJson, executable: string): SystemTailscaleInfo {
  const state = raw.BackendState ?? 'NoState'
  const ips = raw.Self?.TailscaleIPs ?? raw.TailscaleIPs ?? []
  const ipv4 = ips.find(address => !address.includes(':'))
  const dnsName = raw.Self?.DNSName?.replace(/\.$/, '')
  const base: SystemTailscaleInfo = {
    state: 'stopped',
    executable,
    version: raw.Version,
    ...(dnsName === undefined ? {} : { dnsName }),
    ...(ipv4 === undefined ? {} : { ipv4 }),
    ...(raw.AuthURL === undefined || raw.AuthURL === '' ? {} : { authUrl: raw.AuthURL }),
  }
  if (state === 'Running') return { ...base, state: 'running' }
  if (state === 'NeedsLogin' || state === 'LoggedOut') return { ...base, state: 'not-logged-in' }
  return base
}

/** 探测系统客户端。命令异常时不抛出，返回带说明的 stopped，交给面板提示。 */
export async function detectSystemTailscale(): Promise<SystemTailscaleInfo> {
  const executable = await findExecutable()
  if (executable === undefined) return { state: 'not-installed' }
  try {
    const stdout = await runCli(executable, ['status', '--json'])
    return toInfo(JSON.parse(stdout) as StatusJson, executable)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { state: 'stopped', executable, detail }
  }
}
