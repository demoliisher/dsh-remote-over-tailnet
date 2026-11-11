/**
 * 把上游中继 server 打包成单文件产物，输出到 packages/plugin/server/。
 *
 * 上游 `apps/server/dist/main.js` 是 ESM，产物改写为 CommonJS（扩展名必须为
 * `.cjs`）：仓库根 package.json 声明了 `"type": "module"`，`.js` 会被当作 ESM
 * 解析，导致 `require is not defined`。`import.meta.url` 通过 banner 注入的
 * `__importMetaUrl` 替代，避免 CommonJS 产物引用 ESM 专有语法。
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(scriptDir, '..')
const repoRoot = resolve(pluginRoot, '..', '..')

const upstreamRoot = resolve(process.env.DSH_REMOTE_UPSTREAM ?? 'D:/Projects/dsh-exp/ds-harness-remote')
const upstreamMain = join(upstreamRoot, 'apps', 'server', 'dist', 'main.js')
const protocolEntry = join(repoRoot, 'packages', 'protocol', 'dist', 'index.js')

if (!existsSync(upstreamMain)) {
  throw new Error(
    `未找到上游中继 server 的构建产物：${upstreamMain}。` +
      '请先在上游克隆里构建 apps/server（运行 pnpm --filter @dsh-remote/server build）。'
  )
}
if (!existsSync(protocolEntry)) {
  throw new Error(`未找到 protocol 构建产物：${protocolEntry}。请先运行 pnpm build 生成它。`)
}

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version
if (typeof pluginVersion !== 'string') {
  throw new Error('packages/plugin/package.json 缺少字符串类型的 version 字段。')
}

/** 优先用 git tag 描述上游版本；git 不可用或当前提交没有精确 tag 时回退 package.json。 */
function readUpstreamVersion() {
  try {
    return execFileSync('git', ['-C', upstreamRoot, 'describe', '--tags', '--exact-match'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return JSON.parse(readFileSync(join(upstreamRoot, 'package.json'), 'utf8')).version
  }
}

const upstreamVersion = readUpstreamVersion()

const serverRoot = join(pluginRoot, 'server')
const distDir = join(serverRoot, 'dist')
const outfile = join(distDir, 'main.cjs')

// 清空旧的 dist，避免上次构建的文件残留。
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

await build({
  entryPoints: [upstreamMain],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { '@dsh-remote/protocol': protocolEntry },
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
})

const serverBytes = readFileSync(outfile)
const serverSha256 = createHash('sha256').update(serverBytes).digest('hex')

writeFileSync(
  join(serverRoot, 'version.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      pluginVersion,
      upstreamVersion,
      builtAt: new Date().toISOString(),
      serverSha256,
    },
    null,
    2
  )}\n`
)

/** 在 127.0.0.1 上取一个空闲端口。 */
function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error) {
          rejectPort(error)
          return
        }
        resolvePort(address.port)
      })
    })
  })
}

/** 启动产物并轮询 /health，验证它能真正提供服务。 */
async function runSelfCheck(entry) {
  const port = await findFreePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-remote-server-check-'))
  const env = {
    ...process.env,
    DSH_SERVER_ACCOUNT: 'build-check@local',
    // 固定 16 位测试密码，满足上游至少 12 位的校验。
    DSH_SERVER_PASSWORD: 'build-check-pass',
    DSH_SERVER_PORT: String(port),
    DSH_SERVER_HOST: '127.0.0.1',
    DSH_SERVER_PUBLIC_URL: 'https://build-check.localhost',
    DSH_SERVER_DATA_FILE: join(dataDir, 'state.json'),
  }

  let child
  let spawnError
  let output = ''
  const appendOutput = chunk => {
    output += chunk
    if (output.length > 20000) output = output.slice(-20000)
  }

  try {
    child = spawn(process.execPath, [entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    child.once('error', error => {
      spawnError = error
    })

    const healthUrl = `http://127.0.0.1:${port}/health`
    const deadline = Date.now() + 15000
    let lastError = '尚未收到响应'

    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`自检失败：无法启动 server 进程：${spawnError.message}`)
      }
      if (child.exitCode !== null) {
        throw new Error(
          `自检失败：server 进程提前退出（退出码 ${child.exitCode}）。\n--- server 输出 ---\n${output}`
        )
      }

      try {
        const response = await fetch(healthUrl)
        const body = await response.text()
        if (response.status === 200 && body.includes('"status":"ok"')) {
          return body
        }
        lastError = `HTTP ${response.status}：${body}`
      } catch (error) {
        lastError = error.message
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }

    throw new Error(
      `自检失败：15 秒内未从 ${healthUrl} 收到健康的响应（最后错误：${lastError}）。\n` +
        `--- server 输出 ---\n${output}`
    )
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      // 等待进程退出，最多 3 秒，避免 finally 一直挂起。
      await new Promise(resolveExit => {
        const timer = setTimeout(resolveExit, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveExit()
        })
      })
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const healthBody = await runSelfCheck(outfile)

console.log(`产物路径: ${outfile}`)
console.log(`产物字节数: ${serverBytes.length}`)
console.log(`sha256: ${serverSha256}`)
console.log(`上游版本: ${upstreamVersion}`)
console.log(`自检结果: GET /health -> 200 ${healthBody}`)
