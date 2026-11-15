import { hostname } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlResult } from '../src/control-result.js'
import { resolveConfig, type Config } from '../src/config.js'
import { CONTROL_RPC_PREFIX } from '../src/control-route.js'
import { PluginControlRuntime, type HostControl, type PluginSettingsBinding } from '../src/control-runtime.js'
import { IdentityInvalidError } from '../src/identity-store.js'
import type { HostRemoteStatus } from '../src/service.js'
import type { TailnetControl, TailnetSnapshot } from '../src/tailnet/orchestrator.js'

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('PluginControlRuntime settings', () => {
  it('persists development switches and forwards them to the running Host', async () => {
    const settings = settingsBinding({ terminal: { enabled: false }, logLevel: 'warn' })
    const setTerminalEnabled = vi.fn()
    const setLoopbackPorts = vi.fn()
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub({ setTerminalEnabled, setLoopbackPorts })))

    expect(await handler('settings.development.set', { debugLogging: true, terminalEnabled: true, ports: [4100, 4100] }, signal()))
      .toMatchObject({ ok: true })
    expect(settings.get()).toMatchObject({ logLevel: 'debug', terminal: { enabled: true }, loopback: { ports: [4100] } })
    expect(setTerminalEnabled).toHaveBeenCalledWith(true)
    expect(setLoopbackPorts).toHaveBeenCalledWith([4100, 4100])

    expect(await handler('settings.development.set', { debugLogging: false }, signal())).toMatchObject({ ok: true })
    expect(settings.get().logLevel).toBe('info')
    expect(await handler('settings.development.set', {}, signal()))
      .toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    expect(await handler('settings.development.set', { debugLogging: 'true' }, signal()))
      .toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    expect(await handler('settings.development.set', { terminalEnabled: 'yes' }, signal()))
      .toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    expect(await handler('settings.development.set', { ports: [1.5] }, signal()))
      .toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })

    const unwritable = register(new PluginControlRuntime(resolveConfig({}), undefined, hostStub()))
    expect(await unwritable('settings.development.set', { debugLogging: true }, signal()))
      .toMatchObject({ ok: false, error: { details: { remoteCode: 'SETTINGS_UNAVAILABLE' } } })
  })

  it('persists the sidebar appearance and rejects unknown entries', async () => {
    const settings = settingsBinding({})
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub()))

    const compact = await handler('settings.appearance.set', { sidebarEntry: 'compact' }, signal())
    expect(compact).toMatchObject({ ok: true, value: { config: { sidebar: { entry: 'compact' } } } })
    expect(settings.get().sidebar).toEqual({ entry: 'compact' })
    await expect(handler('settings.appearance.set', { sidebarEntry: 'standard' }, signal()))
      .resolves.toMatchObject({ ok: true, value: { config: { sidebar: { entry: 'standard' } } } })
    await expect(handler('settings.appearance.set', { sidebarEntry: 'wide' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
  })

  it('exposes the editable config view with device name, writability and startup errors', async () => {
    const settings = settingsBinding({ serverUrl: 'https://relay.example.test', codex: { enabled: false } })
    const control = new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub())
    const handler = register(control)

    const view = await handler('settings.get', {}, signal())
    expect(view).toMatchObject({
      ok: true,
      value: {
        deviceName: hostname(),
        writable: true,
        config: {
          enabled: true,
          serverUrl: 'https://relay.example.test',
          service: { enabled: true },
          codex: { enabled: false, binary: 'codex' },
          tailnet: { enabled: true },
        },
      },
    })
    const config = (view as { ok: true; value: { config: Config } }).value.config
    expect(config).not.toHaveProperty('role')
    expect(config).not.toHaveProperty('remoteTools')

    const unwritable = register(new PluginControlRuntime(resolveConfig({}), undefined, undefined))
    await expect(unwritable('settings.get', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: { writable: false, config: { enabled: true } },
    })

    control.setStartupFailure(new IdentityInvalidError('device public and private keys do not match'))
    await expect(handler('settings.get', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: { startupError: { code: 'IDENTITY_INVALID', message: 'device public and private keys do not match' } },
    })
    await expect(handler('status', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: {
        deviceName: hostname(),
        serviceAvailable: false,
        startupError: { code: 'IDENTITY_INVALID', message: 'device public and private keys do not match' },
      },
    })
    expect(hostname()).toBeTruthy()
  })
})

describe('PluginControlRuntime device name', () => {
  it('persists the name and re-registers the Host through the ready relay', async () => {
    const settings = settingsBinding({ serverUrl: 'https://relay.example.test' })
    let currentName = 'demoliisher'
    const renameHost = vi.fn(async (deviceName: string) => {
      currentName = deviceName
      return hostStatus({ deviceName })
    })
    const tailnet = tailnetStub({ snapshot: tailnetSnapshot(), credentials: { account: 'relay@example.test', password: 'relay-password' } })
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub({
      hostStatus: () => hostStatus({ deviceName: currentName }),
      renameHost,
    }), tailnet))

    await expect(handler('settings.deviceName.set', { deviceName: '  workbench  ' }, signal())).resolves.toMatchObject({
      ok: true,
      value: { deviceName: 'workbench', tailnet: { phase: 'ready' } },
    })
    expect(settings.get().deviceName).toBe('workbench')
    expect(renameHost).toHaveBeenCalledWith('workbench', { account: 'relay@example.test', password: 'relay-password' })
    expect(tailnet.reportAuthorized).toHaveBeenCalled()
  })

  it('keeps the local name when no relay is ready and rejects invalid or unwritable names', async () => {
    const settings = settingsBinding({ serverUrl: 'https://relay.example.test' })
    const renameHost = vi.fn(async (deviceName: string) => hostStatus({ deviceName }))
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub({
      hostStatus: () => hostStatus({ deviceName: 'demoliisher' }),
      renameHost,
    }), tailnetStub({ relayReady: false })))

    await expect(handler('settings.deviceName.set', { deviceName: 'office' }, signal())).resolves.toMatchObject({ ok: true })
    expect(renameHost).toHaveBeenCalledWith('office', undefined)
    expect(settings.get().deviceName).toBe('office')
    for (const deviceName of ['', '   ', 'x'.repeat(81), 42]) {
      await expect(handler('settings.deviceName.set', { deviceName }, signal()))
        .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    }
    expect(settings.get().deviceName).toBe('office')

    const unwritable = register(new PluginControlRuntime(resolveConfig({}), undefined, hostStub()))
    await expect(unwritable('settings.deviceName.set', { deviceName: 'workbench' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'SETTINGS_UNAVAILABLE' } } })

    const offlineSettings = settingsBinding({})
    const offline = register(new PluginControlRuntime(resolveConfig(offlineSettings.get()), offlineSettings, undefined))
    await expect(offline('settings.deviceName.set', { deviceName: 'offline' }, signal())).resolves.toMatchObject({
      ok: true,
      value: { deviceName: 'offline', serviceAvailable: false },
    })
    expect(offlineSettings.get().deviceName).toBe('offline')
  })
})

describe('PluginControlRuntime remote service', () => {
  it('turns the remote service off without revoking the device and persists the switch', async () => {
    const settings = settingsBinding({ serverUrl: 'https://relay.example.test' })
    const setHostControl = vi.fn(async (_enabled: boolean) => undefined)
    const authorizeHostWithAccount = vi.fn(async () => ({ method: 'account' }))
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, hostStub({ setHostControl, authorizeHostWithAccount })))

    const off = await handler('service.set', { enabled: false }, signal())
    expect(off).toMatchObject({
      ok: true,
      value: { deviceName: hostname(), serviceAvailable: true, host: { enabled: true, connectedClients: [] } },
    })
    expect(setHostControl).toHaveBeenCalledWith(false)
    expect(authorizeHostWithAccount).not.toHaveBeenCalled()
    expect(settings.get().service).toEqual({ enabled: false })

    await expect(handler('service.set', { enabled: 'false' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    expect(settings.get().service).toEqual({ enabled: false })

    const noHost = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, undefined))
    await expect(noHost('service.set', { enabled: true }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'METHOD_NOT_ALLOWED' } } })
  })

  it('starts the embedded node and resumes Host control once the relay is ready', async () => {
    const settings = settingsBinding({ serverUrl: 'http://127.0.0.1:8080' })
    const calls: string[] = []
    const host = hostStub({
      setHostControl: vi.fn(async (enabled: boolean, options?: { connect?: boolean }) => {
        calls.push(`setHostControl:${String(enabled)}:${String(options?.connect)}`)
      }),
    })
    const tailnet = tailnetStub({ credentials: { account: 'relay@example.test', password: 'relay-password' }, snapshot: tailnetSnapshot() })
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, host, tailnet))

    await expect(handler('service.set', { enabled: true }, signal())).resolves.toMatchObject({ ok: true })
    expect(tailnet.applyService).toHaveBeenCalledWith(true)
    expect(calls).toEqual(['setHostControl:true:undefined'])
    expect(settings.get().service).toEqual({ enabled: true })
  })

  it('opens the switch without connecting while the embedded node waits for authorization', async () => {
    const settings = settingsBinding({ serverUrl: 'http://127.0.0.1:8080' })
    const host = hostStub()
    const tailnet = tailnetStub({
      snapshot: { ...tailnetSnapshot(), phase: 'auth-required', publicUrl: undefined, authUrl: 'https://login.tailscale.com/a/example' },
      relayReady: false,
    })
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, host, tailnet))

    await expect(handler('service.set', { enabled: true }, signal())).resolves.toMatchObject({ ok: true })
    expect(host.setHostControl).toHaveBeenCalledWith(true, { connect: false })
    expect(settings.get().service).toEqual({ enabled: true })
  })

  it('stops only the local relay when the remote service is turned off', async () => {
    const settings = settingsBinding({ serverUrl: 'http://127.0.0.1:8080' })
    const host = hostStub()
    const tailnet = tailnetStub({ snapshot: tailnetSnapshot() })
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, host, tailnet))

    await expect(handler('service.set', { enabled: false }, signal())).resolves.toMatchObject({ ok: true })
    expect(host.setHostControl).toHaveBeenCalledWith(false)
    expect(tailnet.applyService).toHaveBeenCalledWith(false)
    expect(tailnet.stop).not.toHaveBeenCalled()
    expect(tailnet.start).not.toHaveBeenCalled()
    expect(settings.get().service).toEqual({ enabled: false })
  })

  it('refuses to enable the remote service when the local relay is unavailable', async () => {
    const settings = settingsBinding({ serverUrl: 'http://127.0.0.1:8080' })
    const host = hostStub()
    const tailnet = tailnetStub({
      snapshot: { ...tailnetSnapshot(), relayPort: undefined, phase: 'error', error: { code: 'RELAY_START_FAILED', message: '中继启动失败' } },
      relayReady: false,
    })
    const handler = register(new PluginControlRuntime(resolveConfig(settings.get()), settings, host, tailnet))

    const failed = await handler('service.set', { enabled: true }, signal())
    expect(failed).toMatchObject({ ok: false, error: { message: '中继启动失败', details: { remoteCode: 'REMOTE_SERVICE_UNAVAILABLE' } } })
    expect(host.setHostControl).not.toHaveBeenCalled()
  })

  it('starts a manual reconnect and reports Host activity without a tailnet', async () => {
    const reconnectHost = vi.fn()
    const host = hostStub({
      reconnectHost,
      hostStatus: () => hostStatus({ reconnecting: true, lastActiveAt: 1_723_456_789_000, error: 'CONNECTION_FAILED' }),
    })
    const handler = register(new PluginControlRuntime(resolveConfig({ serverUrl: 'https://relay.example.test' }), undefined, host))

    await expect(handler('host.reconnect', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: {
        host: { reconnecting: true, lastActiveAt: 1_723_456_789_000, error: 'CONNECTION_FAILED' },
        serviceAvailable: true,
      },
    })
    expect(reconnectHost).toHaveBeenCalledOnce()

    const noHost = register(new PluginControlRuntime(resolveConfig({}), undefined, undefined))
    await expect(noHost('host.reconnect', {}, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'METHOD_NOT_ALLOWED' } } })
  })

  it('merges the tailnet snapshot into the status payload', async () => {
    const snapshot = tailnetSnapshot()
    const host = hostStub({ hostStatus: () => hostStatus() })
    const handler = register(new PluginControlRuntime(resolveConfig({ serverUrl: 'https://relay.example.test' }), undefined, host, tailnetStub({ snapshot })))

    await expect(handler('status', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: {
        deviceName: hostname(),
        serviceAvailable: true,
        tailnet: snapshot,
        host: { configured: true, online: true, connectedClients: [] },
      },
    })

    const noHost = register(new PluginControlRuntime(resolveConfig({ serverUrl: 'https://relay.example.test' }), undefined, undefined, tailnetStub({ snapshot })))
    const status = await noHost('status', {}, signal())
    expect(status).toMatchObject({ ok: true, value: { serviceAvailable: false, tailnet: snapshot } })
    expect((status as { ok: true; value: Record<string, unknown> }).value).not.toHaveProperty('host')
  })
})

describe('PluginControlRuntime tailnet', () => {
  it('reads and saves the relay credentials without touching the host', async () => {
    const snapshot = tailnetSnapshot()
    const updatedSnapshot = { ...tailnetSnapshot(), relayPort: 9090 }
    const tailnet = tailnetStub({
      snapshot,
      credentials: { account: 'relay@example.test', password: 'relay-password' },
      saveCredentials: vi.fn(async () => updatedSnapshot),
    })
    const authorizeHostWithAccount = vi.fn(async () => ({ method: 'account' }))
    const host = hostStub({ authorizeHostWithAccount })
    const handler = register(new PluginControlRuntime(resolveConfig({}), undefined, host, tailnet))

    await expect(handler('tailnet.credentials', {}, signal())).resolves.toMatchObject({
      ok: true,
      value: { account: 'relay@example.test', password: 'relay-password' },
    })
    expect(await handler('tailnet.status', {}, signal())).toMatchObject({ ok: true, value: snapshot })

    await expect(handler('tailnet.credentials.save', { account: ' new@example.test ', password: 'new-password' }, signal()))
      .resolves.toMatchObject({ ok: true, value: updatedSnapshot })
    expect(tailnet.saveCredentials).toHaveBeenCalledWith({ account: 'new@example.test', password: 'new-password' })
    expect(authorizeHostWithAccount).not.toHaveBeenCalled()
    expect(tailnet.reportAuthorized).not.toHaveBeenCalled()

    const updated = tailnetStub({ saveCredentials: vi.fn(async () => snapshot) })
    const withoutHost = register(new PluginControlRuntime(resolveConfig({}), undefined, undefined, updated))
    await expect(withoutHost('tailnet.credentials.save', { account: 'a@example.test', password: 'pw' }, signal()))
      .resolves.toMatchObject({ ok: true, value: snapshot })

    await expect(handler('tailnet.credentials.save', { account: 'a@example.test', password: '' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'INVALID_MESSAGE' } } })
    expect(tailnet.saveCredentials).toHaveBeenCalledTimes(1)

    const failing = tailnetStub({ saveCredentials: vi.fn(async () => { throw new Error('relay credentials failed') }), credentials: { account: 'a@example.test', password: 'pw' } })
    const failingHandler = register(new PluginControlRuntime(resolveConfig({}), undefined, hostStub(), failing))
    await expect(failingHandler('tailnet.credentials.save', { account: 'a@example.test', password: 'pw' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { message: 'relay credentials failed' } })

    await expect(handler('tailnet.credentials', {}, signal())).resolves.toMatchObject({ ok: true })
    const disabled = register(new PluginControlRuntime(resolveConfig({}), undefined, hostStub()))
    await expect(disabled('tailnet.credentials', {}, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'METHOD_NOT_ALLOWED' } } })
    await expect(disabled('tailnet.status', {}, signal())).resolves.toMatchObject({ ok: true, value: null })

    const ungenerated = register(new PluginControlRuntime(resolveConfig({}), undefined, hostStub(), tailnetStub({ credentials: undefined })))
    await expect(ungenerated('tailnet.credentials', {}, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'CREDENTIALS_UNAVAILABLE' } } })
  })
})

describe('PluginControlRuntime registration', () => {
  it('registers the control endpoint on the loopback RPC channel', async () => {
    const channels = new Set(['/remote'])
    const connection = {
      rpc: {
        handle: vi.fn((channel: string) => {
          if (channels.has(channel)) throw new Error(`webserver: duplicate prefix route "${channel}"`)
          channels.add(channel)
          return async () => { channels.delete(channel) }
        }),
      },
    }
    const runtime = new PluginControlRuntime(resolveConfig({}), undefined, undefined)

    const dispose = runtime.register(connection)

    expect(channels).toEqual(new Set(['/remote', CONTROL_RPC_PREFIX]))
    await dispose()
    expect(channels).toEqual(new Set(['/remote']))
  })

  it('registers loopback control directly on the web server when request rejection is available', async () => {
    const legacyHandle = vi.fn(() => async () => undefined)
    const requestRejection = vi.fn(() => undefined)
    const registerRoute = vi.fn(() => async () => undefined)
    const runtime = new PluginControlRuntime(resolveConfig({}), undefined, undefined)

    const dispose = runtime.register({
      requestRejection,
      rpc: { handle: legacyHandle },
    }, { register: registerRoute })

    expect(legacyHandle).not.toHaveBeenCalled()
    expect(registerRoute).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'prefix',
      path: CONTROL_RPC_PREFIX,
      handler: expect.any(Function),
    }))
    await dispose()
  })

  it('rejects unknown control endpoints', async () => {
    const handler = register(new PluginControlRuntime(resolveConfig({}), undefined, undefined))
    await expect(handler('settings.server.set', { serverUrl: 'https://relay.example.test' }, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'METHOD_NOT_ALLOWED' } } })
    await expect(handler('settings.configure', {}, signal()))
      .resolves.toMatchObject({ ok: false, error: { details: { remoteCode: 'METHOD_NOT_ALLOWED' } } })
  })
})

function register(runtime: PluginControlRuntime) {
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ControlResult<unknown>>) | undefined
  let channel: string | undefined
  runtime.register({
    rpc: {
      handle: (registeredChannel, next) => {
        channel = registeredChannel
        handler = next
        return async () => undefined
      },
    },
  })
  expect(channel).toBe(CONTROL_RPC_PREFIX)
  if (handler === undefined) throw new Error('control handler was not registered')
  return handler
}

function settingsBinding(initial: Config): PluginSettingsBinding {
  let value = structuredClone(initial)
  return {
    get: () => structuredClone(value),
    replace: async section => { value = structuredClone(section) },
  }
}

function hostStatus(overrides: Partial<HostRemoteStatus> = {}): HostRemoteStatus {
  return {
    configured: true,
    enabled: true,
    online: true,
    reconnecting: false,
    authorized: true,
    accountRequired: false,
    connectedClients: [],
    ...overrides,
  }
}

function hostStub(overrides: Partial<HostControl> = {}): HostControl {
  return {
    hostStatus: () => hostStatus(),
    authorizeHostWithAccount: vi.fn(async () => ({ method: 'account' })),
    reconnectHost: vi.fn(),
    setHostControl: vi.fn(async () => undefined),
    renameHost: vi.fn(async deviceName => hostStatus({ deviceName })),
    ...overrides,
  }
}

function tailnetSnapshot(): TailnetSnapshot {
  return {
    enabled: true,
    phase: 'ready',
    dnsName: 'host.tailnet.example.test',
    publicUrl: 'https://host.tailnet.example.test',
    relayPort: 8080,
    steps: {
      node: { ok: true, detail: 'joined' },
      relay: { ok: true, detail: 'running' },
      listen: { ok: true, detail: 'listening' },
      authorize: { ok: true, detail: 'authorized' },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function tailnetStub(options: {
  snapshot?: TailnetSnapshot
  credentials?: { account: string; password: string }
  saveCredentials?: TailnetControl['saveCredentials']
  relayReady?: boolean
} = {}): TailnetControl {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    relayReady: vi.fn(() => options.relayReady ?? true),
    snapshot: vi.fn(() => options.snapshot),
    credentials: vi.fn(() => options.credentials),
    sshCredentials: vi.fn(() => undefined),
    saveCredentials: options.saveCredentials ?? vi.fn(async () => options.snapshot),
    reportAuthorized: vi.fn(),
    reportAuthorizeFailure: vi.fn(),
    applySsh: vi.fn(async () => options.snapshot),
    applyService: vi.fn(async () => options.snapshot),
  }
}

function signal(): AbortSignal { return new AbortController().signal }
