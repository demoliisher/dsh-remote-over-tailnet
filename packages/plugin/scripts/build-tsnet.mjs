import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, stat } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(root, 'tsnet-src')
const output = join(root, 'tsnet', 'tsnet.wasm')

async function newestSourceTime(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  let newest = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceTime(path))
    } else if (entry.name.endsWith('.go') || entry.name === 'go.mod' || entry.name === 'go.sum') {
      newest = Math.max(newest, (await stat(path)).mtimeMs)
    }
  }
  return newest
}

// 产物不入库，构建时按源文件时间戳判定是否需要重新编译，避免每次 tsc 都跑 Go。
const built = await stat(output).then(entry => entry.mtimeMs, () => 0)
if (built > (await newestSourceTime(sourceDirectory))) {
  console.log('内嵌节点无需重新编译。')
} else {
  // GOOS=js 让 tsnet 使用用户态网络，产物由 src/tailnet/embedded-node.ts 在 Node 里加载。
  // go.mod 必须位于 tailscale.com 域下，否则 tsnet 依赖的 internal 包不允许跨模块引用。
  const build = spawn('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, '.'], {
    cwd: sourceDirectory,
    env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
    stdio: 'inherit',
  })
  build.on('exit', code => {
    if (code !== 0) process.exit(code ?? 1)
    console.log('内嵌节点已编译：tsnet/tsnet.wasm')
  })
}
