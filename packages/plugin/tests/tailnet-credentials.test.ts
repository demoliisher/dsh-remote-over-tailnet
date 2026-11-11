import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_ACCOUNT, loadOrCreateRelayCredentials, relayCredentialsPath, saveRelayCredentials } from '../src/tailnet/credentials.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-credentials-'))
  directories.push(directory)
  return directory
}

describe('中继凭据', () => {
  it('首次启动生成固定账号与足够长的密码，再次读取保持不变', async () => {
    const directory = await temporaryDirectory()
    const first = await loadOrCreateRelayCredentials(directory)
    expect(first.account).toBe(RELAY_ACCOUNT)
    expect(first.password.length).toBeGreaterThanOrEqual(12)
    expect(await loadOrCreateRelayCredentials(directory)).toEqual(first)
  })

  it('保存面板改过的账号密码，密码过短时拒绝且不覆盖原文件', async () => {
    const directory = await temporaryDirectory()
    const original = await loadOrCreateRelayCredentials(directory)
    await expect(saveRelayCredentials(directory, { account: 'owner@dsh.local', password: 'too-short' })).rejects.toThrow(/至少需要 12/)
    expect(await loadOrCreateRelayCredentials(directory)).toEqual(original)
    const saved = await saveRelayCredentials(directory, { account: ' first@example.com ', password: 'a-new-password-123' })
    expect(saved).toEqual({ account: 'first@example.com', password: 'a-new-password-123' })
    expect(JSON.parse(await readFile(relayCredentialsPath(directory), 'utf8'))).toEqual(saved)
  })
})
