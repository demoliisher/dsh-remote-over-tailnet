import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.js'
import { IdentityStore, serverStorageDirectory } from '../src/identity-store.js'
import { HostServerApi } from '../src/server-api.js'
import { ServerCredentialStore } from '../src/server-credentials.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Remote CLI', () => {
  it('automatically migrates storage before normal CLI commands without an extra migration step', async () => {
    const dshHome = join(tmpdir(), `dsh-remote-over-tailnet-cli-migration-${crypto.randomUUID()}`)
    directories.push(dshHome)
    const legacy = join(dshHome, 'remote')
    const original = await new IdentityStore({ directory: legacy }).loadOrCreate('Legacy Host')
    const output = writer()
    const errors = writer()
    const createHostApi = vi.fn()
    const dependencies = { env: { DSH_HOME: dshHome }, stdout: output, stderr: errors, createHostApi }
    expect(await runCli(['status'], dependencies)).toBe(0)
    expect(errors.text).toBe('')
    expect(createHostApi).not.toHaveBeenCalled()
    expect(await runCli(['status'], dependencies)).toBe(0)
    expect(await runCli(['status'], dependencies)).toBe(0)
    expect((await readFile(join(dshHome, 'dsh-remote-over-tailnet', 'device.key'), 'utf8')).trim()).toBe(original.privateKey)
    await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(output.text).not.toContain(original.privateKey)
  })

  it('revokes the Host and rotates its local identity on logout', async () => {
    const dshHome = join(tmpdir(), `dsh-remote-cli-logout-${crypto.randomUUID()}`)
    directories.push(dshHome)
    const env = { DSH_HOME: dshHome }
    const root = new IdentityStore({ env }).directory
    const directory = serverStorageDirectory(root, 'https://relay.example.test', 'host')
    const identities = new IdentityStore({ directory, env })
    const original = await identities.loadOrCreate('CLI test Host')
    await new ServerCredentialStore(directory).save({
      serverUrl: 'https://relay.example.test',
      deviceId: original.deviceId,
      authorizationMethod: 'account',
      account: 'host@example.com',
      ...tokens(),
    })
    const output = writer()
    const revoke = vi.fn(async () => undefined)

    await expect(runCli(['logout'], {
      env,
      stdout: output,
      createHostApi: () => ({
        bindIdentity: vi.fn(),
        authenticate: vi.fn(),
        revokeCurrentDevice: revoke,
        authorizeHostWithCode: vi.fn(),
      }),
    })).resolves.toBe(0)

    expect(revoke).toHaveBeenCalledOnce()
    const rotated = JSON.parse(await readFile(join(directory, 'device.json'), 'utf8')) as { deviceId: string }
    expect(rotated.deviceId).not.toBe(original.deviceId)
    await expect(new ServerCredentialStore(directory).load('https://relay.example.test', rotated.deviceId))
      .resolves.toBeUndefined()
    expect(output.text).toContain('local device identity was rotated')
  })

  it('keeps Host authorization ready on verified legacy storage when migration fails without exposing tokens', async () => {
    const dshHome = join(tmpdir(), `dsh-remote-cli-status-${crypto.randomUUID()}`)
    directories.push(dshHome)
    const env = { DSH_HOME: dshHome }
    const root = join(dshHome, 'remote')
    const directory = serverStorageDirectory(root, 'https://relay.example.test', 'host')
    const identity = await new IdentityStore({ directory, env }).loadOrCreate('CLI status Host')
    await new ServerCredentialStore(directory).save({
      serverUrl: 'https://relay.example.test',
      deviceId: identity.deviceId,
      authorizationMethod: 'account',
      account: 'status@example.com',
      ...tokens(),
    })
    const output = writer()
    const fetchMock = vi.fn(async () => { throw new Error('valid local credentials must not need a request') }) as unknown as typeof fetch

    const credentialBytes = await readFile(join(directory, 'server-credentials.json'))
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('move unavailable'), { code: 'EACCES' }))

    await expect(runCli(['status'], {
      env,
      stdout: output,
      createHostApi: (serverUrl, store) => new HostServerApi(serverUrl, store, fetchMock),
    })).resolves.toBe(0)

    expect(await readFile(join(directory, 'server-credentials.json'))).toEqual(credentialBytes)
    await expect(stat(join(dshHome, 'dsh-remote-over-tailnet'))).rejects.toMatchObject({ code: 'ENOENT' })

    expect(output.text).toContain('Host control: enabled')
    expect(output.text).toContain('Authorization: logged in (account)')
    expect(output.text).toContain('Account: status@example.com')
    expect(output.text).toContain('Credential: ready')
    expect(output.text).toContain('Presence: published while the Harness process is running')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(output.text).not.toContain('access-token-value')
    expect(output.text).not.toContain('refresh-token-value')
  })

  it('resets local device identity via reset-identity command including legacy corrupt storage and rejects extra args', async () => {
    const dshHome = join(tmpdir(), `dsh-remote-cli-reset-${crypto.randomUUID()}`)
    directories.push(dshHome)
    const env = { DSH_HOME: dshHome }
    const legacyRoot = join(dshHome, 'remote')
    const hostLegacyDir = serverStorageDirectory(legacyRoot, 'https://relay.example.test', 'host')
    const clientLegacyDir = serverStorageDirectory(legacyRoot, 'https://relay.example.test', 'client')
    const originalHost = await new IdentityStore({ directory: hostLegacyDir, env, role: 'host' }).loadOrCreate('Host')
    const originalClient = await new IdentityStore({ directory: clientLegacyDir, env, role: 'client' }).loadOrCreate('Client')
    await writeFile(join(clientLegacyDir, 'device.key'), 'corrupted-client-key\n')
    await new ServerCredentialStore(clientLegacyDir).save({
      serverUrl: 'https://relay.example.test',
      deviceId: originalClient.deviceId,
      authorizationMethod: 'owned_device',
      ...tokens(),
    })
    const output = writer()
    const errors = writer()

    await expect(runCli(['reset-identity', 'client', '--extra'], { env, stdout: output, stderr: errors })).resolves.toBe(2)
    await expect(runCli(['reset-identity', 'client'], { env, stdout: output, stderr: errors })).resolves.toBe(0)
    expect(output.text).toContain('Remote client identity was reset')

    const canonicalRoot = join(dshHome, 'dsh-remote-over-tailnet')
    const hostCanonicalDir = serverStorageDirectory(canonicalRoot, 'https://relay.example.test', 'host')
    const clientCanonicalDir = serverStorageDirectory(canonicalRoot, 'https://relay.example.test', 'client')
    const preservedHost = JSON.parse(await readFile(join(hostCanonicalDir, 'device.json'), 'utf8')) as { deviceId: string }
    const rotatedClient = JSON.parse(await readFile(join(clientCanonicalDir, 'device.json'), 'utf8')) as { deviceId: string }
    expect(preservedHost.deviceId).toBe(originalHost.deviceId)
    expect(rotatedClient.deviceId).not.toBe(originalClient.deviceId)
  })

  it('succeeds on logout even when local device identity is corrupt', async () => {
    const dshHome = join(tmpdir(), `dsh-remote-cli-corrupt-logout-${crypto.randomUUID()}`)
    directories.push(dshHome)
    const env = { DSH_HOME: dshHome }
    const root = new IdentityStore({ env }).directory
    const directory = serverStorageDirectory(root, 'https://relay.example.test', 'host')
    const identities = new IdentityStore({ directory, env, role: 'host' })
    const original = await identities.loadOrCreate('CLI test Host')
    // Corrupt the key file
    await writeFile(join(directory, 'device.key'), 'corrupted-private-key\n')
    await new ServerCredentialStore(directory).save({
      serverUrl: 'https://relay.example.test',
      deviceId: original.deviceId,
      authorizationMethod: 'account',
      account: 'host@example.com',
      ...tokens(),
    })
    const output = writer()

    await expect(runCli(['logout'], { env, stdout: output })).resolves.toBe(0)
    expect(output.text).toContain('Remote Host logged out and its local device identity was rotated')
  })
})

function writer(isTTY = false): { text: string; isTTY: boolean; write(value: string): void } {
  return {
    text: '',
    isTTY,
    write(value) { this.text += value },
  }
}

function tokens() {
  return {
    accessToken: 'access-token-value',
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token-value',
    refreshTokenExpiresAt: Date.now() + 120_000,
  }
}
