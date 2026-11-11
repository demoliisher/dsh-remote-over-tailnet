import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REMOTE_SERVER_URL, normalizeServerUrl } from './config.js'
import {
  IdentityInvalidError,
  IdentityStore,
  prepareDefaultIdentityDirectory,
  resetDefaultIdentityRoles,
  serverStorageDirectory,
  type HostIdentity,
  type IdentityStoreOptions,
  type RemoteDeviceRole,
} from './identity-store.js'
import {
  HostServerApi,
  ServerApiError,
  type DeviceAuthorization,
} from './server-api.js'
import {
  ServerCredentialStore,
  ServerCredentialsInvalidError,
  type ServerCredentials,
} from './server-credentials.js'

interface CliWriter {
  write(value: string): unknown
}

interface CliHostApi {
  bindIdentity(identity: HostIdentity): void
  authenticate(identity?: HostIdentity): Promise<ServerCredentials>
  revokeCurrentDevice(): Promise<void>
  authorizeHostWithCode(identity: HostIdentity, code: string): Promise<DeviceAuthorization>
}

export interface RemoteCliDependencies {
  env?: NodeJS.ProcessEnv
  stdout?: CliWriter
  stderr?: CliWriter
  createIdentityStore?: (options: IdentityStoreOptions) => IdentityStore
  createHostApi?: (serverUrl: string, store: ServerCredentialStore) => CliHostApi
}

interface CliRuntime {
  env: NodeJS.ProcessEnv
  stdout: CliWriter
  stderr: CliWriter
  createIdentityStore: (options: IdentityStoreOptions) => IdentityStore
  createHostApi: (serverUrl: string, store: ServerCredentialStore) => CliHostApi
}

/** Headless account bootstrap. Configuration remains owned by the DSH profile. */
export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  dependencies: RemoteCliDependencies = {},
): Promise<number> {
  const runtime = resolveDependencies(dependencies)
  const [command, ...rest] = args
  try {
    if (command === 'register') return await register(rest, runtime)
    if (command === 'status') return await status(rest, runtime)
    if (command === 'logout') return await logout(rest, runtime)
    if (command === 'reset-identity') return await resetIdentity(rest, runtime)
    if (command === 'help' || command === '--help' || command === '-h' || command === undefined) {
      write(runtime.stdout, helpText())
      return 0
    }
    throw new CliUsageError(`Unknown command: ${command}`)
  } catch (error) {
    write(runtime.stderr, `${cliErrorMessage(error)}\n`)
    if (error instanceof CliUsageError) write(runtime.stderr, `\n${helpText()}`)
    return error instanceof CliUsageError ? 2 : 1
  }
}

async function register(args: readonly string[], runtime: CliRuntime): Promise<number> {
  if (args.length !== 1 || args[0] === undefined || args[0].trim() === '') {
    throw new CliUsageError('Usage: dsh-remote-over-tailnet register <server-token>')
  }
  const context = await hostContext(runtime)
  await context.api.authorizeHostWithCode(context.identity, args[0])
  write(runtime.stdout, 'Remote Host registration complete. Restart the Harness instance to bring the Remote Host online.\n')
  return 0
}

async function status(args: readonly string[], runtime: CliRuntime): Promise<number> {
  if (args.length !== 0) throw new CliUsageError('Usage: dsh-remote-over-tailnet status')
  const serverUrl = selectedServer()
  const root = await prepareDefaultIdentityDirectory({ env: runtime.env })
  const directory = serverStorageDirectory(root, serverUrl, 'host')
  const lines = [
    'Remote Host status',
    `Server: ${serverUrl}`,
    'Host control: enabled',
  ]

  if (!await exists(join(directory, 'device.json'))) {
    lines.push('Device: not initialized', 'Authorization: logged out', 'Credential: unavailable')
    write(runtime.stdout, `${lines.join('\n')}\n\nAuthorize this Host from the DeepSeek Harness plugin panel.\n`)
    return 0
  }

  const identities = runtime.createIdentityStore({ directory, env: runtime.env, role: 'host' })
  const deviceName = runtime.env.DSH_REMOTE_DEVICE_NAME ?? hostname()
  const identity = await identities.loadOrCreate(deviceName)
  const store = new ServerCredentialStore(directory)
  const stored = await store.load(serverUrl, identity.deviceId)
  lines.push(`Device: ${identity.name} (${identity.deviceId})`)
  if (stored === undefined) {
    lines.push('Authorization: logged out', 'Credential: unavailable')
    write(runtime.stdout, `${lines.join('\n')}\n\nAuthorize this Host from the DeepSeek Harness plugin panel.\n`)
    return 0
  }

  lines.push(`Authorization: logged in (${authorizationLabel(stored.authorizationMethod)})`)
  if (stored.account !== undefined) lines.push(`Account: ${stored.account}`)
  const api = runtime.createHostApi(serverUrl, store)
  api.bindIdentity(identity)
  try {
    await api.authenticate(identity)
    lines.push('Credential: ready')
    lines.push('Presence: published while the Harness process is running')
    write(runtime.stdout, `${lines.join('\n')}\n`)
    return 0
  } catch (error) {
    lines.push(`Credential: unavailable (${statusErrorCode(error)})`)
    write(runtime.stdout, `${lines.join('\n')}\n`)
    return 1
  }
}

async function logout(args: readonly string[], runtime: CliRuntime): Promise<number> {
  if (args.length !== 0) throw new CliUsageError('Usage: dsh-remote-over-tailnet logout')
  const serverUrl = selectedServer()
  const deviceName = runtime.env.DSH_REMOTE_DEVICE_NAME ?? hostname()
  let root: string
  try {
    root = await prepareDefaultIdentityDirectory({ env: runtime.env })
  } catch (error) {
    if (error instanceof IdentityInvalidError && error.code === 'IDENTITY_INVALID') {
      await resetDefaultIdentityRoles(['host'], serverUrl, deviceName, {
        env: runtime.env,
        createIdentityStore: runtime.createIdentityStore,
      })
      write(runtime.stdout, 'Remote Host logged out and its local device identity was rotated. Restart the Harness instance.\n')
      return 0
    }
    throw error
  }
  const directory = serverStorageDirectory(root, serverUrl, 'host')
  const [hasDevice, hasKey, hasCredentials] = await Promise.all([
    exists(join(directory, 'device.json')),
    exists(join(directory, 'device.key')),
    exists(join(directory, 'server-credentials.json')),
  ])
  if (!hasDevice && !hasKey && !hasCredentials) {
    await new ServerCredentialStore(directory).clear()
    write(runtime.stdout, 'This Host is already logged out.\n')
    return 0
  }

  const identities = runtime.createIdentityStore({ directory, env: runtime.env, role: 'host' })
  let revokeFailure: unknown
  try {
    const identity = await identities.loadOrCreate(deviceName)
    const api = runtime.createHostApi(serverUrl, new ServerCredentialStore(directory))
    api.bindIdentity(identity)
    await api.revokeCurrentDevice()
  } catch (error) {
    revokeFailure = error
  }
  await identities.reset(deviceName)
  await new ServerCredentialStore(directory).clear()
  if (revokeFailure !== undefined
    && !(revokeFailure instanceof IdentityInvalidError)
    && !(revokeFailure instanceof ServerCredentialsInvalidError)) {
    throw new Error(`Local Host credentials were cleared, but Server revocation failed: ${cliErrorMessage(revokeFailure)}`)
  }
  write(runtime.stdout, 'Remote Host logged out and its local device identity was rotated. Restart the Harness instance.\n')
  return 0
}

async function resetIdentity(args: readonly string[], runtime: CliRuntime): Promise<number> {
  if (args.length > 1) {
    throw new CliUsageError('Usage: dsh-remote-over-tailnet reset-identity [host|client|all]')
  }
  const roleArg = args[0]
  if (roleArg !== undefined && roleArg !== 'host' && roleArg !== 'client' && roleArg !== 'all') {
    throw new CliUsageError('Usage: dsh-remote-over-tailnet reset-identity [host|client|all]')
  }
  const serverUrl = selectedServer()
  const deviceName = runtime.env.DSH_REMOTE_DEVICE_NAME ?? hostname()
  const roles: RemoteDeviceRole[] = roleArg === 'client' ? ['client'] : roleArg === 'host' ? ['host'] : ['host', 'client']
  await resetDefaultIdentityRoles(roles, serverUrl, deviceName, {
    env: runtime.env,
    createIdentityStore: runtime.createIdentityStore,
  })
  for (const role of roles) {
    write(runtime.stdout, `Remote ${role} identity was reset and a new key pair was created.\n`)
  }
  write(runtime.stdout, 'Restart the Harness instance to use the fresh identity.\n')
  return 0
}

async function hostContext(runtime: CliRuntime): Promise<{
  api: CliHostApi
  identities: IdentityStore
  identity: HostIdentity
  deviceName: string
}> {
  const serverUrl = selectedServer()
  const root = await prepareDefaultIdentityDirectory({ env: runtime.env })
  const directory = serverStorageDirectory(root, serverUrl, 'host')
  const deviceName = runtime.env.DSH_REMOTE_DEVICE_NAME ?? hostname()
  const identities = runtime.createIdentityStore({ directory, env: runtime.env, role: 'host' })
  const identity = await identities.loadOrCreate(deviceName)
  const api = runtime.createHostApi(serverUrl, new ServerCredentialStore(directory))
  return { api, identities, identity, deviceName }
}

function selectedServer(): string {
  return normalizeServerUrl(DEFAULT_REMOTE_SERVER_URL)
}

function resolveDependencies(input: RemoteCliDependencies): CliRuntime {
  return {
    env: input.env ?? process.env,
    stdout: input.stdout ?? process.stdout,
    stderr: input.stderr ?? process.stderr,
    createIdentityStore: input.createIdentityStore ?? (options => new IdentityStore(options)),
    createHostApi: input.createHostApi ?? ((serverUrl, store) => new HostServerApi(serverUrl, store)),
  }
}

function authorizationLabel(method: ServerCredentials['authorizationMethod']): string {
  if (method === 'host_registration_code') return 'Host registration code'
  if (method === 'owned_device') return 'owned device'
  return 'account'
}

function statusErrorCode(error: unknown): string {
  return error instanceof ServerApiError ? error.code : 'CONNECTION_FAILED'
}

function cliErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The Remote command failed.'
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  return code === undefined ? message : `${message} (${code})`
}

function helpText(): string {
  return [
    'Usage:',
    '  dsh-remote-over-tailnet register <server-token>',
    '  dsh-remote-over-tailnet status',
    '  dsh-remote-over-tailnet logout',
    '  dsh-remote-over-tailnet reset-identity [host|client|all]',
    '',
    `The Server is ${DEFAULT_REMOTE_SERVER_URL}.`,
    'Host configuration is not exposed by this CLI yet. Restart the Harness instance after authorization changes.',
    '',
  ].join('\n')
}

function write(target: CliWriter, value: string): void {
  target.write(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

class CliUsageError extends Error {}
