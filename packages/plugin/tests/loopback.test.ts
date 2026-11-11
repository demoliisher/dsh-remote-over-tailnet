import { runScenarios, scenarioName } from '../../../scripts/test-scenarios.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { LoopbackHost } from '../src/loopback-host.js'
import type { LoopbackRead } from '@dsh-remote/protocol'

const cleanup: Array<() => void | Promise<void>> = []
const cleanupScenario1 = async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
}
afterEach(cleanupScenario1)
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}
function host(ports: number[]) { const h = new LoopbackHost(() => ports); cleanup.push(() => h.closeAll()); return h }

describe('restricted loopback HTTP / WebSocket preview', () => {
  it('denies unlisted ports, arbitrary hosts, absolute URLs and cross-peer handles', async () => {
    const h = host([])
    const base = { op: 'http.open', id: randomUUID(), port: 5173, path: '/', method: 'GET', headers: [] }
    await expect(h.call(base)).rejects.toMatchObject({ code: 'LOOPBACK_PORT_DENIED' })
    await expect(h.call({ ...base, host: '169.254.169.254' })).rejects.toThrow()
    for (const path of ['//other/', 'http://other/', '/\r\nheader', '/\\other']) await expect(h.call({ ...base, path })).rejects.toThrow()
    await expect(h.call({ op: 'http.read', id: randomUUID() })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
  })
  it('streams large responses in bounded chunks without following redirects', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 7, 91)
    const port = await listen(createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return }
      res.end(data)
    }))
    const h = host([port]); const id = randomUUID()
    expect(await h.call({ op: 'http.open', id, port, path: '/', method: 'GET', headers: [] })).toMatchObject({ status: 200 })
    const chunks: Buffer[] = []
    while (true) {
      const value = await h.call({ op: 'http.read', id }) as LoopbackRead
      const bytes = Buffer.from(value.data, 'base64'); expect(bytes.length).toBeLessThanOrEqual(65536); chunks.push(bytes)
      if (value.done) break
    }
    expect(Buffer.concat(chunks).equals(data)).toBe(true)
    expect(await h.call({ op: 'http.open', id: randomUUID(), port, path: '/redirect', method: 'GET', headers: [] })).toMatchObject({ status: 302 })
  })
  it('revokes HTTP handles and pending reads while keeping allowed ports usable', async () => {
    const revoked = createServer((_req, res) => { res.writeHead(200); res.flushHeaders() })
    const sockets = new Set<import('node:net').Socket>()
    revoked.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    const revokedPort = await listen(revoked)
    const keptPort = await listen(createServer((_req, res) => res.end('still allowed')))
    const h = host([revokedPort, keptPort])
    const id = randomUUID(); const keptId = randomUUID()
    const open = { op: 'http.open', id, port: revokedPort, path: '/', method: 'GET', headers: [] }
    await h.call(open)
    await h.call({ ...open, id: keptId, port: keptPort })
    let outcome: unknown
    void h.call({ op: 'http.read', id }).then(value => { outcome = value }, error => { outcome = error })
    h.setPorts([keptPort])
    await vi.waitFor(() => {
      expect(sockets.size).toBe(0)
      expect(outcome).toMatchObject({ code: 'LOOPBACK_READ_FAILED' })
    })
    await expect(h.call({ op: 'http.read', id })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
    await expect(h.call({ ...open, id: randomUUID() })).rejects.toMatchObject({ code: 'LOOPBACK_PORT_DENIED' })
    expect(Buffer.from((await h.call({ op: 'http.read', id: keptId }) as LoopbackRead).data, 'base64').toString()).toBe('still allowed')
    h.setPorts([])
    await expect(h.call({ op: 'http.read', id: keptId })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
    h.setPorts([revokedPort])
    await expect(h.call({ op: 'http.read', id })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
    await expect(h.call({ ...open, id: randomUUID() })).resolves.toMatchObject({ status: 200 })
  })
  it('terminates revoked WebSockets and wakes pending reads without waiting for their timeout', async () => {
    const server = createServer()
    const upstream = new WebSocketServer({ server })
    const port = await listen(server)
    cleanup.push(() => { for (const socket of upstream.clients) socket.terminate(); upstream.close() })
    const h = host([port]); const id = randomUUID()
    const open = { op: 'ws.open', id, port, path: '/', headers: [], protocols: [] }
    await h.call(open)
    let outcome: unknown
    void h.call({ op: 'ws.read', id }).then(value => { outcome = value }, error => { outcome = error })
    h.setPorts([])
    await vi.waitFor(() => {
      expect(upstream.clients.size).toBe(0)
      expect(outcome).toEqual({ messages: [], closed: true })
    })
    await expect(h.call({ op: 'ws.send', id, data: Buffer.from('denied').toString('base64'), binary: false }))
      .rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
    h.setPorts([port])
    await expect(h.call({ op: 'ws.read', id })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
    await h.call({ ...open, id: randomUUID() })
    expect(upstream.clients.size).toBe(1)
  })
  it('cancels pending HTTP and WebSocket opens when their ports are revoked', async () => {
    const rows = ['http', 'ws'] as const
    await runScenarios(
      rows.map((row, index) => {
        const kind = row
        return {
          name: scenarioName('cancels a pending %s open when its port is revoked', row, index),
          run: async () => {
            const server = createServer()
            const sockets = new Set<import('node:net').Socket>()
            server.on('connection', (socket) => {
              sockets.add(socket)
              socket.on('close', () => sockets.delete(socket))
            })
            const port = await listen(server)
            server.on('upgrade', (_req, socket) => {
              socket.on('end', () => socket.destroy())
              socket.resume()
            })
            cleanup.push(() => {
              for (const socket of sockets) socket.destroy()
            })
            const h = host([port])
            const id = randomUUID()
            const arrived = once(server, kind === 'http' ? 'request' : 'upgrade')
            let outcome: unknown
            void h
              .call(
                kind === 'http'
                  ? { op: 'http.open', id, port, path: '/', method: 'GET', headers: [] }
                  : { op: 'ws.open', id, port, path: '/', headers: [], protocols: [] },
              )
              .then(
                (value) => {
                  outcome = value
                },
                (error) => {
                  outcome = error
                },
              )
            await arrived
            h.setPorts([])
            await vi.waitFor(() => {
              expect(outcome).toMatchObject({ code: 'LOOPBACK_UNAVAILABLE' })
              expect(sockets.size).toBe(0)
            })
            await expect(h.call({ op: kind === 'http' ? 'http.read' : 'ws.read', id })).rejects.toMatchObject({
              code: 'LOOPBACK_CLOSED',
            })
          },
        }
      }),
      async () => {
        await cleanupScenario1()
      },
    )
  })
  it('protects reused HTTP and WebSocket handles from late revoked reads', async () => {
    const rows = ['http', 'ws'] as const
    await runScenarios(
      rows.map((row, index) => {
        const kind = row
        return {
          name: scenarioName('does not close a reused %s id when a revoked read settles', row, index),
          run: async () => {
            const server = createServer((req, res) => {
              res.writeHead(200)
              if (req.url === '/replacement') res.end('replacement')
              else res.flushHeaders()
            })
            const upstream = new WebSocketServer({ server })
            const port = await listen(server)
            cleanup.push(() => {
              for (const socket of upstream.clients) socket.terminate()
              upstream.close()
            })
            const h = host([port])
            const id = randomUUID()
            const open =
              kind === 'http'
                ? { op: 'http.open', id, port, path: '/', method: 'GET', headers: [] }
                : { op: 'ws.open', id, port, path: '/', headers: [], protocols: [] }
            await h.call(open)
            const oldRead = h
              .call({ op: kind === 'http' ? 'http.read' : 'ws.read', id })
              .catch((error) => error)
            h.setPorts([])
            h.setPorts([port])
            await h.call({ ...open, path: '/replacement' })
            await oldRead
            if (kind === 'http') {
              expect(
                Buffer.from(
                  ((await h.call({ op: 'http.read', id })) as LoopbackRead).data,
                  'base64',
                ).toString(),
              ).toBe('replacement')
            } else {
              await expect(h.call({ op: 'ws.send', id, data: '', binary: false })).resolves.toEqual({
                sent: true,
              })
            }
          },
        }
      }),
      async () => {
        await cleanupScenario1()
      },
    )
  })
})
