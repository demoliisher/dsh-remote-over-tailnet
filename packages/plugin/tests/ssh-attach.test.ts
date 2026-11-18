import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeLogger } from '../src/logging.js'
import { startSshServer } from '../src/tailnet/ssh-server.js'
import type { SshServerHandle } from '../src/tailnet/ssh-server.js'

const logger = new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} }, 'error')
// 与 DSH Remote 共用的一套凭据：SSH 认证直接取这两个值。
const ACCOUNT = 'owner@dsh.local'
const PASSWORD = 'shared-relay-password'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Harness {
  ssh: SshServerHandle
  bridgePort: number
  echoPort: number
  directory: string
  shared: { account: string; password: string }
}

/** 起回显端口 + SSH 服务 + 转发入口，模拟 tailnet 送来的那条连接。 */
async function startHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-'))
  const echo = net.createServer(socket => { socket.pipe(socket) })
  const echoPort = await listen(echo)
  const shared = { account: ACCOUNT, password: PASSWORD }
  const ssh = await startSshServer({
    directory,
    account: () => shared.account,
    password: () => shared.password,
    targetPort: () => echoPort,
    logger,
  })
  const bridge = net.createServer(socket => { ssh.handleConnection(socket) })
  const bridgePort = await listen(bridge)
  cleanups.push(async () => {
    await ssh.close()
    await close(bridge)
    await close(echo)
    await rm(directory, { recursive: true, force: true })
  })
  return { ssh, bridgePort, echoPort, directory, shared }
}

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

function connect(port: number, username: string, password: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client))
    client.once('error', reject)
    client.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 5000 })
  })
}

function forward(client: Client, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 43210, '127.0.0.1', port, (error, channel) => {
      if (error) reject(error)
      else resolve(channel)
    })
  })
}

function read(channel: ClientChannel, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    channel.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.length >= expected.length) resolve(text)
    })
    channel.once('error', reject)
  })
}

// 回归：DSH Go 的「只连接」只需要密码认证加一条 direct-tcpip 通道，通道之外什么都拿不到。
describe('SSH 服务', () => {
  it('密码认证后把 direct-tcpip 转发到本机 DSH 端口', async () => {
    const harness = await startHarness()
    const client = await connect(harness.bridgePort, ACCOUNT, PASSWORD)
    const channel = await forward(client, harness.echoPort)
    const echoed = read(channel, 'ping')
    channel.write('ping')
    await expect(echoed).resolves.toBe('ping')
    channel.end()
    client.end()
  })

  it('主机密钥指纹重启后保持，格式与 ssh-keygen 一致', async () => {
    const harness = await startHarness()
    expect(harness.ssh.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    const reopened = await startSshServer({
      directory: harness.directory,
      account: () => harness.shared.account,
      password: () => harness.shared.password,
      targetPort: () => harness.echoPort,
      logger,
    })
    expect(reopened.fingerprint).toBe(harness.ssh.fingerprint)
    await reopened.close()
  })

  // 回归：账号密码与 DSH Remote 共用一套，面板改完密码后认证立即生效，旧密码随之失效。
  it('账号密码取共享凭据的当前值，改后无需重启服务', async () => {
    const harness = await startHarness()
    harness.shared.password = 'another-shared-password'
    const client = await connect(harness.bridgePort, ACCOUNT, harness.shared.password)
    client.end()
    await expect(connect(harness.bridgePort, ACCOUNT, PASSWORD)).rejects.toThrow(/authentication/i)
  })

  it('用户名与共享账号不一致时拒绝认证', async () => {
    const harness = await startHarness()
    await expect(connect(harness.bridgePort, 'someone-else', PASSWORD)).rejects.toThrow(/authentication/i)
  })

  it('密码错误时拒绝认证', async () => {
    const harness = await startHarness()
    await expect(connect(harness.bridgePort, ACCOUNT, 'wrong-password')).rejects.toThrow(/authentication/i)
  })

  it('拒绝远端 shell 通道', async () => {
    const harness = await startHarness()
    const client = await connect(harness.bridgePort, ACCOUNT, PASSWORD)
    client.on('error', () => undefined)
    const failure = await new Promise<string>((resolve, reject) => {
      client.exec('whoami', error => {
        if (error) resolve(error.message)
        else reject(new Error('exec should be rejected'))
      })
    })
    expect(failure).toContain('Channel open failure')
    client.end()
  })

  // 回归：客户端填的端口与服务端认定的端口不一致就拒绝，这条隧道不能拿去访问别的本机端口。
  it('拒绝转发到面板端口之外的目标端口', async () => {
    const harness = await startHarness()
    const client = await connect(harness.bridgePort, ACCOUNT, PASSWORD)
    await expect(forward(client, harness.echoPort + 1)).rejects.toThrow(/Channel open failure/)
    client.end()
  })
})
