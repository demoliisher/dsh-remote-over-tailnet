import { describe, expect, it } from 'vitest'
import { SSH_LISTEN_PORT, TAILNET_LISTEN_PORT, SYSTEM_RELAY_PORT, SYSTEM_SSH_PORT } from '../src/embedded-ports.js'

describe('端口常量', () => {
  it('内嵌模式用标准端口', () => {
    expect(TAILNET_LISTEN_PORT).toBe(80)
    expect(SSH_LISTEN_PORT).toBe(22)
  })

  // 系统模式对外改用高位端口，避免占用宿主机的 80 与 22。
  it('系统模式避开系统端口', () => {
    expect(SYSTEM_RELAY_PORT).toBe(8080)
    expect(SYSTEM_SSH_PORT).toBe(2222)
  })
});

// 只有 http + 回环地址才由插件起中继；https 与局域网地址都按外部服务器处理。
describe('tailnetRelayPort', () => {
  it('识别回环 http 地址的端口', async () => {
    const { tailnetRelayPort } = await import('../src/tailnet/orchestrator.js')
    expect(tailnetRelayPort('http://127.0.0.1:8080')).toBe(8080)
    expect(tailnetRelayPort('http://localhost:9000')).toBe(9000)
  })

  it('外部服务器地址返回 undefined', async () => {
    const { tailnetRelayPort } = await import('../src/tailnet/orchestrator.js')
    expect(tailnetRelayPort('https://127.0.0.1:8080')).toBeUndefined()
    expect(tailnetRelayPort('http://10.0.0.5:8080')).toBeUndefined()
    expect(tailnetRelayPort('http://127.0.0.1')).toBeUndefined()
    expect(tailnetRelayPort(undefined)).toBeUndefined()
  })
})

// 回归：对外地址曾经随中继端口写成 http://名字:8080。内嵌模式节点在 80 监听，
// publicUrlFor 必须保持无端口形式；系统模式的带端口地址由编排层 publicUrl 另行拼接。
describe('tailnet 对外地址', () => {
  it('去掉 DNSName 末尾的点并且不写端口', async () => {
    const { publicUrlFor } = await import('../src/tailnet/orchestrator.js')
    expect(publicUrlFor('dsh-remote.tail81eea4.ts.net.')).toBe('http://dsh-remote.tail81eea4.ts.net')
  })
})

// 回归：从系统模式切到内嵌模式时，新节点还没就绪，面板一度继续显示上一次系统模式的
// wsl.tail81eea4.ts.net 与 :8080，而 publicPort 已切到 80，地址与端口自相矛盾。
async function withOrchestrator(
  mode: 'system' | 'embedded',
  run: (orch: any) => void,
): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SafeLogger } = await import('../src/logging.js')
  const { resolveConfig } = await import('../src/config.js')
  const { TailnetOrchestrator } = await import('../src/tailnet/orchestrator.js')
  const root = await mkdtemp(join(tmpdir(), 'dsh-rot-mode-'))
  const sink = { debug() {}, info() {}, warn() {}, error() {} }
  try {
    const orch = new TailnetOrchestrator({
      config: resolveConfig({ serverUrl: 'http://127.0.0.1:8080', tailnet: { enabled: true, mode } }),
      logger: new SafeLogger(sink),
      defaultDataDirectory: () => root,
      packageRoot: root,
      pluginVersion: '0.0.0-test',
      webPort: () => 8787,
    })
    run(orch)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('切换组网模式清理旧地址', () => {
  it('重建节点时清掉上一次的域名、IPv4 与对外地址', async () => {
    await withOrchestrator('embedded', orch => {
      orch.state = {
        enabled: true, mode: 'embedded', phase: 'ready', publicPort: 80,
        dnsName: 'wsl.tail81eea4.ts.net', ipv4: '100.71.28.112',
        publicUrl: 'http://wsl.tail81eea4.ts.net:8080',
        extension: { state: 'absent' },
        steps: {
          node: { ok: true, detail: 'old' }, relay: { ok: null, detail: '' },
          listen: { ok: null, detail: '' }, authorize: { ok: null, detail: '' },
        },
        updatedAt: '',
      }
      orch.clearStaleAddress()
      const snap = orch.snapshot()
      expect(snap.dnsName).toBeUndefined()
      expect(snap.ipv4).toBeUndefined()
      expect(snap.publicUrl).toBeUndefined()
      expect(snap.publicPort).toBe(80)
    })
  })
})

describe('节点启动失败的步骤归类', () => {
  it('节点未就绪时记到 node，不误报到 relay', async () => {
    await withOrchestrator('embedded', orch => {
      orch.state = {
        enabled: true, mode: 'embedded', phase: 'probing', publicPort: 80,
        extension: { state: 'absent' },
        steps: {
          node: { ok: null, detail: '正在启动内嵌节点' },
          relay: { ok: null, detail: '未启动' },
          listen: { ok: null, detail: '未监听' },
          authorize: { ok: null, detail: '未授权' },
        },
        updatedAt: '',
      }
      orch.markFailedStep({ code: 'X', message: '内嵌节点启动超时' })
      const snap = orch.snapshot()
      expect(snap.steps.node.ok).toBe(false)
      expect(snap.steps.relay.ok).toBeNull()
    })
  })

  it('内嵌模式启动超时补上可操作的排查提示', async () => {
    await withOrchestrator('embedded', orch => {
      const info = orch.explainError(new Error('内嵌节点启动超时：仍未加入 tailnet'))
      expect(info.code).toBe('EMBEDDED_NODE_START_TIMEOUT')
      expect(info.message).toContain('controlplane.tailscale.com')
    })
  })
})
