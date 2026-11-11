import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { atomicWritePrivate, readPrivateJson } from '../server-credentials.js'

/**
 * 中继 server 的登录账号与密码。
 *
 * 上游 server 只在启动时读环境变量：账号非空、密码至少 12 位。它的 state.json 用
 * scrypt 保存密码校验值，密码一旦变化，已有设备令牌全部失效。因此这里首次生成后
 * 长期保持不变，并与 state.json 放在同一数据目录里一起管理。
 */
export interface RelayCredentials {
  account: string
  password: string
}

/** 本机唯一使用者的固定账号；上游登录接口的字段名是 email，值可以是任意非空字符串。 */
export const RELAY_ACCOUNT = 'owner@dsh.local'

/** 上游 server 要求的密码最小长度。 */
const MIN_PASSWORD_LENGTH = 12

export function relayCredentialsPath(directory: string): string {
  return join(directory, 'credentials.json')
}

/**
 * 读取已有凭据；不存在时生成随机密码写入。
 * 文件存在但内容不合法时直接抛错，避免用新密码覆盖掉一个还能用的中继状态。
 */
export async function loadOrCreateRelayCredentials(directory: string): Promise<RelayCredentials> {
  const path = relayCredentialsPath(directory)
  const existing = await readPrivateJson(path)
  if (existing !== undefined) {
    const parsed = parseCredentials(existing)
    if (parsed !== undefined) return parsed
    throw new Error(`中继凭据文件格式不正确：${path}。请删除该文件后重启 DSH，插件会重新生成账号密码。`)
  }
  const created: RelayCredentials = {
    account: RELAY_ACCOUNT,
    password: randomBytes(24).toString('base64url'),
  }
  await atomicWritePrivate(path, `${JSON.stringify(created, null, 2)}\n`)
  return created
}

/** 校验并写入面板上修改过的账号密码；密码长度与上游 server 的启动校验保持一致。 */
export async function saveRelayCredentials(directory: string, credentials: RelayCredentials): Promise<RelayCredentials> {
  const account = credentials.account.trim()
  if (account === '') throw new Error('中继账号不能为空。')
  if (credentials.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error('中继密码至少需要 ' + String(MIN_PASSWORD_LENGTH) + ' 个字符。')
  }
  const next: RelayCredentials = { account, password: credentials.password }
  await atomicWritePrivate(relayCredentialsPath(directory), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function parseCredentials(value: unknown): RelayCredentials | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const account = record.account
  const password = record.password
  if (typeof account !== 'string' || account.trim() === '') return undefined
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return undefined
  return { account: account.trim(), password }
}
