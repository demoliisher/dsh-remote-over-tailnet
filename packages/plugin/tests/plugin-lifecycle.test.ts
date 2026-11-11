import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as remotePlugin from '../src/index.js'
import { resolveConfig, type Config } from '../src/config.js'
import type { ControlRouteHandler } from '../src/control-route.js'

const directories: string[] = []
const disabledAgentDomains = { codex: { enabled: false } }

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Cordis plugin lifecycle', () => {
  it('migrates only owned legacy entries without disabling an unrelated plugin', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-legacy-ownership-')
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline fixture') }))
    const entries = [
      { id: 'current', options: { id: 'current', name: '@dsh-remote/plugin', disabled: false } },
      { id: 'foreign', options: { id: 'foreign', name: 'dsh-remote', disabled: false } },
      { id: 'foreign-null', options: { id: 'foreign-null', name: 'dsh-remote', disabled: null } },
      { id: 'foreign-disabled', options: { id: 'foreign-disabled', name: 'dsh-remote', disabled: true } },
      { id: 'owned', options: { id: 'owned', name: '@dsh-remote/plugin', disabled: false } },
      { id: 'owned-disabled', options: { id: 'owned-disabled', name: '@dsh-remote/plugin', disabled: true } },
      { id: 'other', options: { id: 'other', name: 'another-plugin', disabled: false } },
    ]
    const update = vi.fn(async (id: string, options: { disabled?: boolean | null }) => {
      Object.assign(entries.find(entry => entry.id === id)!.options, options)
    })
    const ctx = new Context()
    ctx.provide('loader', { locate: () => 'current', entries: () => entries, update } as never)
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', connection().service)
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis ownership test host' })
    try {
      await vi.waitFor(() => expect(ctx.dshRemote.currentIdentity()).toBeDefined())
      expect(update.mock.calls).toEqual([['owned', { disabled: true }]])
      expect(entries.map(entry => [entry.id, entry.options.disabled])).toEqual([
        ['current', false], ['foreign', false], ['foreign-null', null], ['foreign-disabled', true],
        ['owned', true], ['owned-disabled', true], ['other', false],
      ])
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('activates on the legacy settings registry without losing the entry Config', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-legacy-registry-')
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline fixture') }))
    const config: Config = {
      ...disabledAgentDomains,
      serverUrl: 'https://legacy.example.com',
      loopback: { ports: [8080] },
    }
    // `dsh-settings@0.2.1-rc.3` resolves a registration as
    // `schema(mergeLayers(base, user))`; a plugin with no stored section has no
    // override layer, so the registration must resolve the entry Config itself.
    let registerSchema: ((input?: unknown) => unknown) | undefined
    let resolvedFromSchema: unknown
    const register = vi.fn((_ns: string, schema: (input?: unknown) => unknown, options?: { validate?: (value: unknown) => void }) => {
      registerSchema = schema
      resolvedFromSchema = schema(undefined)
      options?.validate?.(resolvedFromSchema)
      return { get: () => resolvedFromSchema, replace: async () => undefined }
    })
    const ctx = new Context()
    ctx.provide('settings', { register } as never)
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', connection().service)
    const fiber = await ctx.plugin(remotePlugin, config)
    try {
      await vi.waitFor(() => { expect(ctx.get('dshRemote')).toBeDefined() })
      expect(register).toHaveBeenCalledOnce()
      expect(register.mock.calls[0]?.[0]).toBe('ds-harness-remote')
      expect(resolvedFromSchema).toMatchObject({
        serverUrl: 'https://legacy.example.com',
        loopback: { ports: [8080] },
        codex: { enabled: false },
      })
      // Defaults, including enabled, are supplied by resolveConfig rather than the registration schema.
      expect(resolveConfig(resolvedFromSchema as Config)).toMatchObject({ enabled: true })
      // A stored section still wins, including an explicit reset to an empty list.
      expect(registerSchema?.({ loopback: { ports: [] } })).toMatchObject({ loopback: { ports: [] } })
      await vi.waitFor(() => expect(ctx.dshRemote.currentIdentity()).toBeDefined())
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('skips automatic Host authorization when the Host control switch is off at startup', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-host-control-off-')
    vi.stubEnv('DSH_HOME', dshHome)
    const fetchSpy = vi.fn<typeof fetch>(async () => { throw new Error('offline fixture') })
    vi.stubGlobal('fetch', fetchSpy)
    const fixture = connection()
    const ctx = new Context()
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', fixture.service)
    const fiber = await ctx.plugin(remotePlugin, {
      ...disabledAgentDomains,
      serverUrl: 'https://relay.example.test',
      hostControl: { enabled: false },
      deviceName: 'Cordis host control host',
    })
    const call = (endpoint: string, payload: unknown = {}) => fixture.handler!(endpoint, payload, new AbortController().signal)
    try {
      await vi.waitFor(() => expect(fixture.handler).toBeDefined())
      await vi.waitFor(async () => {
        await expect(call('status')).resolves.toMatchObject({
          ok: true,
          value: { tailnet: { steps: { authorize: { detail: '允许控制本机已关闭' } } } },
        })
      })
      expect(ctx.dshRemote.hostStatus()).toMatchObject({ enabled: false })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('records why the automatic Host authorization was skipped when the relay is not ready', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-relay-not-ready-')
    vi.stubEnv('DSH_HOME', dshHome)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('offline fixture') }))
    const fixture = connection()
    const ctx = new Context()
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', fixture.service)
    const fiber = await ctx.plugin(remotePlugin, {
      ...disabledAgentDomains,
      serverUrl: 'https://relay.example.test',
      deviceName: 'Cordis relay host',
    })
    const call = (endpoint: string, payload: unknown = {}) => fixture.handler!(endpoint, payload, new AbortController().signal)
    try {
      await vi.waitFor(() => expect(fixture.handler).toBeDefined())
      await vi.waitFor(async () => {
        await expect(call('status')).resolves.toMatchObject({
          ok: true,
          value: { tailnet: { steps: { authorize: { detail: '本地中继未就绪，跳过自动授权' } } } },
        })
      })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not block Harness startup while runtime services are unavailable', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis pending host' })

    expect(fiber.state).toBe(2)
    expect(fiber.inject).toEqual({})
    expect(ctx.get('dshRemote')).toBeUndefined()

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('automatically migrates storage on upgrade before loading Typert and disposes its runtime', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-cordis-')
    vi.stubEnv('DSH_HOME', dshHome)

    const original = await new remotePlugin.IdentityStore({ directory: join(dshHome, 'remote') }).loadOrCreate('Cordis test host')

    const ctx = new Context()
    let identityReadyWhenControlRegistered: boolean | undefined
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', connection(() => {
      try {
        ctx.dshRemote.currentIdentity()
        identityReadyWhenControlRegistered = true
      } catch {
        identityReadyWhenControlRegistered = false
      }
    }).service)
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis test host' })

    await vi.waitFor(() => {
      expect(ctx.dshRemote.currentIdentity()).toMatchObject({ name: 'Cordis test host' })
      expect(ctx.dshRemote.diagnostics()).toMatchObject({
        loaded: true,
        capabilities: expect.arrayContaining(['harness.remote.v1', 'harness.remote.transfer.v1']),
      })
    })
    expect(ctx.dshRemote.currentIdentity()).toEqual(original)

    expect(identityReadyWhenControlRegistered).toBe(false)

    await fiber.dispose()
    expect(ctx.get('dshRemote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('waits for Desktop connection before activating even when Typert is ready', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-late-connection-')
    vi.stubEnv('DSH_HOME', dshHome)

    const ctx = new Context()
    const fixture = connection()
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis delayed connection host' })

    expect(ctx.get('dshRemote')).toBeUndefined()
    ctx.provide('connection', fixture.service)
    await vi.waitFor(() => {
      expect(ctx.dshRemote.currentIdentity()).toMatchObject({ name: 'Cordis delayed connection host' })
    })
    expect(fixture.handle).toHaveBeenCalledWith('/ds-harness-remote', expect.any(Function), {
      authority: 'loopback',
    })

    await fiber.dispose()
    expect(ctx.get('dshRemote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps a carrier-less Desktop unavailable even when legacy ApiProxy is provided', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-late-apiproxy-')
    vi.stubEnv('DSH_HOME', dshHome)

    const ctx = new Context()
    const handlers: Array<{
      channel: string
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
      disposed: boolean
    }> = []
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', { invoke: vi.fn() } as never)
    ctx.provide('connection', {
      rpc: {
        handle: vi.fn((channel: string, handler: typeof handlers[number]['handler']) => {
          const entry = { channel, handler, disposed: false }
          handlers.push(entry)
          return async () => { entry.disposed = true }
        }),
      },
    } as never)
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis delayed rc.2 host' })

    expect(ctx.get('dshRemote')).toBeUndefined()
    await vi.waitFor(() => expect(handlers).toHaveLength(1))
    expect(handlers[0]?.channel).toBe('/ds-harness-remote')
    await expect(handlers[0]?.handler('status', {}, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { deviceName: expect.any(String), hostAuthorizationAvailable: false },
    })
    ctx.provide('apiProxy', {} as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('dshRemote')).toBeUndefined()
    expect(handlers[0]?.disposed).toBe(false)

    await fiber.dispose()
    expect(ctx.get('dshRemote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reports an unrecognized legacy role layout as a storage conflict and recovers after cleanup', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-storage-conflict-')
    vi.stubEnv('DSH_HOME', dshHome)
    const scope = createHash('sha256').update('https://relay.example.test').digest('hex').slice(0, 24)
    const legacyRoot = join(dshHome, 'remote')
    await mkdir(join(legacyRoot, 'servers', scope, 'client'), { recursive: true })

    const config: Config = { ...disabledAgentDomains, deviceName: 'Cordis storage conflict host' }

    const blocked = new Context()
    blocked.provide('settings', settings())
    blocked.provide('typertGateway', typertGateway())
    const blockedConnection = connection()
    blocked.provide('connection', blockedConnection.service)
    const blockedFiber = await blocked.plugin(remotePlugin, config)
    try {
      await vi.waitFor(() => expect(blockedConnection.handler).toBeDefined())
      await expect(blockedConnection.handler!('status', {}, new AbortController().signal)).resolves.toMatchObject({
        ok: true,
        value: {
          deviceName: expect.any(String),
          hostAuthorizationAvailable: false,
          startupError: { code: 'STORAGE_CONFLICT' },
        },
      })
      expect(blocked.get('dshRemote')).toBeUndefined()
    } finally {
      await blockedFiber.dispose()
      await blocked.fiber.dispose()
    }

    // The legacy tree must be repaired on disk; the plugin cannot unregister the
    // already-mounted connection service, so recovery mounts on a fresh Context.
    await rm(legacyRoot, { recursive: true, force: true })
    const recoveredContext = new Context()
    recoveredContext.provide('settings', settings())
    recoveredContext.provide('typertGateway', typertGateway())
    const recovered = connection()
    recoveredContext.provide('connection', recovered.service)
    const recoveredFiber = await recoveredContext.plugin(remotePlugin, config)
    try {
      await vi.waitFor(() => expect(recoveredContext.dshRemote.currentIdentity()).toMatchObject({ name: 'Cordis storage conflict host' }))
      const status = await recovered.handler!('status', {}, new AbortController().signal) as { ok: true; value?: { startupError?: unknown; hostAuthorizationAvailable?: boolean } }
      expect(status.value?.startupError).toBeUndefined()
      expect(status.value?.hostAuthorizationAvailable).toBe(true)
    } finally {
      await recoveredFiber.dispose()
      await recoveredContext.fiber.dispose()
    }
  })

  it('keeps the control plane running when another plugin already owns the dshRemote service', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-service-conflict-')
    vi.stubEnv('DSH_HOME', dshHome)
    const foreignHostService = { apiVersion: 1 }
    const fixture = connection()
    const ctx = new Context()
    ctx.provide('dshRemote', foreignHostService as never)
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', fixture.service)
    const fiber = await ctx.plugin(remotePlugin, { ...disabledAgentDomains, deviceName: 'Cordis service conflict host' })
    const call = (endpoint: string, payload: unknown = {}) => fixture.handler!(endpoint, payload, new AbortController().signal)
    try {
      await vi.waitFor(() => expect(fixture.handler).toBeDefined())
      expect(ctx.get('dshRemote')).toBe(foreignHostService)
      await expect(call('status')).resolves.toMatchObject({
        ok: true,
        value: { hostAuthorizationAvailable: true, host: { connectedClients: [] } },
      })
      await expect(call('settings.get')).resolves.toMatchObject({ ok: true, value: { writable: true } })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps the control plane available when the plugin is disabled in the config', async () => {
    const dshHome = await temporaryDirectory('dsh-remote-disabled-')
    vi.stubEnv('DSH_HOME', dshHome)
    const fixture = connection()
    const ctx = new Context()
    ctx.provide('settings', settings())
    ctx.provide('typertGateway', typertGateway())
    ctx.provide('connection', fixture.service)
    const fiber = await ctx.plugin(remotePlugin, { enabled: false })
    try {
      await vi.waitFor(() => expect(fixture.handler).toBeDefined())
      expect(ctx.get('dshRemote')).toBeUndefined()
      await expect(fixture.handler!('status', {}, new AbortController().signal)).resolves.toMatchObject({
        ok: true,
        value: { hostAuthorizationAvailable: false },
      })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

function settings() {
  return {
    configure: () => () => undefined,
    // These tests exercise Harness registration/disposal, not installed Agent
    // CLIs. Keep optional processes out of the fixture (including the bundled
    // CodeX fallback, which is discoverable even with an isolated PATH).
    replace: vi.fn(async () => undefined),
  } as never
}

type ControlHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>

function connection(onHandle?: () => void) {
  let handler: ControlRouteHandler | undefined
  const handle = vi.fn((_channel: string, next: ControlRouteHandler) => {
    handler = next
    onHandle?.()
    return async () => undefined
  })
  return {
    handle,
    get handler() { return handler },
    service: { rpc: { handle } } as never,
  }
}

function typertGateway() {
  return { invoke: vi.fn(async () => undefined), dispatchRpc: vi.fn(async () => ({ ok: true })), openWireStream: vi.fn(async () => (async function* () {})()) } as never
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}
