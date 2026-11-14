import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 发布包由根 package.json 的 files 决定。内嵌节点是目录级资产、中继是预构建产物，
// 两者都不参与模块解析，tsc 与单元测试都不会发现缺席，所以这里直接检查打包结果。

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'index.js',
  'cordis.patch.yml',
  'dsh-plugin.json',
  'icon.png',
  'package.json',
  'README.md',
  'NOTICE',
  'packages/plugin/dist/index.js',
  'packages/plugin/dist/client.github.js',
  'packages/plugin/public.d.ts',
  'packages/plugin/server/version.json',
  'packages/plugin/tsnet/tsnet.wasm',
  'packages/plugin/tsnet/wasm_exec.js',
  'locale/en.json',
  'locale/zh.json',
]

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const report = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json'], {
  cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
}).trim())

const packed = new Set(report[0].files.map(file => file.path))
const missing = required.filter(path => !packed.has(path))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const relay = join(root, 'packages/plugin/server/dist/main.cjs')
const relayBuilt = await readFile(relay).then(() => true, () => false)
if (relayBuilt && !packed.has('packages/plugin/server/dist/main.cjs')) missing.push('packages/plugin/server/dist/main.cjs')

if (missing.length > 0) {
  console.error('发布包缺少以下文件：')
  for (const path of missing) console.error(`  - ${path}`)
  process.exit(1)
}
console.log(`发布包校验通过：${manifest.name}@${manifest.version}，${report[0].entryCount} 个文件，${report[0].size} 字节`)
if (!relayBuilt) console.log('注意：中继产物未构建，本次打包不含 packages/plugin/server/dist/main.cjs（发布前需先运行 pnpm build:server）。')
