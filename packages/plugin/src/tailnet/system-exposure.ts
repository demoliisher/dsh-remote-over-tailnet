import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { SafeLogger } from '../logging.js'

/** tailnet 地址上的一个对外监听；关闭时断开其上所有连接。 */
export interface TailnetExposure {
  host: string
  port: number
  close(): Promise<void>
}

interface ListenOptions {
  host: string
  port: number
  logger: SafeLogger
  onConnection(socket: net.Socket): void
}

/** 在 tailnet 地址上监听一个端口；绑定失败时原样抛出，由编排层转成面板错误。 */
async function listen(options: ListenOptions): Promise<TailnetExposure> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', (error: Error) => {
      options.logger.debug('tailnet exposure socket error', { port: options.port, message: error.message })
      socket.destroy()
    })
    options.onConnection(socket)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      server.on('error', (error: Error) => options.logger.warn('tailnet exposure error', { port: options.port, message: error.message }))
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })
  options.logger.info('tailnet exposure listening', { host: options.host, port: options.port })
  return {
    host: options.host,
    port: options.port,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * 把 tailnet 上的一个端口转发到本机中继进程。
 *
 * 中继进程只监听回环地址，给本机 Host 用；远端客户端连的是这里的 tailnet 地址，
 * 每条连接由本代理整段转给回环上的中继进程。
 */
export async function exposeRelay(options: {
  host: string
  port: number
  targetPort: number
  logger: SafeLogger
}): Promise<TailnetExposure> {
  return listen({
    host: options.host,
    port: options.port,
    logger: options.logger,
    onConnection(socket) {
      const upstream = net.connect({ host: '127.0.0.1', port: options.targetPort })
      upstream.setNoDelay(true)
      upstream.on('error', (error: Error) => {
        options.logger.debug('tailnet relay upstream error', { port: options.targetPort, message: error.message })
        socket.destroy()
      })
      socket.on('close', () => upstream.destroy())
      upstream.on('close', () => socket.end())
      socket.pipe(upstream).pipe(socket)
    },
  })
}

/** 把 tailnet 上的 SSH 端口交给进程内的 SSH 服务处理，不经过任何本机端口。 */
export async function exposeSsh(options: {
  host: string
  port: number
  onConnection(socket: Duplex): void
  logger: SafeLogger
}): Promise<TailnetExposure> {
  return listen({
    host: options.host,
    port: options.port,
    logger: options.logger,
    onConnection(socket) {
      options.onConnection(socket)
    },
  })
}
