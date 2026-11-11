import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = join(root, 'package.json')
const versionPath = join(root, 'src', 'version.ts')
const serverVersionPath = join(root, 'server', 'version.json')

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const packageVersion = packageJson.version
if (typeof packageVersion !== 'string') {
  throw new Error('package.json must contain a string "version".')
}

const source = readFileSync(versionPath, 'utf8')
const match = source.match(/export const PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!match) {
  throw new Error('Cannot find PLUGIN_VERSION declaration in src/version.ts.')
}

const pluginVersion = match[1]
if (packageVersion !== pluginVersion) {
  throw new Error(
    `Version mismatch: package.json version is ${packageVersion}, but PLUGIN_VERSION is ${pluginVersion}. ` +
      'Keep these two versions in sync.'
  )
}

// 打包后的 server 产物记录的是构建时的插件版本；版本号变更后必须重新构建。
if (existsSync(serverVersionPath)) {
  const serverVersion = JSON.parse(readFileSync(serverVersionPath, 'utf8')).pluginVersion
  if (serverVersion !== packageVersion) {
    throw new Error(
      `server 产物版本与插件版本不一致，请运行 pnpm build:server 重新构建` +
        `（server: ${serverVersion}, plugin: ${packageVersion}）。`
    )
  }
}

console.log(`Version sync verified: ${packageVersion}`)
