import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fromBase64Url, generateKeyPair } from '@dsh-remote/crypto'
import { z } from 'zod'
import { uuidV7 } from './ids.js'
import { ServerCredentialStore } from './server-credentials.js'

const identitySchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(80),
  publicKey: z.string().min(1),
}).strict()

const trustedPeerSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  publicKey: z.string().min(1),
  fingerprint: z.string().min(1),
  trustedAt: z.number().int().nonnegative(),
  membershipId: z.string().min(1).optional(),
}).strict()

const trustedPeersSchema = z.object({
  schemaVersion: z.literal(1),
  // Discovery can persist multiple pages; reading must accept every record we write.
  peers: z.array(trustedPeerSchema),
}).strict()

export interface HostIdentity {
  schemaVersion: 1
  deviceId: string
  name: string
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface TrustedPeer {
  deviceId: string
  name: string
  platform: string
  publicKey: string
  fingerprint: string
  trustedAt: number
  membershipId?: string
}

export interface IdentityStoreOptions {
  directory?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

export type IdentityErrorCode = 'IDENTITY_INVALID' | 'IDENTITY_LOCKED' | 'STORAGE_CONFLICT'

export class IdentityInvalidError extends Error {
  constructor(
    message: string,
    readonly code: IdentityErrorCode = 'IDENTITY_INVALID',
  ) {
    super(message)
  }
}

export class IdentityStore {
  private storageDirectory: string
  get directory(): string { return this.storageDirectory }
  private identity?: HostIdentity
  private peers = new Map<string, TrustedPeer>()
  private peerSaveChain: Promise<void> = Promise.resolve()
  private readonly defaultOptions?: IdentityStoreOptions

  constructor(options: IdentityStoreOptions = {}) {
    const env = options.env ?? process.env
    const dshHome = env.DSH_HOME || join(options.homeDirectory ?? homedir(), '.dsh')
    this.storageDirectory = options.directory ?? join(dshHome, 'dsh-remote-over-tailnet')
    this.defaultOptions = options.directory === undefined ? options : undefined
  }

  async loadOrCreate(deviceName: string): Promise<HostIdentity> {
    if (this.defaultOptions !== undefined) this.storageDirectory = await prepareDefaultIdentityDirectory(this.defaultOptions)
    await ensureDirectory(this.directory)
    // Creation writes two files that must agree. Without a cross-process lock a
    // Desktop restart overlapping the previous Host reaches the "create" branch
    // twice; each writes its own key pair and the directory ends up holding one
    // process's device.json beside another's device.key. That mismatch fails
    // closed forever — every later start throws before registering the control
    // route — so serialize the whole read-create-verify cycle.
    return withIdentityLock(this.directory, () => this.loadOrCreateLocked(deviceName))
  }

  /**
   * Read and verify an existing identity without creating files or mutating
   * device metadata. Returns `undefined` when neither identity file exists yet.
   */
  async loadExisting(): Promise<HostIdentity | undefined> {
    if (this.defaultOptions !== undefined) this.storageDirectory = await prepareDefaultIdentityDirectory(this.defaultOptions)
    const devicePath = join(this.directory, 'device.json')
    const keyPath = join(this.directory, 'device.key')
    const [hasDevice, hasKey] = await Promise.all([exists(devicePath), exists(keyPath)])
    if (!hasDevice && !hasKey) return undefined
    if (hasDevice !== hasKey) {
      throw new IdentityInvalidError('device identity is incomplete; repair it explicitly before reconnecting')
    }
    await assertPrivateMode(keyPath)
    try {
      const record = identitySchema.parse(JSON.parse(await readFile(devicePath, 'utf8')))
      const privateKey = (await readFile(keyPath, 'utf8')).trim()
      const regenerated = generateKeyPair(fromBase64Url(privateKey))
      if (regenerated.publicKey !== record.publicKey) {
        throw new IdentityInvalidError('device public and private keys do not match')
      }
      return { ...record, privateKey, fingerprint: fingerprint(record.publicKey) }
    } catch (error: unknown) {
      if (error instanceof IdentityInvalidError) throw error
      throw new IdentityInvalidError(`device identity is invalid: ${safeErrorMessage(error)}`)
    }
  }

  /**
   * Rewrite the published device name while keeping the same device ID and key
   * pair. The identity must already exist: renaming never mints a replacement.
   */
  async rename(deviceName: string): Promise<HostIdentity> {
    if (this.defaultOptions !== undefined) this.storageDirectory = await prepareDefaultIdentityDirectory(this.defaultOptions)
    await ensureDirectory(this.directory)
    return withIdentityLock(this.directory, async () => {
      const devicePath = join(this.directory, 'device.json')
      const keyPath = join(this.directory, 'device.key')
      const [hasDevice, hasKey] = await Promise.all([exists(devicePath), exists(keyPath)])
      if (!hasDevice && !hasKey) throw new IdentityInvalidError('device identity does not exist; start the relay service before renaming it')
      if (hasDevice !== hasKey) throw new IdentityInvalidError('device identity is incomplete; repair it explicitly before renaming it')
      const identity = await this.readIdentity(devicePath, keyPath, deviceName)
      await removeStaleTemporaries(this.directory)
      return identity
    })
  }

  private async loadOrCreateLocked(deviceName: string): Promise<HostIdentity> {
    const devicePath = join(this.directory, 'device.json')
    const keyPath = join(this.directory, 'device.key')
    const [hasDevice, hasKey] = await Promise.all([exists(devicePath), exists(keyPath)])
    if (hasDevice !== hasKey) {
      throw new IdentityInvalidError('device identity is incomplete; repair it explicitly before reconnecting')
    }

    if (!hasDevice) {
      return this.createAndReadIdentityLocked(devicePath, keyPath, deviceName)
    }

    const identity = await this.readIdentity(devicePath, keyPath, deviceName)
    // Only a verified pair makes the leftovers dead weight. In the #276 residue
    // the surviving device.key.*.tmp is the only private key that still matches
    // device.json, so a failed verification keeps it for manual recovery.
    await removeStaleTemporaries(this.directory)
    return identity
  }

  private async createAndReadIdentityLocked(devicePath: string, keyPath: string, deviceName: string): Promise<HostIdentity> {
    const keys = generateKeyPair()
    const record = { schemaVersion: 1 as const, deviceId: uuidV7(), name: deviceName, publicKey: keys.publicKey }
    // Write the key first: a crash between the two leaves device.key alone,
    // which the incomplete-pair guard above reports explicitly, instead of
    // leaving a device.json whose published public key has no private half.
    await atomicTextWrite(keyPath, `${keys.privateKey}
`, 0o600)
    await atomicJsonWrite(devicePath, record, 0o600)
    const identity = await this.readIdentity(devicePath, keyPath, deviceName)
    await removeStaleTemporaries(this.directory)
    return identity
  }

  private async readIdentity(devicePath: string, keyPath: string, deviceName: string): Promise<HostIdentity> {
    await assertPrivateMode(keyPath)
    try {
      let record = identitySchema.parse(JSON.parse(await readFile(devicePath, 'utf8')))
      const privateKey = (await readFile(keyPath, 'utf8')).trim()
      const regenerated = generateKeyPair(fromBase64Url(privateKey))
      if (regenerated.publicKey !== record.publicKey) {
        throw new IdentityInvalidError('device public and private keys do not match')
      }
      if (record.name !== deviceName) {
        record = { ...record, name: deviceName }
        await atomicJsonWrite(devicePath, record, 0o600)
      }
      this.identity = { ...record, privateKey, fingerprint: fingerprint(record.publicKey) }
      await this.loadPeers()
      return this.identity
    } catch (error: unknown) {
      if (error instanceof IdentityInvalidError) throw error
      throw new IdentityInvalidError(`device identity is invalid: ${safeErrorMessage(error)}`)
    }
  }

  current(): HostIdentity {
    if (this.identity === undefined) throw new Error('identity store has not been loaded')
    return this.identity
  }

  /**
   * Replace the identity. Runs in the same lock domain as creation, so a reset
   * can never interleave with another process's read-create-verify. The lock
   * file lives outside `removeIdentityRecords`, so resetting cannot delete a
   * lock another process holds — and cannot leave itself unprotected either.
   */
  async reset(deviceName: string): Promise<HostIdentity> {
    if (this.defaultOptions !== undefined) this.storageDirectory = await prepareDefaultIdentityDirectory(this.defaultOptions)
    await ensureDirectory(this.directory)
    return withIdentityLock(this.directory, async () => {
      await this.peerSaveChain.catch(() => undefined)
      this.identity = undefined
      this.peers.clear()
      await removeIdentityRecords(this.directory)
      return this.loadOrCreateLocked(deviceName)
    })
  }

  listTrustedPeers(): TrustedPeer[] {
    return [...this.peers.values()].map(peer => ({ ...peer }))
  }

  trustedPeer(deviceId: string): TrustedPeer | undefined {
    const peer = this.peers.get(deviceId)
    return peer === undefined ? undefined : { ...peer }
  }

  isTrusted(deviceId: string, publicKey: string): boolean {
    return this.peers.get(deviceId)?.publicKey === publicKey
  }

  async trustPeer(input: Omit<TrustedPeer, 'fingerprint' | 'trustedAt'>): Promise<TrustedPeer> {
    this.current()
    const peer: TrustedPeer = {
      ...input,
      fingerprint: fingerprint(input.publicKey),
      trustedAt: Date.now(),
    }
    this.peers.set(peer.deviceId, peer)
    await this.savePeers()
    return { ...peer }
  }

  async revokePeer(deviceId: string): Promise<boolean> {
    const removed = this.peers.delete(deviceId)
    if (removed) await this.savePeers()
    return removed
  }

  private async loadPeers(): Promise<void> {
    const path = join(this.directory, 'trusted-peers.json')
    if (!(await exists(path))) {
      await atomicJsonWrite(path, { schemaVersion: 1, peers: [] }, 0o600)
    }
    const parsed = trustedPeersSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const peers = new Map<string, TrustedPeer>()
    for (const peer of parsed.peers) {
      if (peer.fingerprint !== fingerprint(peer.publicKey)) {
        throw new IdentityInvalidError(`trusted peer ${peer.deviceId} has an invalid fingerprint`)
      }
      if (peers.has(peer.deviceId)) throw new IdentityInvalidError(`trusted peer ${peer.deviceId} is duplicated`)
      peers.set(peer.deviceId, peer)
    }
    this.peers = peers
  }

  private savePeers(): Promise<void> {
    const next = this.peerSaveChain.catch(() => undefined).then(() =>
      atomicJsonWrite(join(this.directory, 'trusted-peers.json'), {
        schemaVersion: 1,
        peers: [...this.peers.values()],
      }, 0o600),
    )
    this.peerSaveChain = next
    return next
  }
}

const statIdSchema = z.union([
  z.number().int().nonnegative().transform(value => BigInt(value)),
  z.string().regex(/^(?:0|[1-9]\d{0,19})$/).transform(value => BigInt(value)),
])

const legacyRootPinSchema = z.object({
  schemaVersion: z.literal(1),
  dev: statIdSchema,
  ino: statIdSchema,
}).strict()

function serializeStatId(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
}

/** Resolve storage and migrate legacy data before startup or installation uses it.
 * Upgrade/restart must stop old instances: idle old processes do not hold file locks.
 */
export async function prepareDefaultIdentityDirectory(
  options: IdentityStoreOptions = {},
): Promise<string> {
  if (options.directory !== undefined) return options.directory
  const env = options.env ?? process.env
  const home = env.DSH_HOME || join(options.homeDirectory ?? homedir(), '.dsh')
  const source = join(home, 'remote')
  const target = join(home, 'dsh-remote-over-tailnet')
  await mkdir(home, { recursive: true, mode: 0o700 })
  // Kept outside the renamed tree so competing new-version migrators share one lock.
  const lockDirectory = join(home, '.dsh-remote-over-tailnet-migration')
  await storageDirectoryStat(lockDirectory)
  await ensureDirectory(lockDirectory)
  return withIdentityLock(lockDirectory, async () => {
    const old = await storageDirectoryStat(source)
    const current = await storageDirectoryStat(target)
    const pinPath = join(lockDirectory, 'legacy-root.json')
    const pinMetadata = await lstat(pinPath).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    let pin: z.infer<typeof legacyRootPinSchema> | undefined
    if (pinMetadata !== undefined) {
      if (!pinMetadata.isFile() || pinMetadata.isSymbolicLink() || pinMetadata.nlink !== 1 || pinMetadata.size > 4096) {
        throw new IdentityInvalidError('Remote storage fallback record is invalid; no credentials were changed.', 'STORAGE_CONFLICT')
      }
      await assertPrivateMode(pinPath)
      try {
        pin = legacyRootPinSchema.parse(JSON.parse(await readFile(pinPath, 'utf8')))
      } catch {
        throw new IdentityInvalidError('Remote storage fallback record is invalid; no credentials were changed.', 'STORAGE_CONFLICT')
      }
    }
    if (old !== undefined) {
      if (current !== undefined) {
        throw new IdentityInvalidError('Both Remote storage directories exist; stop all Harness instances and resolve them manually. No credentials were overwritten.', 'STORAGE_CONFLICT')
      }
      await assertOwnedRemoteStorage(source)
      await assertStorageIdle(source)
      // Persist the choice across processes. A later installer/CLI must not move
      // storage out from under a Host that is already using the fallback.
      if (pin !== undefined) {
        if (pin.dev !== old.dev || pin.ino !== old.ino) {
          throw new IdentityInvalidError('Legacy Remote storage changed after fallback; inspect it before reconnecting.', 'STORAGE_CONFLICT')
        }
        return source
      }
      try {
        // Same parent/filesystem: preserve every byte, mode, Server scope and role in one rename.
        await rename(source, target)
      } catch (error) {
        if (!isNodeError(error) || !['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS', 'EEXIST', 'ENOTEMPTY', 'ENOSPC', 'EDQUOT'].includes(error.code ?? '')) throw error
        const remaining = await storageDirectoryStat(source)
        // A failed move is compatible only if the same verified tree still exists
        // and no destination appeared. Never fall back from an ambiguous outcome.
        if (remaining === undefined || remaining.dev !== old.dev || remaining.ino !== old.ino || await storageDirectoryStat(target) !== undefined) throw error
        await assertOwnedRemoteStorage(source)
        await assertStorageIdle(source)
        // If the fallback choice cannot be recorded, stop rather than risk
        // another process moving a directory this process starts using.
        await atomicJsonWrite(pinPath, {
          schemaVersion: 1,
          dev: serializeStatId(old.dev),
          ino: serializeStatId(old.ino),
        }, 0o600)
        return source
      }
    } else if (pin !== undefined) {
      if (current === undefined) throw new IdentityInvalidError('Pinned Remote storage is missing; no replacement identity was created.', 'STORAGE_CONFLICT')
      await assertOwnedRemoteStorage(target)
    }
    return target
  })
}

/** Legacy storage has no owner marker. Require its complete known layout and
 * cryptographically consistent identities, rather than trusting the directory name.
 * Read-only: never repair, create peers, rename devices or refresh tokens here.
 */
export async function assertOwnedRemoteStorage(root: string): Promise<void> {
  let failureCode: IdentityErrorCode = 'STORAGE_CONFLICT'
  const rejected = (code: IdentityErrorCode = failureCode) => new IdentityInvalidError(
    'Remote storage ownership could not be verified; nothing was moved. Inspect the legacy directory manually.',
    code,
  )
  const identityFiles = new Set([
    'device.json',
    'device.key',
    'trusted-peers.json',
    'server-credentials.json',
  ])
  let identities = 0
  const checkIdentity = async (directory: string, scope?: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => !(directory === root && entry.name === 'servers' && entry.isDirectory()))
    for (const entry of entries) {
      if (!entry.isFile() || !identityFiles.has(entry.name)) throw rejected('STORAGE_CONFLICT')
      const metadata = await lstat(join(directory, entry.name))
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 16 * 1024 * 1024) {
        throw rejected('STORAGE_CONFLICT')
      }
    }
    const names = new Set(entries.map(entry => entry.name))
    if (!names.has('device.json') && !names.has('device.key')) throw rejected('STORAGE_CONFLICT')
    failureCode = 'IDENTITY_INVALID'
    if (!names.has('device.json') || !names.has('device.key')) {
      throw rejected('IDENTITY_INVALID')
    }
    await assertPrivateMode(join(directory, 'device.key'))
    const record = identitySchema.parse(JSON.parse(await readFile(join(directory, 'device.json'), 'utf8')))
    const key = (await readFile(join(directory, 'device.key'), 'utf8')).trim()
    if (generateKeyPair(fromBase64Url(key)).publicKey !== record.publicKey) {
      throw rejected('IDENTITY_INVALID')
    }
    if (names.has('trusted-peers.json')) {
      const peers = trustedPeersSchema.parse(JSON.parse(await readFile(join(directory, 'trusted-peers.json'), 'utf8'))).peers
      const ids = new Set<string>()
      for (const peer of peers) {
        if (peer.fingerprint !== fingerprint(peer.publicKey) || ids.has(peer.deviceId)) throw rejected('IDENTITY_INVALID')
        ids.add(peer.deviceId)
      }
    }
    if (names.has('server-credentials.json')) {
      // Use the existing strict schema and permission checks without refreshing or writing.
      const raw = JSON.parse(await readFile(join(directory, 'server-credentials.json'), 'utf8')) as { serverUrl?: unknown }
      if (typeof raw.serverUrl !== 'string') throw rejected('IDENTITY_INVALID')
      const credentials = await new ServerCredentialStore(directory).load(raw.serverUrl, record.deviceId)
      if (credentials === undefined) throw rejected('IDENTITY_INVALID')
      const origin = new URL(credentials.serverUrl)
      if (!['http:', 'https:'].includes(origin.protocol)) throw rejected('IDENTITY_INVALID')
      if (scope !== undefined && createHash('sha256').update(origin.origin).digest('hex').slice(0, 24) !== scope) {
        throw rejected('STORAGE_CONFLICT')
      }
    }
    identities++
  }
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const flat = entries.filter(entry => entry.name !== 'servers')
    if (flat.length > 0) {
      // Validate a historical unscoped identity without including the servers container.
      if (flat.some(entry => !entry.isFile() || !identityFiles.has(entry.name))) throw rejected('STORAGE_CONFLICT')
      await checkIdentity(root)
    }
    const servers = entries.find(entry => entry.name === 'servers')
    if (servers !== undefined) {
      if (!servers.isDirectory()) throw rejected('STORAGE_CONFLICT')
      for (const scope of await readdir(join(root, 'servers'), { withFileTypes: true })) {
        if (!scope.isDirectory() || !/^[a-f0-9]{24}$/.test(scope.name)) throw rejected('STORAGE_CONFLICT')
        for (const role of await readdir(join(root, 'servers', scope.name), { withFileTypes: true })) {
          if (!role.isDirectory() || role.name !== 'host') throw rejected('STORAGE_CONFLICT')
          await checkIdentity(join(root, 'servers', scope.name, role.name), scope.name)
        }
      }
    }
    if (identities === 0) throw rejected(failureCode)
  } catch (error) {
    if (error instanceof IdentityInvalidError && error.message === 'Remote storage ownership could not be verified; nothing was moved. Inspect the legacy directory manually.') {
      throw error
    }
    // Do not surface schema errors or file contents that might contain secrets.
    throw rejected(failureCode)
  }
}

async function storageDirectoryStat(path: string): Promise<BigIntStats | undefined> {
  try {
    const entry = await lstat(path, { bigint: true })
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new IdentityInvalidError('Remote storage must be a real directory; symbolic links are not migrated.', 'STORAGE_CONFLICT')
    }
    return entry
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertStorageIdle(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === LOCK_FILE_NAME || entry.name.includes('.refresh-lock') || entry.name.startsWith(`${LOCK_FILE_NAME}.takeover-`)) {
      throw new IdentityInvalidError(
        'Remote storage contains a lock or symbolic link; stop all Harness instances and inspect it before migration.',
        entry.isSymbolicLink() ? 'STORAGE_CONFLICT' : 'IDENTITY_LOCKED',
      )
    }
    if (entry.isDirectory()) await assertStorageIdle(join(directory, entry.name))
  }
}

export function serverStorageDirectory(root: string, serverUrl: string): string {
  const origin = new URL(serverUrl).origin
  const scope = createHash('sha256').update(origin).digest('hex').slice(0, 24)
  return join(root, 'servers', scope, 'host')
}

export function fingerprint(publicKey: string): string {
  const compact = createHash('sha256').update(fromBase64Url(publicKey)).digest('hex').slice(0, 12).toUpperCase()
  return compact.match(/.{1,4}/g)!.join(' ')
}

async function assertPrivateMode(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new IdentityInvalidError(`private key permissions must be 0600, got ${mode.toString(8).padStart(3, '0')}`)
  }
}

async function atomicJsonWrite(path: string, value: unknown, mode: number): Promise<void> {
  await atomicTextWrite(path, `${JSON.stringify(value, null, 2)}
`, mode)
}

async function atomicTextWrite(path: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode, flag: 'wx' })
  await chmod(temporary, mode)
  await rename(temporary, path)
  await chmod(path, mode)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid identity data'
}

/**
 * Serialize every read-create-verify cycle that touches `directory`.
 */
const LOCK_FILE_NAME = 'device.lock'
const LOCK_TIMEOUT_MS = 15_000
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

async function withIdentityLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(directory, LOCK_FILE_NAME)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}
`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      break
    } catch (error: unknown) {
      if (!(await isLockContention(error, lockPath))) throw error
      if (await takeOverLockOfExitedOwner(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new IdentityInvalidError(
        'device identity is locked by another process; stop other DSH instances and retry',
        'IDENTITY_LOCKED',
      )
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

/** Whether an exclusive create failed because the lock already exists. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  if (!isNodeError(error)) return false
  if (error.code === 'EEXIST') return true
  // Windows reports a held exclusive create as EPERM; confirm by looking.
  if (error.code !== 'EPERM' || process.platform !== 'win32') return false
  return exists(lockPath)
}

/**
 * Remove a lock whose recorded owner is proven gone, and report whether this
 * call did it. An unreadable or malformed record is not proof of anything and
 * is left alone for its owner or an operator to resolve.
 */
async function takeOverLockOfExitedOwner(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined || !ownerExited(record)) return false
  const claimPath = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claimPath, `${process.pid}
`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error: unknown) {
    // Another contender is reclaiming this same record; it removes the lock.
    if (await isLockContention(error, claimPath)) return false
    throw error
  }
  try {
    if (await readLockRecord(lockPath) !== record || !ownerExited(record)) return false
    await rm(lockPath, { force: true })
    return true
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined)
  }
}

async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether the owner a `<pid>\n` record names is proven gone. */
function ownerExited(record: string): boolean {
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  if (pid === 0 || pid > 2147483647) return false
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error: unknown) {
    return isNodeError(error) && error.code === 'ESRCH'
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

/** Drop owned identity records in `directory`, preserving locks and sibling trees. */
async function removeIdentityRecords(directory: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  await Promise.all(entries
    .filter(name => isOwnedIdentityRecord(name))
    .map(name => unlink(join(directory, name)).catch(() => undefined)))
}

function isIdentityTempArtifact(name: string): boolean {
  return (name.startsWith('device.json.') || name.startsWith('device.key.')) && name.endsWith('.tmp')
}

function isOwnedIdentityRecord(name: string): boolean {
  if (name === 'device.json' || name === 'device.key' || name === 'trusted-peers.json') return true
  return (
    name.startsWith('device.json.')
    || name.startsWith('device.key.')
    || name.startsWith('trusted-peers.json.')
  ) && name.endsWith('.tmp')
}

/** Drop temp files a previous interrupted write left beside the identity pair. */
async function removeStaleTemporaries(directory: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  await Promise.all(entries
    .filter(name => isIdentityTempArtifact(name))
    .map(name => unlink(join(directory, name)).catch(() => undefined)))
}
