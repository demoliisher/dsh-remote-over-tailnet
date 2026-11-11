import { platform } from 'node:os'
import { fromBase64Url, toBase64Url } from '@dsh-remote/crypto'
import { deviceTokenPairSchema, type DeviceTokenPair as TokenPair } from '@dsh-remote/protocol'
import type { RtcIceServer } from '@dsh-remote/webrtc'
import type { HostIdentity } from './identity-store.js'
import { ServerCredentialsBusyError, type ServerCredentialStore, type ServerCredentials } from './server-credentials.js'
import { normalizeServerUrl } from './config.js'
import { PLUGIN_VERSION } from './version.js'

interface ErrorEnvelope {
  error: { code: string; message: string; retryable: boolean }
}

interface WebLoginResponse {
  token: string
  expiresAt: number
  account: string
  profile: unknown
  isAdmin: boolean
}

export interface DeviceAuthorization {
  method: 'account'
  account?: string
  expiresAt?: number
  isAdmin?: boolean
}

export type FetchImplementation = typeof fetch

export interface ServerHostDevice {
  deviceId: string
  name: string
  platform: string
  membershipId: string
  online?: boolean
  lastSeenAt?: number
  clientVersion?: string
  harnessVersion?: string
}

export interface AuthorizedPeerDevice extends ServerHostDevice {
  role: 'host' | 'client'
  identityKey: string
}

export class HostServerApi {
  readonly baseUrl: string
  private identity?: HostIdentity
  private credentials?: ServerCredentials
  private credentialsPromise?: Promise<ServerCredentials>
  private harnessVersion?: string
  private readonly lifetime = new AbortController()

  constructor(
    serverUrl: string,
    private readonly store: ServerCredentialStore,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.baseUrl = normalizeServerUrl(serverUrl)
  }

  bindIdentity(identity: HostIdentity): void { this.identity = identity }

  setHarnessVersion(version: string | undefined): void { this.harnessVersion = version }

  /** End this runtime's HTTP requests, including authentication and response bodies. */
  close(): void {
    this.lifetime.abort(new ServerApiError('CONNECTION_CLOSED', 'The Server API has been closed.', false))
  }

  currentAuthorization(): DeviceAuthorization | undefined {
    if (this.credentials === undefined) return undefined
    return {
      method: this.credentials.authorizationMethod,
      ...(this.credentials.account === undefined ? {} : { account: this.credentials.account }),
    }
  }

  async authorizeWithAccount(
    identity: HostIdentity,
    email: string,
    password: string,
    recoverIdentity?: () => Promise<HostIdentity>,
  ): Promise<DeviceAuthorization> {
    this.bindIdentity(identity)
    const account = email.trim()
    if (account.length === 0 || password.length === 0) {
      throw new ServerApiError('INVALID_MESSAGE', 'Email and password are required.', false)
    }
    const login = validateWebLogin(await this.publicRequest<unknown>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: account, password }),
    }))
    const authorization = {
      accountToken: login.token,
      account: login.account,
      authorizationMethod: 'account' as const,
    }
    try {
      await this.register(identity, authorization)
    } catch (error) {
      // A Server-side device removal revokes the old identity permanently.
      // Account login is the explicit re-authorization boundary, so callers
      // may rotate the local identity and retry without requiring a separate
      // settings logout first.
      if (!(error instanceof ServerApiError) || error.code !== 'DEVICE_REVOKED' || recoverIdentity === undefined) throw error
      const nextIdentity = await recoverIdentity()
      this.bindIdentity(nextIdentity)
      await this.register(nextIdentity, authorization)
    }
    return {
      method: 'account',
      account: login.account,
      expiresAt: login.expiresAt,
      isAdmin: login.isAdmin,
    }
  }

  async authenticate(identity = this.requireIdentity()): Promise<ServerCredentials> {
    this.bindIdentity(identity)
    if (this.credentials !== undefined && this.credentials.accessTokenExpiresAt > Date.now() + 30_000) {
      return this.credentials
    }
    this.credentialsPromise ??= this.loadOrIssue(identity).finally(() => { this.credentialsPromise = undefined })
    this.credentials = await this.credentialsPromise
    return this.credentials
  }

  async refreshCredentials(rejectedAccessToken = this.credentials?.accessToken): Promise<ServerCredentials> {
    const identity = this.requireIdentity()
    this.credentials = await this.withRefreshLock(async () => {
      // Another process may have rotated the token while we waited for the lock.
      const stored = await this.store.load(this.baseUrl, identity.deviceId)
      if (stored === undefined || stored.refreshTokenExpiresAt <= Date.now()) return this.register(identity)
      if (stored.accessToken !== rejectedAccessToken && stored.accessTokenExpiresAt > Date.now() + 30_000) {
        return stored
      }
      return this.rotateCredentials(identity, stored)
    })
    return this.credentials
  }

  private async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.store.withRefreshLock(operation)
    } catch (error) {
      if (error instanceof ServerCredentialsBusyError) {
        throw new ServerApiError(error.code, error.message, false)
      }
      throw error
    }
  }

  private async rotateCredentials(identity: HostIdentity, stored: ServerCredentials): Promise<ServerCredentials> {
    let tokens: TokenPair
    try {
      tokens = await this.publicRequest<TokenPair>('/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ deviceId: identity.deviceId, refreshToken: stored.refreshToken }),
      })
    } catch (error) {
      if (error instanceof ServerApiError) {
        // A delayed rejection must not discard credentials another writer saved.
        if (error.code === 'AUTH_INVALID') {
          const latest = await this.store.load(this.baseUrl, identity.deviceId)
          if (latest !== undefined && latest.refreshToken !== stored.refreshToken &&
              latest.refreshTokenExpiresAt > Date.now() && latest.accessTokenExpiresAt > Date.now() + 30_000) {
            return latest
          }
        }
        throw new ServerApiError(error.code, error.message, error.retryable, error.status, 'credential_refresh', error.reason)
      }
      throw error
    }
    return this.store.save({
      ...stored,
      ...validateTokens(tokens),
    })
  }

  async deviceFor(peerDeviceId: string, signal?: AbortSignal): Promise<AuthorizedPeerDevice> {
    const result = await this.request<unknown>(`/api/v1/devices/${encodeURIComponent(peerDeviceId)}`, { signal })
    return parseAuthorizedPeer(result)
  }

  async turnCredentials(connectionId: string): Promise<RtcIceServer[]> {
    const result = await this.request<{ iceServers?: unknown }>(
      `/api/v1/turn/credentials?connection_id=${encodeURIComponent(connectionId)}`,
    )
    if (!Array.isArray(result.iceServers)) return []
    return result.iceServers.map(parseIceServer)
  }

  async presenceFor(deviceId: string, signal?: AbortSignal): Promise<{ online: boolean; lastSeenAt?: number }> {
    const result = await this.request<Record<string, unknown>>(`/api/v1/devices/${encodeURIComponent(deviceId)}/presence`, { signal })
    if (typeof result.online !== 'boolean'
      || (result.lastSeenAt !== null && result.lastSeenAt !== undefined && !Number.isSafeInteger(result.lastSeenAt))) {
      throw new ServerApiError('INVALID_MESSAGE', 'The Server returned invalid device presence.', false)
    }
    return { online: result.online, ...(typeof result.lastSeenAt === 'number' ? { lastSeenAt: result.lastSeenAt } : {}) }
  }

  private async loadOrIssue(identity: HostIdentity): Promise<ServerCredentials> {
    return this.withRefreshLock(async () => {
      const stored = await this.store.load(this.baseUrl, identity.deviceId)
      if (stored === undefined || stored.refreshTokenExpiresAt <= Date.now() + 30_000) {
        return this.register(identity)
      }
      if (stored.accessTokenExpiresAt > Date.now() + 30_000) return stored
      return this.rotateCredentials(identity, stored)
    })
  }

  private async register(
    identity: HostIdentity,
    authorization?: {
      accountToken: string
      account: string
      authorizationMethod: 'account'
    },
  ): Promise<ServerCredentials> {
    const tokens = await this.publicRequest<TokenPair>('/api/v1/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        device: this.deviceDescriptor(identity),
      }),
    }, authorization?.accountToken)
    this.credentials = await this.saveTokens(identity, validateTokens(tokens), {
      authorizationMethod: authorization?.authorizationMethod ?? 'account',
      ...(authorization?.account === undefined ? {} : { account: authorization.account }),
    })
    return this.credentials
  }

  private deviceDescriptor(identity: HostIdentity): Record<string, unknown> {
    return {
      deviceId: identity.deviceId,
      name: identity.name,
      role: 'host',
      platform: platform(),
      identityKey: identity.publicKey,
      clientVersion: PLUGIN_VERSION,
      ...(this.harnessVersion === undefined ? {} : { harnessVersion: this.harnessVersion }),
    }
  }

  private saveTokens(
    identity: HostIdentity,
    tokens: TokenPair,
    authorization: Pick<ServerCredentials, 'authorizationMethod' | 'account'>,
  ): Promise<ServerCredentials> {
    return this.store.save({
      serverUrl: this.baseUrl,
      deviceId: identity.deviceId,
      authorizationMethod: authorization.authorizationMethod,
      ...(authorization.account === undefined ? {} : { account: authorization.account }),
      ...tokens,
    })
  }

  private async request<TResult>(path: string, init: RequestInit = {}): Promise<TResult> {
    const credentials = await this.authenticate()
    return this.publicRequest<TResult>(path, init, credentials.accessToken)
  }

  private async publicRequest<TResult>(path: string, init: RequestInit, accessToken?: string): Promise<TResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const signal = AbortSignal.any([
      this.lifetime.signal,
      controller.signal,
      ...(init.signal == null ? [] : [init.signal]),
    ])
    try {
      signal.throwIfAborted()
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
          ...init.headers,
        },
      })
      const body = await parseBody(response)
      signal.throwIfAborted()
      if (!response.ok) {
        const envelope = isErrorEnvelope(body) ? body : undefined
        // A gateway can challenge requests during startup. Only a protocol
        // error envelope establishes that the device credentials were rejected.
        if ((response.status === 401 || response.status === 403) && envelope === undefined) {
          throw new ServerApiError('CONNECTION_FAILED', 'The Server returned an invalid authorization response.',
            true, response.status, undefined, 'invalid_error_envelope')
        }
        throw new ServerApiError(
          responseErrorCode(response.status, envelope?.error.code),
          envelope?.error.message ?? 'The Server rejected the request.',
          envelope?.error.retryable === true || response.status >= 500 || response.status === 429,
          response.status,
          undefined,
          'http_error',
        )
      }
      return body as TResult
    } catch (error) {
      if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
      if (error instanceof ServerApiError) throw error
      throw new ServerApiError('CONNECTION_FAILED', 'Server request failed.', true, undefined, undefined, controller.signal.aborted ? 'timeout' : 'network_error')
    } finally {
      clearTimeout(timer)
    }
  }

  private requireIdentity(): HostIdentity {
    if (this.identity === undefined) throw new ServerApiError('IDENTITY_INVALID', 'The device identity is not loaded.', false)
    return this.identity
  }
}

export class ServerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly phase?: 'credential_refresh',
    readonly reason?: 'http_error' | 'invalid_json' | 'invalid_error_envelope' | 'timeout' | 'network_error',
  ) { super(message) }
}

function validateTokens(value: unknown): TokenPair {
  const parsed = deviceTokenPairSchema.safeParse(value)
  if (!parsed.success) {
    throw new ServerApiError('INVALID_MESSAGE', 'The Server returned invalid device credentials.', false)
  }
  return parsed.data
}

function validateWebLogin(value: unknown): WebLoginResponse {
  const item = requireRecord(value, 'account login')
  if (typeof item.token !== 'string' || item.token.length < 16
    || !Number.isSafeInteger(item.expiresAt)
    || typeof item.account !== 'string' || item.account.length === 0 || item.account.length > 254
    || typeof item.isAdmin !== 'boolean') {
    throw new ServerApiError('INVALID_MESSAGE', 'The Server returned an invalid account session.', false)
  }
  return {
    token: item.token,
    expiresAt: item.expiresAt as number,
    account: item.account,
    profile: item.profile,
    isAdmin: item.isAdmin,
  }
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const error = (value as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const fields = error as Record<string, unknown>
  return typeof fields.code === 'string' && fields.code.length > 0
    && typeof fields.message === 'string' && typeof fields.retryable === 'boolean'
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const unstructuredAuth = response.status === 401 || response.status === 403
    throw new ServerApiError(unstructuredAuth ? 'CONNECTION_FAILED' : response.ok ? 'INVALID_MESSAGE' : responseErrorCode(response.status, undefined),
      'The Server returned invalid JSON.', unstructuredAuth || response.ok || response.status >= 500 || response.status === 429,
      response.status, undefined, 'invalid_json')
  }
}

function responseErrorCode(status: number, serverCode: unknown): string {
  // Only a specific authorization response may change the local login state.
  // A proxy error or an unclassified rejection must preserve stored credentials.
  if (status >= 500) return 'CONNECTION_FAILED'
  if (status === 429) return 'RATE_LIMITED'
  if ((status === 401 || status === 403) && typeof serverCode === 'string') return serverCode
  if (status === 401 || status === 403) return 'REQUEST_REJECTED'
  if (typeof serverCode === 'string' && !AUTHORIZATION_ERROR_CODES.has(serverCode)) return serverCode
  if (status === 404) return 'DEVICE_NOT_FOUND'
  return 'INVALID_MESSAGE'
}

const AUTHORIZATION_ERROR_CODES = new Set([
  'ACCOUNT_AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_REQUIRED',
  'TOKEN_EXPIRED',
  'DEVICE_REVOKED',
  'DEVICE_OWNERSHIP_REQUIRED',
])

function parseAuthorizedPeer(value: unknown): AuthorizedPeerDevice {
  const item = requireRecord(value, 'authorized peer')
  if ((item.role !== 'host' && item.role !== 'client')
    || typeof item.deviceId !== 'string' || item.deviceId.length === 0
    || typeof item.name !== 'string' || item.name.length === 0
    || typeof item.platform !== 'string' || item.platform.length === 0
    || typeof item.identityKey !== 'string' || !isIdentityKey(item.identityKey)
    || typeof item.membershipId !== 'string' || item.membershipId.length === 0) {
    throw new ServerApiError('INVALID_MESSAGE', 'The Server returned invalid authorized peer data.', false)
  }
  return {
    deviceId: item.deviceId,
    name: item.name,
    role: item.role,
    platform: item.platform,
    identityKey: item.identityKey,
    membershipId: item.membershipId,
    ...(typeof item.online === 'boolean' ? { online: item.online } : {}),
    ...(typeof item.lastSeenAt === 'number' && Number.isSafeInteger(item.lastSeenAt) ? { lastSeenAt: item.lastSeenAt } : {}),
  }
}

function parseIceServer(value: unknown): RtcIceServer {
  const item = requireRecord(value, 'ICE server')
  const urls = item.urls
  if (typeof urls !== 'string' && !(Array.isArray(urls) && urls.every(url => typeof url === 'string'))) {
    throw new ServerApiError('INVALID_MESSAGE', 'The Server returned an invalid ICE server.', false)
  }
  return {
    urls,
    ...(typeof item.username === 'string' ? { username: item.username } : {}),
    ...(typeof item.credential === 'string' ? { credential: item.credential } : {}),
  }
}

function isIdentityKey(value: string): boolean {
  try {
    const decoded = fromBase64Url(value)
    return decoded.length === 32 && toBase64Url(decoded) === value
  } catch {
    return false
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServerApiError('INVALID_MESSAGE', `The Server returned invalid ${name} data.`, false)
  }
  return value as Record<string, unknown>
}
