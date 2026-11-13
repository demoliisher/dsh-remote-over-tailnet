import fs from 'node:fs'
import net from 'node:net'
import type { Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Go 侧 dshTsnet.status() 返回的节点状态。 */
export interface TsnetNodeStatus {
  backendState?: string
  authURL?: string
  dnsName?: string
  hostName?: string
  tailscaleIPs?: string[]
  online?: boolean
  health?: string[]
  running?: boolean
  error?: string
  version?: string
}

/** 启动节点的参数，与 tsnet-src/main.go 的 startOptions 对应。 */
export interface TsnetNodeOptions {
  /** 节点状态目录，Tailscale 的密钥与数据库写在这里。 */
  dir: string
  /** 节点在 tailnet 里的名称。 */
  hostname: string
  /** 预授权密钥；留空走交互式授权链接。 */
  authKey?: string
  /** 控制平面地址，默认官方 controlplane。 */
  controlUrl?: string
  /** 临时节点：退出后在控制平面自动注销。 */
  ephemeral?: boolean
}

/** 内嵌节点：在插件进程内运行 wasm 版 tsnet。 */
export interface TsnetNode {
  start(options: TsnetNodeOptions): Promise<TsnetNodeStatus>
  status(): TsnetNodeStatus
  /** 在 tailnet 上监听 tailPort，把每个入站连接转发到 127.0.0.1:targetPort。 */
  listen(tailPort: number, targetPort: number): Promise<number>
  /** 经节点自己的 HTTP 客户端访问 url，用于确认监听链路可用。 */
  probe(url: string): Promise<{ status: number; body: string }>
  close(): Promise<void>
}

/** Go 运行时注册在 globalThis 上的桥对象。 */
interface DshTsnetBridge {
  start(json: string): Promise<TsnetNodeStatus | string>
  status(): TsnetNodeStatus
  listen(tailPort: number, targetPort: number): Promise<string | number>
  probe(url: string): Promise<{ status: number; body: string } | string>
  close(): string | null
  /** 把本机 socket 读到的字节交给 Go 侧连接；返回 false 表示队列已满。 */
  inbound(id: number, chunk: Uint8Array): boolean
  /** Go 侧连接把积压数据写完，本机 socket 可以继续读取。 */
  drain(id: number): void
  /** 本机 socket 已关闭。 */
  closed(id: number): void
}

/** Go js/wasm 运行时的 fs 接口，只声明本桥实现的部分。 */
type WasmFileSystem = Record<string, unknown>

interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<unknown>
}

interface NodeGlobals {
  Go?: new () => GoRuntime
  fs?: WasmFileSystem
  path?: { resolve: (...segments: string[]) => string }
  dshTsnet?: DshTsnetBridge
  dshNet?: {
    dial(id: number, host: string, port: number): boolean
    send(id: number, chunk: Uint8Array): boolean
    resume(id: number): void
    close(id: number): void
  }
}

const globals = globalThis as unknown as NodeGlobals

/** 一个进程只能 go.run 一次，节点启停复用同一个运行时。 */
let runtimePromise: Promise<DshTsnetBridge> | undefined

/** tsnet 资产目录：与 dist 同级，打包时随插件一起发布。 */
function nodeAssets(packageRoot: string): { wasm: string; exec: string } {
  return { wasm: join(packageRoot, 'tsnet', 'tsnet.wasm'), exec: join(packageRoot, 'tsnet', 'wasm_exec.js') }
}


/**
 * 为 Go 的 js/wasm 运行时提供基于 node:fs 的文件系统实现。
 *
 * wasm_exec.js 在缺少 globalThis.fs 时只安装 stdout 桩，其余文件操作全部返回 ENOSYS，
 * tsnet 的状态存储、目录创建与日志写入都会失败，因此必须在加载 wasm_exec.js 之前安装本实现。
 */
function installFileSystem(): void {
  const C = fs.constants
  const statObject = (st: fs.Stats): Record<string, unknown> => ({
    dev: st.dev ?? 0,
    ino: st.ino ?? 0,
    mode: st.mode ?? 0,
    nlink: st.nlink ?? 1,
    uid: st.uid ?? 0,
    gid: st.gid ?? 0,
    rdev: st.rdev ?? 0,
    size: st.size ?? 0,
    blksize: st.blksize ?? 4096,
    blocks: st.blocks ?? 0,
    atimeMs: st.atimeMs ?? 0,
    mtimeMs: st.mtimeMs ?? 0,
    ctimeMs: st.ctimeMs ?? 0,
    isDirectory: () => st.isDirectory(),
    isFile: () => st.isFile(),
    isSocket: () => false,
  })
  globals.fs = {
    constants: {
      O_WRONLY: C.O_WRONLY,
      O_RDWR: C.O_RDWR,
      O_CREAT: C.O_CREAT,
      O_TRUNC: C.O_TRUNC,
      O_APPEND: C.O_APPEND,
      O_EXCL: C.O_EXCL,
      O_DIRECTORY: C.O_DIRECTORY ?? -1,
    },
    open(path: string, flags: string, mode: number, cb: (error: unknown, fd?: number) => void) {
      try {
        cb(null, fs.openSync(path, flags, mode))
      } catch (error) {
        cb(error)
      }
    },
    close(fd: number, cb: (error: unknown) => void) {
      try {
        fs.closeSync(fd)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    // wasm_exec.js 的 runtime.wasmWrite 直接调用 writeSync，缺了它会在第一次写 stdout 时崩溃。
    writeSync(fd: number, buf: Uint8Array): number {
      return fs.writeSync(fd, buf)
    },
    readSync(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null): number {
      return fs.readSync(fd, buf, offset, length, position === null ? null : Number(position))
    },
    read(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: (error: unknown, n?: number) => void) {
      try {
        cb(null, fs.readSync(fd, buf, offset, length, position === null ? null : Number(position)))
      } catch (error) {
        cb(error)
      }
    },
    write(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: (error: unknown, n?: number) => void) {
      try {
        cb(null, fs.writeSync(fd, buf, offset, length, position === null ? null : Number(position)))
      } catch (error) {
        cb(error)
      }
    },
    fstat(fd: number, cb: (error: unknown, st?: Record<string, unknown>) => void) {
      try {
        cb(null, statObject(fs.fstatSync(fd)))
      } catch (error) {
        cb(error)
      }
    },
    stat(path: string, cb: (error: unknown, st?: Record<string, unknown>) => void) {
      try {
        cb(null, statObject(fs.statSync(path)))
      } catch (error) {
        cb(error)
      }
    },
    lstat(path: string, cb: (error: unknown, st?: Record<string, unknown>) => void) {
      try {
        cb(null, statObject(fs.lstatSync(path)))
      } catch (error) {
        cb(error)
      }
    },
    mkdir(path: string, perm: number, cb: (error: unknown) => void) {
      try {
        fs.mkdirSync(path, { mode: perm })
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    rmdir(path: string, cb: (error: unknown) => void) {
      try {
        fs.rmdirSync(path)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    unlink(path: string, cb: (error: unknown) => void) {
      try {
        fs.unlinkSync(path)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    rename(from: string, to: string, cb: (error: unknown) => void) {
      try {
        fs.renameSync(from, to)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    chmod(path: string, mode: number, cb: (error: unknown) => void) {
      try {
        fs.chmodSync(path, mode)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    fchmod(fd: number, mode: number, cb: (error: unknown) => void) {
      try {
        fs.fchmodSync(fd, mode)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    fsync(fd: number, cb: (error: unknown) => void) {
      try {
        fs.fsyncSync(fd)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    ftruncate(fd: number, length: number, cb: (error: unknown) => void) {
      try {
        fs.ftruncateSync(fd, Number(length))
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    truncate(path: string, length: number, cb: (error: unknown) => void) {
      try {
        fs.truncateSync(path, Number(length))
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    utimes(path: string, atime: number, mtime: number, cb: (error: unknown) => void) {
      try {
        fs.utimesSync(path, Number(atime), Number(mtime))
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    readdir(path: string, cb: (error: unknown, entries?: string[]) => void) {
      try {
        cb(null, fs.readdirSync(path))
      } catch (error) {
        cb(error)
      }
    },
    readlink(path: string, cb: (error: unknown, target?: string) => void) {
      try {
        cb(null, fs.readlinkSync(path))
      } catch (error) {
        cb(error)
      }
    },
    symlink(target: string, linkPath: string, cb: (error: unknown) => void) {
      try {
        fs.symlinkSync(target, linkPath)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    link(existing: string, newPath: string, cb: (error: unknown) => void) {
      try {
        fs.linkSync(existing, newPath)
        cb(null)
      } catch (error) {
        cb(error)
      }
    },
    // 用户与调度器不在 wasm 里运行，权限变更没有实际作用，直接忽略。
    chown(_path: string, _uid: number, _gid: number, cb: (error: unknown) => void) {
      cb(null)
    },
    lchown(_path: string, _uid: number, _gid: number, cb: (error: unknown) => void) {
      cb(null)
    },
  }
  // Go 只在缺失时补一个极简 path.resolve，Windows 盘符路径会拼错，这里直接给出 Node 的实现。
  globals.path = globals.path ?? { resolve: (...segments: string[]) => resolvePath(...segments) }
}

/**
 * Go 侧的监听器无法自己拨号到 127.0.0.1，数据面经由此对象在 JS 与 Go 之间往返：
 * 每个入站连接由 Go 调用 dial 建立本地 socket，随后双向搬运字节。
 */
function installNetBridge(): void {
  const sockets = new Map<number, Socket>()
  globals.dshNet = {
    dial(id, host, port) {
      const socket = net.connect({ host, port })
      sockets.set(id, socket)
      socket.setNoDelay(true)
      socket.on('data', (chunk: Buffer) => {
        // Go 的入站队列满时返回 false，这里暂停读取等 Go 侧 drain 再继续。
        const accepted = globals.dshTsnet?.inbound(id, chunk)
        if (accepted === false) socket.pause()
      })
      socket.on('drain', () => {
        globals.dshTsnet?.drain(id)
      })
      socket.on('close', () => {
        sockets.delete(id)
        globals.dshTsnet?.closed(id)
      })
      socket.on('error', () => {
        socket.destroy()
      })
      return true
    },
    send(id, chunk) {
      const socket = sockets.get(id)
      if (socket === undefined || socket.destroyed) return false
      // Go 传来的 Uint8Array 是 wasm 线性内存的视图，必须复制后再交给 Node，
      // 否则后续内存增长或复用会改写待发送的数据。
      return socket.write(Buffer.from(chunk))
    },
    resume(id) {
      const socket = sockets.get(id)
      if (socket !== undefined && !socket.destroyed) socket.resume()
    },
    close(id) {
      const socket = sockets.get(id)
      if (socket === undefined) return
      sockets.delete(id)
      socket.destroy()
    },
  }
}

/** 加载并启动 Go 运行时，返回注册在 globalThis 上的桥对象。 */
async function loadRuntime(packageRoot: string): Promise<DshTsnetBridge> {
  const assets = nodeAssets(packageRoot)
  installFileSystem()
  installNetBridge()
  if (globals.Go === undefined) {
    await import(pathToFileURL(assets.exec).href)
  }
  const goConstructor = globals.Go
  if (goConstructor === undefined) throw new Error('wasm_exec.js 未注册 Go 运行时')
  const compiled = await WebAssembly.compile(await readFile(assets.wasm))
  const go = new goConstructor()
  const instance = await WebAssembly.instantiate(compiled, go.importObject)
  // Go 的 main 永远不会返回，run 的 Promise 只在 wasm 崩溃时结算，此处只记录异常。
  void go.run(instance).catch((error: unknown) => {
    console.error('[tsnet] Go 运行时异常：', error)
  })
  const deadline = Date.now() + 15000
  while (globals.dshTsnet === undefined) {
    if (Date.now() > deadline) throw new Error('内嵌节点启动超时：dshTsnet 未注册')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  return globals.dshTsnet
}

/** 取回（必要时启动）进程内唯一的节点运行时。 */
function getRuntime(packageRoot: string): Promise<DshTsnetBridge> {
  runtimePromise ??= loadRuntime(packageRoot)
  return runtimePromise
}

/**
 * 连接内嵌节点。
 *
 * 节点运行在插件的 Node 进程里：WASM 版 tsnet 提供 WireGuard 与 netstack，
 * 入站连接经由主桥接对象转发到本机中继端口，因此整套链路不依赖系统安装的 Tailscale 客户端。
 */
export async function connectEmbeddedNode(packageRoot: string): Promise<TsnetNode> {
  const bridge = await getRuntime(packageRoot)
  const fail = (value: string | null | undefined): string => String(value ?? '内嵌节点操作失败')
  return {
    async start(options) {
      const result = await bridge.start(JSON.stringify({
        dir: options.dir,
        hostname: options.hostname,
        authKey: options.authKey ?? '',
        controlURL: options.controlUrl ?? '',
        ephemeral: options.ephemeral ?? false,
      }))
      if (typeof result === 'string') throw new Error(result)
      return result
    },
    status() {
      return bridge.status()
    },
    async listen(tailPort, targetPort) {
      const result = await bridge.listen(tailPort, targetPort)
      if (typeof result === 'string') throw new Error(fail(result))
      return Number(result)
    },
    async probe(url) {
      const result = await bridge.probe(url)
      if (typeof result === 'string') throw new Error(fail(result))
      return result
    },
    async close() {
      const error = bridge.close()
      if (error !== null) throw new Error(fail(error))
    },
  }
}
