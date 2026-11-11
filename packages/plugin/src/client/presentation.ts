import type { Translate } from '../client-locale.js'
import type { RemoteStatus } from './types.js'

export function formatLocalTime(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function connectionErrorMessage(code: string, t: Translate): string {
  if (code === 'ACCOUNT_AUTH_REQUIRED') return t('hostSignInHint')
  if (code === 'AUTH_REQUIRED') return t('hostSignInHint')
  if (code === 'AUTH_INVALID' || code === 'TOKEN_EXPIRED') return t('connectionAuthorizationExpired')
  if (code === 'CONNECTION_REPLACED') return t('connectionReplaced')
  if (code === 'SERVER_CREDENTIALS_BUSY') return t('connectionCredentialsBusy')
  if (code === 'DEVICE_REVOKED') return t('connectionDeviceRevoked')
  if (code === 'DEVICE_OWNERSHIP_REQUIRED') return t('connectionOwnershipRequired')
  if (code === 'RATE_LIMITED') return t('connectionRateLimited')
  if (code === 'UNSUPPORTED_VERSION') return t('connectionVersionMismatch')
  if (code === 'INVALID_MESSAGE') return t('connectionInvalidResponse')
  if (code === 'CONNECTION_FAILED') return t('serverUnavailableError')
  if (code === 'SERVER_NOT_CONFIGURED') return t('connectionReachability')
  return t('connectionUnexpected')
}

export function connectionStatusLabel(host: RemoteStatus['host'] | undefined, t: Translate): string {
  if (host === undefined) return t('checkingConnection')
  if (host.online) return t('online')
  if (host.error !== undefined) return connectionErrorMessage(host.error, t)
  if (!host.reconnecting) return t('offline')
  return t(host.lastActiveAt === undefined ? 'connecting' : 'serverUnavailableShort')
}

export function connectionStatusClass(host: RemoteStatus['host'] | undefined): string {
  if (host?.online) return ' isOnline'
  if (host?.reconnecting) return ' isReconnecting'
  return host === undefined ? '' : ' isOffline'
}

export function startupErrorMessage(error: { code: string; message: string }, t: Translate): string {
  if (error.code === 'IDENTITY_INVALID') return t('identityCorrupted')
  if (error.code === 'SERVER_CREDENTIALS_INVALID') return t('credentialsCorrupted')
  if (error.code === 'IDENTITY_LOCKED') return t('identityLocked')
  if (error.code === 'STORAGE_CONFLICT') return t('storageConflict')
  if (error.code === 'SERVER_CREDENTIALS_BUSY') return t('connectionCredentialsBusy')
  return error.message || t('remoteStartupFailed')
}

export function messageOf(reason: unknown, t: Translate): string {
  if (typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string') {
    if (reason.code === 'CONNECTION_FAILED') return t('serverUnavailableError')
    if (reason.code === 'IDENTITY_INVALID') return t('identityCorrupted')
    if (reason.code === 'SERVER_CREDENTIALS_INVALID') return t('credentialsCorrupted')
    if (reason.code === 'IDENTITY_LOCKED') return t('identityLocked')
    if (reason.code === 'STORAGE_CONFLICT') return t('storageConflict')
    if (reason.code === 'SERVER_CREDENTIALS_BUSY') return t('connectionCredentialsBusy')
  }
  return reason instanceof Error ? reason.message : String(reason)
}

export function formatPlatform(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === 'darwin' || normalized === 'macos') return 'macOS'
  if (normalized === 'win32' || normalized === 'windows') return 'Windows'
  if (normalized === 'linux') return 'Linux'
  if (normalized === 'android') return 'Android'
  return value
}

export function connectedClientModeLabel(
  mode: 'LAN' | 'P2P' | 'TURN' | 'Relay' | undefined,
  t: Translate,
): string {
  if (mode === 'LAN') return t('remoteNetworkLan')
  if (mode === 'P2P') return t('remoteNetworkP2p')
  if (mode === 'TURN') return t('remoteNetworkTurn')
  if (mode === 'Relay') return t('remoteNetworkRelay')
  return t('connected')
}
