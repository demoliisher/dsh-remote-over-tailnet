import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wasm = join(root, 'tsnet', 'tsnet.wasm')
const branch = 'wasm-dist'
const remote = 'origin'

// 发布路径必须与 extension-downloader.ts 的 RAW_BASE / WASM_BRANCH / WASM_PATH 一致，
// 否则插件下载不到组件。改这里就要改那边。
const targetPath = 'tsnet/tsnet.wasm'

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' 失败：' + (result.stderr || result.stdout || '').trim())
  }
  return result.stdout.trim()
}

const info = await stat(wasm)
console.log('待发布 wasm：' + (info.size / 1000 / 1000).toFixed(1) + ' MB')

// 用独立 worktree 把编译产物提交到 wasm-dist 分支，避免污染当前工作区与源码分支。
const worktree = join(root, '.scratch', 'wasm-dist-publish')
git(['worktree', 'prune'])
const existing = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
if (existing.stdout.includes(worktree)) git(['worktree', 'remove', '--force', worktree])
// 远端已有该分支就从远端建，首次发布则用孤儿分支从零开始。
const hasRemote = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + branch], { cwd: root }).status === 0
if (hasRemote) git(['worktree', 'add', '--force', '-B', branch, worktree, remote + '/' + branch])
else git(['worktree', 'add', '--force', '--orphan', '-b', branch, worktree])

try {
  const { copyFile, mkdir } = await import('node:fs/promises')
  await mkdir(join(worktree, 'tsnet'), { recursive: true })
  await copyFile(wasm, join(worktree, targetPath))
  git(['-C', worktree, 'add', targetPath])
  // 没有变化时 diff --cached --quiet 返回 0，跳过空提交。
  const changed = spawnSync('git', ['-C', worktree, 'diff', '--cached', '--quiet'], { encoding: 'utf8' })
  if (changed.status !== 0) git(['-C', worktree, 'commit', '-m', 'chore: 发布 wasm 内嵌节点组件'])
  git(['-C', worktree, 'push', remote, branch])
  await readFile(join(worktree, targetPath))
  console.log('已发布到 ' + remote + '/' + branch + ':' + targetPath)
} finally {
  git(['worktree', 'remove', '--force', worktree])
}
