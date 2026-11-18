import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeLogger } from '../src/logging.js'
import { startPortProxy } from '../src/tailnet/port-proxy.js'

const logger = new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} }, 'error')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected tcp address')
      resolve(address.port)
    })
  })
}

function close(server: net.Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()) })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  const port = await listen(server)
  await close(server)
  return port
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let received = ''
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      if (received.length >= text.length) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('connect', () => { socket.write(text) })
  })
}

// 回归：Desktop 每次启动换随机端口，面板固定的端口不能跟着失效。固定端口由插件接住，
// 新连接一律转给当前实例；实例端口没变时不起代理，两者不同才由这里转发。
describe('固定端口反向代理', () => {
  it('把固定端口上的连接转给当前实例，目标换了新连接跟着换', async () => {
    const first = net.createServer(socket => { socket.pipe(socket) })
    const firstPort = await listen(first)
    const second = net.createServer(socket => { socket.pipe(socket) })
    const secondPort = await listen(second)
    const listenPort = await freePort()
    let target = firstPort
    const proxy = await startPortProxy({ listenPort, targetPort: () => target, logger })
    cleanups.push(async () => {
      await proxy.close()
      await close(first)
      await close(second)
    })

    await expect(roundTrip(listenPort, 'first')).resolves.toBe('first')
    target = secondPort
    await expect(roundTrip(listenPort, 'second')).resolves.toBe('second')
  })

  it('关闭之后固定端口不再接受连接', async () => {
    const echo = net.createServer(socket => { socket.pipe(socket) })
    const echoPort = await listen(echo)
    const listenPort = await freePort()
    const proxy = await startPortProxy({ listenPort, targetPort: () => echoPort, logger })
    cleanups.push(async () => { await close(echo) })

    await expect(roundTrip(listenPort, 'open')).resolves.toBe('open')
    await proxy.close()
    await expect(roundTrip(listenPort, 'closed')).rejects.toThrow()
  })
})
