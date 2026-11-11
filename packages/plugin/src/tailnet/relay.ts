import { spawn, execFile } from 'node:child_process'
import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeLogger } from '../logging.js'

/** 中继进程编排出错时对用户可见的分类。 */
export type RelayErrorCode =
  | 'RELAY_SERVER_MISSING'
  | 'RELAY_VERSION_MISMATCH'
  | 'RELAY_ALREADY_RUNNING'
  | 'RELAY_PORT_IN_USE'
  | 'RELAY_START_FAILED'
  | 'RELAY_CREDENTIALS_MISMATCH'
  | 'RELAY_CLEANUP_FAILED'

export class RelayError extends Error {
  readonly code: RelayErrorCode
  readonly actionUrl?: string
  readonly detail?: string

  constructor(code: RelayErrorCode, message: string, options: { actionUrl?: string; detail?: string } = {}) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    if (options.actionUrl !== undefined) this.actionUrl = options.actionUrl
    if (options.detail !== undefined) this.detail = options.detail
  }
}

export interface RelayServerInfo {
  /** 中继入口 main.cjs 绝对路径。 */
  entryPath: string
  /** 与插件版本比对的 server/version.json 内容。 */
  pluginVersion: string
  upstreamVersion?: string
}

export interface RelayOptions {
  /** 插件包内的 server 目录，内含 version.json 与 dist/main.cjs。 */
  serverRoot: string
  /** 本插件的版本号，用于校验中继产物版本。 */
  pluginVersion: string
  /** 中继数据目录：state.json、relay.lock、relay.log。 */
  dataDirectory: string
  /** 固定监听端口，与 serverUrl 的回环端口一致，避免身份目录变化。 */
  port: number
  /** 对外地址，https://<DNSName>。 */
  publicUrl: string
  account: string
  password: string
  logger: SafeLogger
  /** 等待 /health 就绪的时长，默认 20 秒。 */
  healthTimeoutMs?: number
  /** 中继进程意外退出时回调；编排层用它更新面板状态。 */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void
}

export interface RelayHandle {
  pid: number
  port: number
  publicUrl: string
  /** 中继进程已退出时返回 true。 */
  exited(): boolean
  stop(): Promise<void>
}

interface RelayLock {
  schemaVersion: 1
  supervisorPid: number
  serverPid?: number
  port: number
  publicUrl: string
  startedAt: string
}

const LOCK_SCHEMA_VERSION = 1
const HEALTH_POLL_INTERVAL_MS = 200
const STATE_FILE_NAME = 'state.json'
const LOCK_FILE_NAME = 'relay.lock'
const LOG_FILE_NAME = 'relay.log'
const MAX_LOG_BYTES = 4 * 1024 * 1024

/** 读取并校验 server/version.json，确认中继产物与插件同版本。 */
export async function readServerBundleInfo(serverRoot: string, pluginVersion: string): Promise<RelayServerInfo> {
  const versionPath = join(serverRoot, 'version.json')
  let versionText: string
  try {
    versionText = await readFile(versionPath, 'utf8')
  } catch {
    throw new RelayError(
      'RELAY_SERVER_MISSING',
      `未找到中继程序产物（${versionPath}）。请重新安装插件，或在本仓库运行 pnpm run build:server 后重新安装。`,
    )
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(versionText) as Record<string, unknown>
  } catch (error) {
    throw new RelayError('RELAY_VERSION_MISMATCH', `中继版本信息不是合法 JSON：${versionPath}`, { detail: String(error) })
  }
  const bundledVersion = raw.pluginVersion
  if (bundledVersion !== pluginVersion) {
    throw new RelayError(
      'RELAY_VERSION_MISMATCH',
      `中继产物版本为 ${String(bundledVersion)}，与插件版本 ${pluginVersion} 不一致。请重新构建插件（pnpm run build）后重启 DSH。`,
      { detail: JSON.stringify(raw) },
    )
  }
  const distFiles = await readdir(join(serverRoot, 'dist')).catch(() => [] as string[])
  const entryPath = join(serverRoot, 'dist', 'main.cjs')
  if (!distFiles.includes('main.cjs')) {
    throw new RelayError('RELAY_SERVER_MISSING', `中继产物缺少 ${entryPath}。请重新构建插件后重启 DSH。`)
  }
  return {
    entryPath,
    pluginVersion,
    ...(typeof raw.upstreamVersion === 'string' ? { upstreamVersion: raw.upstreamVersion } : {}),
  }
}

/**
 * 启动中继 server 子进程并等到 /health 就绪。
 *
 * 端口固定：插件身份目录按 serverUrl 的 origin 哈希，中继换端口等于换 Host 身份。
 * 子进程用 `ELECTRON_RUN_AS_NODE=1` 复用 DSH 自己的 Electron 可执行文件，因此不依赖
 * 系统 PATH 里是否有 node。
 */
export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const info = await readServerBundleInfo(options.serverRoot, options.pluginVersion)
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 })
  await releaseStaleLock(options)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const handle = await spawnRelay(options, info.entryPath)
    if (await verifyLogin(options) === 'ok') return handle
    await handle.stop()
    if (attempt === 1) {
      // 凭据与 state.json 的密码校验值不一致：删除状态文件重建，Host 会自动重新注册。
      await rm(join(options.dataDirectory, STATE_FILE_NAME), { force: true })
      options.logger.warn('relay state did not match stored credentials; rebuilt relay state', {
        directory: options.dataDirectory,
      })
      continue
    }
    throw new RelayError(
      'RELAY_CREDENTIALS_MISMATCH',
      '中继已启动，但用保存的账号密码登录失败。请删除中继数据目录后重启 DSH：' + options.dataDirectory,
    )
  }
  throw new RelayError('RELAY_START_FAILED', '中继 server 启动失败。')
}

/** 处理上次运行遗留的锁：别的 DSH 实例在用时直接报错，残留进程先清理。 */
async function releaseStaleLock(options: RelayOptions): Promise<void> {
  const lockPath = join(options.dataDirectory, LOCK_FILE_NAME)
  const lock = await readLock(lockPath)
  if (lock === undefined) return
  if (lock.supervisorPid !== process.pid && isProcessAlive(lock.supervisorPid)) {
    throw new RelayError(
      'RELAY_ALREADY_RUNNING',
      `另一个 DSH 实例已经为同一地址启动了中继（进程 ${lock.supervisorPid}）。请先退出那个 DSH 窗口，或把本实例的服务器地址改到另一个回环端口。`,
    )
  }
  const health = await probeHealth(options.port)
  if (lock.serverPid !== undefined && isProcessAlive(lock.serverPid)) {
    if (health?.status === 'ok' && await verifyLogin(options) === 'ok') {
      options.logger.warn('terminating leftover relay process', { pid: lock.serverPid })
      await terminatePid(lock.serverPid)
    } else {
      throw new RelayError(
        'RELAY_PORT_IN_USE',
        `端口 ${options.port} 已被其他程序占用，无法启动内置中继。请退出占用该端口的程序后重启 DSH。`,
        { detail: `locked pid ${lock.serverPid}` },
      )
    }
  } else if (health?.status === 'ok') {
    throw new RelayError(
      'RELAY_PORT_IN_USE',
      `端口 ${options.port} 已被其他程序占用，无法启动内置中继。请退出占用该端口的程序后重启 DSH。`,
    )
  }
  await rm(lockPath, { force: true })
}

async function spawnRelay(options: RelayOptions, entryPath: string): Promise<RelayHandle> {
  const dataDirectory = options.dataDirectory
  const logPath = relayLogPath(dataDirectory)
  await rotateLog(logPath)
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
  let output = ''
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const append = (chunk: string): void => {
    log.write(chunk)
    output += chunk
    if (output.length > 16000) output = output.slice(-16000)
  }

  const child = spawn(process.execPath, [entryPath], {
    cwd: dataDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 插件跑在 Electron 里，process.execPath 是 DSH 自己的可执行文件。
      ELECTRON_RUN_AS_NODE: '1',
      DSH_SERVER_ACCOUNT: options.account,
      DSH_SERVER_PASSWORD: options.password,
      DSH_SERVER_PORT: String(options.port),
      DSH_SERVER_HOST: '127.0.0.1',
      DSH_SERVER_PUBLIC_URL: options.publicUrl,
      DSH_SERVER_DATA_FILE: join(dataDirectory, STATE_FILE_NAME),
      DSH_SERVER_LOG_LEVEL: 'info',
    },
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => append(chunk))
  child.stderr.on('data', (chunk: string) => append(chunk))
  const exitFlight = new Promise<void>(resolveExit => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      log.end(`\n[relay exited] code=${String(code)} signal=${String(signal)}\n`)
      resolveExit()
    })
  })
  if (child.pid === undefined) {
    await exitFlight
    throw new RelayError('RELAY_START_FAILED', '无法创建中继 server 进程。', { detail: output })
  }
  await writeLock(dataDirectory, {
    schemaVersion: LOCK_SCHEMA_VERSION,
    supervisorPid: process.pid,
    serverPid: child.pid,
    port: options.port,
    publicUrl: options.publicUrl,
    startedAt: new Date().toISOString(),
  })
  options.logger.info('relay server process started', { pid: child.pid, port: options.port, publicUrl: options.publicUrl })

  let stopped = false
  const handle: RelayHandle = {
    pid: child.pid,
    port: options.port,
    publicUrl: options.publicUrl,
    exited: () => exitInfo !== undefined,
    stop: async () => {
      if (stopped) return
      stopped = true
      await stopChild(child, exitFlight, options.logger)
      await rm(join(dataDirectory, LOCK_FILE_NAME), { force: true })
      log.end()
    },
  }

  void exitFlight.then(() => {
    if (!stopped) options.onExit?.(exitInfo!)
  })

  const timeoutMs = options.healthTimeoutMs ?? 20_000
  const deadline = Date.now() + timeoutMs
  let lastError = '尚未收到响应'
  while (Date.now() < deadline) {
    if (exitInfo !== undefined) {
      throw new RelayError(
        'RELAY_START_FAILED',
        `中继 server 启动后立即退出（退出码 ${String(exitInfo.code)}）。详见日志：${logPath}`,
        { detail: output },
      )
    }
    const health = await probeHealth(options.port)
    if (health.status === 'ok') return handle
    lastError = health.detail ?? '无法连接 127.0.0.1:' + String(options.port)
    await delay(HEALTH_POLL_INTERVAL_MS)
  }
  await handle.stop()
  throw new RelayError(
    'RELAY_START_FAILED',
    `中继 server 在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪（${lastError}）。详见日志：${logPath}`,
    { detail: output },
  )
}

async function stopChild(
  child: ReturnType<typeof spawn>,
  exitFlight: Promise<void>,
  logger: SafeLogger,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exitFlight
    return
  }
  child.kill()
  if (await Promise.race([exitFlight.then(() => true), delay(5000).then(() => false)])) return
  logger.warn('relay server did not exit after SIGTERM; forcing termination', { pid: child.pid })
  child.kill('SIGKILL')
  if (!await Promise.race([exitFlight.then(() => true), delay(2000).then(() => false)])) {
    throw new RelayError('RELAY_CLEANUP_FAILED', `无法终止中继 server 进程 ${String(child.pid)}。`)
  }
}

interface HealthResult {
  status: string
  detail?: string
}

async function probeHealth(port: number): Promise<HealthResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (response.status !== 200) return { status: `http-${response.status}`, detail: `HTTP ${response.status}` }
    const body = await response.json() as Record<string, unknown>
    return { status: typeof body.status === 'string' ? body.status : 'unknown' }
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 用账号密码登录中继，既验证就用也已验证凭据与 state.json 一致。 */
async function verifyLogin(options: RelayOptions): Promise<'ok' | 'invalid'> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${options.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: options.account, password: options.password }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    throw new RelayError(
      'RELAY_START_FAILED',
      `无法连接中继 server 的登录接口：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status === 401) return 'invalid'
  if (!response.ok) throw new RelayError('RELAY_START_FAILED', `中继 server 登录接口返回 HTTP ${response.status}。`)
  const body = await response.json() as Record<string, unknown>
  return typeof body.account === 'string' && body.account === options.account ? 'ok' : 'invalid'
}

async function readLock(path: string): Promise<RelayLock | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== LOCK_SCHEMA_VERSION) return undefined
  if (typeof record.supervisorPid !== 'number' || typeof record.port !== 'number') return undefined
  if (typeof record.publicUrl !== 'string' || typeof record.startedAt !== 'string') return undefined
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    supervisorPid: record.supervisorPid,
    ...(typeof record.serverPid === 'number' ? { serverPid: record.serverPid } : {}),
    port: record.port,
    publicUrl: record.publicUrl,
    startedAt: record.startedAt,
  }
}

async function writeLock(directory: string, lock: RelayLock): Promise<void> {
  const path = join(directory, LOCK_FILE_NAME)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function terminatePid(pid: number): Promise<void> {
  try {
    process.kill(pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw error
  }
  if (await waitForExit(pid, 3000)) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolveKill => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolveKill())
    })
  }
  if (!await waitForExit(pid, 2000)) {
    throw new RelayError(
      'RELAY_CLEANUP_FAILED',
      `无法终止残留的中继进程 ${pid}。请在任务管理器中结束它，然后重启 DSH。`,
    )
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(150)
  }
  return !isProcessAlive(pid)
}

async function rotateLog(path: string): Promise<void> {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return
    rmSync(`${path}.1`, { force: true })
    renameSync(path, `${path}.1`)
  } catch {
    // 日志轮转失败不影响中继启动。
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

/** 中继日志路径，面板与报错共用。 */
export function relayLogPath(dataDirectory: string): string {
  return join(dataDirectory, LOG_FILE_NAME)
}
