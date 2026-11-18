import { rename, rm, stat, mkdir, open } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

/** wasm 资产发布在本仓库的专用分支；raw 是唯一下载通道，jsdelivr 暂不启用。 */
const RAW_BASE = 'https://raw.githubusercontent.com/demoliisher/dsh-remote-over-tailnet'
const WASM_BRANCH = 'wasm-dist'
const WASM_PATH = 'tsnet/tsnet.wasm'
const SOURCES = [`${RAW_BASE}/${WASM_BRANCH}/${WASM_PATH}`]

/** 扩展当前状态。 */
export type ExtensionState = 'absent' | 'downloading' | 'installed' | 'error'

export interface ExtensionInfo {
  state: ExtensionState
  /** wasm 落盘路径，只有已安装时有值。 */
  path?: string
  size?: number
  /** 下载进度，取值 0 到 100。 */
  progress?: number
  error?: string
}

/** 扩展存放路径：插件数据目录下独立的 extension 子目录。 */
export function extensionPath(dataDirectory: string): string {
  return join(dataDirectory, 'extension', 'tsnet.wasm')
}

/** 校验 wasm 文件头与体积，避免把错误页面当成功。 */
async function isUsableWasm(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size < 10 * 1024 * 1024) return false
    const handle = await open(path, 'r')
    try {
      const header = Buffer.alloc(4)
      await handle.read(header, 0, 4, 0)
      return header[0] === 0 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/** 读取已安装扩展的信息；文件缺失或损坏时按未安装处理。 */
export async function readExtensionInfo(dataDirectory: string): Promise<ExtensionInfo> {
  const path = extensionPath(dataDirectory)
  if (!await isUsableWasm(path)) return { state: 'absent' }
  const info = await stat(path)
  return { state: 'installed', path, size: info.size }
}

/**
 * 从 GitHub raw 下载 wasm 组件，写临时文件后原子改名到位。
 *
 * 下载失败时原样抛出，由编排层转成面板错误；临时文件一律清理，不留半截产物。
 * 用户强调过只走 raw，这里不引入任何镜像回退；等 wasm 精简到 20 MB 以下再考虑 jsdelivr。
 */
export async function downloadExtension(
  dataDirectory: string,
  onProgress?: (progress: number) => void,
): Promise<ExtensionInfo> {
  const target = extensionPath(dataDirectory)
  const temporary = target + '.download'
  await mkdir(join(dataDirectory, 'extension'), { recursive: true, mode: 0o700 })
  let lastError = ''
  for (const source of SOURCES) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length') ?? 0)
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('下载响应没有数据流')
      const file = createWriteStream(temporary, { mode: 0o600 })
      let received = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        received += chunk.length
        if (!file.write(chunk)) await new Promise<void>(resolve => file.once('drain', resolve))
        if (total > 0) onProgress?.(Math.min(99, Math.round(received / total * 100)))
      }
      await new Promise<void>((resolve, reject) => {
        file.once('error', reject)
        file.end(() => resolve())
      })
      if (!await isUsableWasm(temporary)) throw new Error('下载内容不是有效的 wasm 文件')
      await rename(temporary, target)
      onProgress?.(100)
      return { state: 'installed', path: target, size: received }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await rm(temporary, { force: true })
    }
  }
  throw new Error(`下载内嵌节点组件失败：${lastError}`)
}

/** 删除已下载的扩展，回到未安装状态。 */
export async function removeExtension(dataDirectory: string): Promise<void> {
  await rm(extensionPath(dataDirectory), { force: true })
}
