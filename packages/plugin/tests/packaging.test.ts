import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * 发布包由根 package.json 的 files 决定，内嵌节点是一个目录级资产而不是 import 进来的模块，
 * 所以 tsc 与单元测试都不会发现它缺席。这里守住两条：tsnet 目录必须随包发布，
 * 子包必须保持私有，否则发布包装上以后内嵌节点找不到 wasm，同名子包还会被一并发布。
 */
describe('publish layout', () => {
  it('ships the embedded node assets with the published package', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { files?: string[] }
    expect(manifest.files).toContain('packages/plugin/tsnet')
  })

  it('keeps the workspace copy private so only the root package is publishable', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { private?: boolean }
    expect(manifest.private).toBe(true)
  })
})
