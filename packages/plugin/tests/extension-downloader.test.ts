import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

// 回归：下载 URL 与发布脚本的路径、分支必须一致，否则组件发布后插件下载不到。
describe('wasm 扩展下载源与发布源一致', () => {
  it('下载器与发布脚本使用同一分支与路径', async () => {
    const downloader = await readFile(join(pluginRoot, 'src/tailnet/extension-downloader.ts'), 'utf8')
    const publisher = await readFile(join(pluginRoot, 'scripts/publish-wasm.mjs'), 'utf8')
    expect(downloader).toContain("const WASM_BRANCH = 'wasm-dist'")
    expect(downloader).toContain("const WASM_PATH = 'tsnet/tsnet.wasm'")
    expect(publisher).toContain("const branch = 'wasm-dist'")
    expect(publisher).toContain("const targetPath = 'tsnet/tsnet.wasm'")
  })

  it('发布脚本使用 GitHub raw 域名', async () => {
    const downloader = await readFile(join(pluginRoot, 'src/tailnet/extension-downloader.ts'), 'utf8')
    expect(downloader).toContain('raw.githubusercontent.com')
  })
})
