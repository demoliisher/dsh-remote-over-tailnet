import { describe, expect, it } from 'vitest'
import { normalizeServerUrl, resolveConfig } from '../src/config.js'

describe('plugin config', () => {
  it('applies safe defaults', () => {
    expect(resolveConfig({}, {})).toMatchObject({
      enabled: true,
      service: { enabled: false },
      terminal: { enabled: true },
      sidebar: { entry: 'standard' },
      loopback: { ports: [] },
      tailnet: { enabled: true },
      forceRelay: false,
      rotatePinnedPeerKey: false,
      logLevel: 'info',
      reconnect: { enabled: true, initialDelayMs: 4_000, maxDelayMs: 30_000, jitter: 0.2 },
      codex: { enabled: true, binary: 'codex' },
    })
    expect(resolveConfig({}, { DSH_REMOTE_TERMINAL_ENABLED: 'false' }).terminal.enabled).toBe(false)
  })

  // SSH 模式默认关闭，避免没打算用的人多开一个监听；端口是 tailnet 内的虚拟端口，默认取 22 与 DSH Go 一致。
  it('keeps SSH off by default and validates its port when enabled', () => {
    expect(resolveConfig({}).ssh).toEqual({ enabled: false })
    expect(resolveConfig({ ssh: { enabled: true } }).ssh).toEqual({ enabled: true })
  })

  it('keeps the pinned DSH port and rejects values outside the port range', () => {
    expect(resolveConfig({ ssh: { enabled: true, pinnedPort: 51234 } }).ssh).toEqual({ enabled: true, pinnedPort: 51234 })
    expect(() => resolveConfig({ ssh: { enabled: true, pinnedPort: 0 } })).toThrow()
    expect(() => resolveConfig({ ssh: { enabled: true, pinnedPort: 70000 } })).toThrow()
  })

  it('rejects the removed Client-mode role and Remote Tools switches', () => {
    expect(() => resolveConfig({ role: 'client' } as never, {})).toThrow()
    expect(() => resolveConfig({ remoteTools: { enabled: false } } as never, {})).toThrow()
  })

  it('keeps Host control disabled by default while allowing an explicit opt-in', () => {
    expect(resolveConfig({}, {}).service.enabled).toBe(false)
    expect(resolveConfig({ service: { enabled: true } }, {}).service.enabled).toBe(true)
  })

  it('normalizes the loopback port list and the sidebar entry', () => {
    expect(resolveConfig({ loopback: { ports: [4100, 4101, 4100] } }).loopback.ports).toEqual([4100, 4101])
    expect(resolveConfig({ sidebar: { entry: 'compact' } }).sidebar.entry).toBe('compact')
    expect(resolveConfig({ sidebar: { entry: 'standard' } }).sidebar.entry).toBe('standard')
  })

  it('allows the default-on Codex domain to be disabled and rejects obsolete workspace filters', () => {
    expect(resolveConfig({ codex: { enabled: false } }, {})).toMatchObject({
      codex: { enabled: false, binary: 'codex' },
    })
    expect(resolveConfig({ codex: {
      enabled: true,
      binary: '/opt/codex/bin/codex',
    } }, {})).toMatchObject({
      codex: { enabled: true, binary: '/opt/codex/bin/codex' },
    })
    expect(() => resolveConfig({ codex: { enabled: true, allowedRoots: ['/workspace'] } } as never)).toThrow()
  })

  it('rejects removed external agent settings', () => {
    expect(() => resolveConfig({ cursor: { enabled: true } } as never, {})).toThrow()
    expect(() => resolveConfig({ acp: { enabled: true } } as never, {})).toThrow()
  })

  it('allows HTTP on private networks while rejecting insecure public servers and embedded credentials', () => {
    expect(() => resolveConfig({ serverUrl: 'http://remote.example.com' })).toThrow(/HTTPS/)
    expect(() => resolveConfig({ serverUrl: 'http://100.128.0.1:8080' })).toThrow(/HTTPS/)
    expect(() => resolveConfig({ serverUrl: 'https://user:password@remote.example.com' })).toThrow(/credentials/)
    expect(() => resolveConfig({ serverUrl: 'https://remote.example.com?token=secret' })).toThrow(/query parameters/)
    expect(() => resolveConfig({ serverUrl: 'https://remote.example.com/api' })).toThrow(/without a path/)
    expect(resolveConfig({ serverUrl: 'http://localhost:8080' }).serverUrl).toBe('http://localhost:8080')
    expect(resolveConfig({ serverUrl: 'http://192.168.1.20:8080' }).serverUrl).toBe('http://192.168.1.20:8080')
    expect(resolveConfig({ serverUrl: 'http://100.79.68.68:8080' }).serverUrl).toBe('http://100.79.68.68:8080')
    expect(resolveConfig({ serverUrl: 'http://[fd00:1234::1]:8080' }).serverUrl).toBe('http://[fd00:1234::1]:8080')
    expect(resolveConfig({ serverUrl: 'http://[fe80::1]:8080' }).serverUrl).toBe('http://[fe80::1]:8080')
    expect(() => resolveConfig({ serverUrl: 'http://[2001:4860:4860::8888]:8080' })).toThrow(/HTTPS/)
    expect(normalizeServerUrl('https://REMOTE.example.com/')).toBe('https://remote.example.com')
  })

  it('reads the server URL and device name from the environment', () => {
    expect(resolveConfig({}, { DSH_REMOTE_SERVER: 'http://127.0.0.1:8080/' }).serverUrl).toBe('http://127.0.0.1:8080')
    expect(resolveConfig({ serverUrl: 'http://localhost:9000' }, { DSH_REMOTE_SERVER: 'http://127.0.0.1:8080' }).serverUrl)
      .toBe('http://localhost:9000')
    expect(resolveConfig({}, { DSH_REMOTE_DEVICE_NAME: 'host-from-env' }).deviceName).toBe('host-from-env')
  })

  it('rejects an inverted reconnect range', () => {
    expect(() => resolveConfig({ reconnect: { initialDelayMs: 5_000, maxDelayMs: 1_000 } })).toThrow(/maxDelayMs/)
  })
})
