import net from 'node:net'
import type { SafeLogger } from '../logging.js'

export interface PortProxyOptions {
  /** 本机回环上的固定端口，客户端配置里写的就是它。 */
  listenPort: number
  /** 连接进来后转到的端口，即当前 DSH 实例的 Web 端口。 */
  targetPort: () => number | undefined
  logger: SafeLogger
}

export interface PortProxyHandle {
  port: number
  close(): Promise<void>
}

/**
 * 在本机回环的固定端口上做 TCP 反向代理，把每条连接整段转给当前 DSH Web 端口。
 *
 * Desktop 每次启动都换随机端口，客户端却想把端口一次配好。固定端口保留在配置里，
 * 实例换了端口之后由这里接住旧端口再转过去。只监听 127.0.0.1：不对外暴露，也不改
 * 动 Host 头，登录 cookie 的域与签名照常对得上。
 */
export async function startPortProxy(options: PortProxyOptions): Promise<PortProxyHandle> {
  const { listenPort, logger } = options
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    const target = options.targetPort()
    if (target === undefined) {
      client.destroy()
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port: target })
    upstream.setNoDelay(true)
    // 任何一侧断开都收掉另一侧，免得半开连接一直占着固定端口。
    upstream.on('error', (error: Error) => {
      logger.debug('port proxy upstream error', { port: target, message: error.message })
      client.destroy()
    })
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.end())
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      server.on('error', (error: Error) => logger.warn('port proxy error', { message: error.message }))
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(listenPort, '127.0.0.1')
  })
  logger.info('port proxy listening', { port: listenPort })
  return {
    port: listenPort,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
