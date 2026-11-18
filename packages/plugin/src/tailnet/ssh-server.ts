import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { Server, utils } from 'ssh2'
import type { Connection } from 'ssh2'
import type { Duplex } from 'node:stream'
import type { SafeLogger } from '../logging.js'

export interface SshServerOptions {
  /** 主机密钥所在目录。 */
  directory: string
  /** 与 DSH Remote 共用的登录账号，面板上展示的就是同一个值。 */
  account: () => string
  /** 与 DSH Remote 共用的登录密码；改密码后认证立刻使用新值。 */
  password: () => string
  /** 允许转发的本机端口：固定端口时是本机代理，未固定时是当前 DSH Web 端口。 */
  targetPort: () => number | undefined
  logger: SafeLogger
}

/** 进程内的 SSH 服务：只做认证与到本机 DSH Web 端口的 direct-tcpip 转发。 */
export interface SshServerHandle {
  /** 主机密钥指纹，首次连接时供用户核对。 */
  fingerprint: string
  /** 接一条来自 tailnet 的连接。 */
  handleConnection(socket: Duplex): void
  /** 关闭全部连接。 */
  close(): Promise<void>
}

interface SshMaterial {
  /** OpenSSH 格式的 ed25519 私钥，ssh2 直接当 hostKeys 用。 */
  hostKey: string
  fingerprint: string
}

/** 读取或首次生成主机密钥；主机密钥只落在这台机器的插件数据目录里。 */
async function loadMaterial(directory: string): Promise<SshMaterial> {
  await mkdir(directory, { recursive: true })
  const keyPath = join(directory, 'host_ed25519')
  const hostKey = await readOrCreate(keyPath, () => utils.generateKeyPairSync('ed25519').private)
  return { hostKey, fingerprint: fingerprintOf(hostKey) }
}

async function readOrCreate(path: string, create: () => string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const value = create()
  await writeFile(path, value + '\n', { mode: 0o600 })
  return value
}

/** 主机密钥指纹：与 ssh-keygen -lf 的 SHA256 形式一致，便于用户对照。 */
export function fingerprintOf(privateKey: string): string {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  const digest = createHash('sha256').update(key.getPublicSSH()).digest('base64')
  return 'SHA256:' + digest.replace(/=+$/, '')
}

/** 定长比较，避免按字符提前返回泄漏密码前缀。 */
function sameSecret(expected: string, actual: string): boolean {
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(actual).digest()
  return timingSafeEqual(a, b)
}

/**
 * 启动进程内 SSH 服务。
 *
 * 服务端只接受密码认证，认证通过后只放行 direct-tcpip 通道，且目标必须是面板上显示的
 * DSH 端口。请求里的地址与端口对不上就拒绝，这条 SSH 能做的事被限制在「替 DSH Go
 * 打通到这一个实例的隧道」。session、sftp、agent 转发等通道全部拒绝。
 */
export async function startSshServer(options: SshServerOptions): Promise<SshServerHandle> {
  const material = await loadMaterial(options.directory)
  const clients = new Set<Connection>()
  const server = new Server({ hostKeys: [material.hostKey] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', (error: Error) => {
      options.logger.debug('ssh client error', { message: error.message })
    })
    // 账号与密码就是 DSH Remote 那一套：两个入口通向同一份权限，共用同一个秘密。
    client.on('authentication', (context) => {
      if (
        context.method !== 'password'
        || context.username !== options.account()
        || !sameSecret(options.password(), context.password)
      ) {
        context.reject(['password'])
        return
      }
      context.accept()
    })
    // session 通道（远端 shell、命令执行、sftp）一律不开；ssh2 对没监听的通道本来也会拒绝，
    // 这里显式拒绝，避免以后误加监听把 shell 暴露出去。
    client.on('session', (_accept, reject) => {
      reject()
    })
    client.on('tcpip', (accept, reject, info) => {
      const target = options.targetPort()
      // 只放行面板上显示的那个端口：固定端口时它是本机代理，未固定时它就是当前 DSH 实例。
      if (target === undefined || info.destPort !== target) {
        reject()
        return
      }
      options.logger.debug('ssh tunnel opened', { port: target })
      const channel = accept()
      const upstream = net.connect({ host: '127.0.0.1', port: target })
      upstream.setNoDelay(true)
      upstream.on('error', (error: Error) => {
        options.logger.debug('ssh tunnel upstream error', { message: error.message })
        channel.close()
      })
      upstream.on('close', () => channel.close())
      channel.on('close', () => upstream.destroy())
      channel.pipe(upstream).pipe(channel)
    })
  })
  options.logger.info('ssh server ready', { fingerprint: material.fingerprint })
  return {
    fingerprint: material.fingerprint,
    handleConnection(socket) {
      // ssh2 只把传入对象当双工流用（on/data/write/end/destroy），tailnet 侧送来的是桥接出来的 Duplex。
      server.injectSocket(socket as unknown as net.Socket)
    },
    async close() {
      for (const client of clients) client.end()
      clients.clear()
    },
  }
}
