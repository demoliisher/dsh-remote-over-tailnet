import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(root, 'tsnet-src')
const output = join(root, 'tsnet', 'tsnet.wasm')
const signaturePath = join(root, 'tsnet', 'build-tags.txt')

// 内嵌节点只做三件事：加入 tailnet、在本机监听、把连接转给中继。
// 客户端其余功能在全平台都是按 ts_omit_* 标记在编译期摘掉，这里逐个摘掉不需要的部分，
// 产物从 36.9 MB 降到 32.1 MB，需求变化时删掉对应一行即可恢复。
// 不要试图摘掉 netstack、magicsock、portmapper、useproxy 与 DNS 解析，它们决定节点能否连上。
const omitFeatures = [
  // 用不到的服务端与网络能力：SSH、文件投递、对节点下发配置、出口节点与子网路由、控制面中继
  'ts_omit_ssh',
  'ts_omit_taildrop',
  'ts_omit_peerapiclient',
  'ts_omit_peerapiserver',
  'ts_omit_connreject',
  'ts_omit_useexitnode',
  'ts_omit_advertiseexitnode',
  'ts_omit_advertiseroutes',
  'ts_omit_useroutes',
  'ts_omit_relayserver',
  'ts_omit_routecheck',
  'ts_omit_outboundproxy',
  // 系统集成：桌面托盘、网卡接管、硬件密钥、策略与路由接管、云平台探测
  'ts_omit_systray',
  'ts_omit_tap',
  'ts_omit_tpm',
  'ts_omit_bird',
  'ts_omit_syspolicy',
  'ts_omit_osrouter',
  'ts_omit_cloud',
  'ts_omit_desktop_sessions',
  'ts_omit_kube',
  'ts_omit_aws',
  'ts_omit_captiveportal',
  'ts_omit_serviceclientprefs',
  'ts_omit_tundevstats',
  'ts_omit_gro',
  // 遥测与诊断：日志上报、客户端指标、调试接口、链路测速、端口清单
  'ts_omit_netlog',
  'ts_omit_logtail',
  'ts_omit_clientmetrics',
  'ts_omit_usermetrics',
  'ts_omit_runtimemetrics',
  'ts_omit_debug',
  'ts_omit_debugeventbus',
  'ts_omit_linkspeed',
  'ts_omit_health',
  'ts_omit_portlist',
  'ts_omit_unixsocketidentity',
  // 客户端交互与维护：升级、诊断命令、命令补全、浏览器唤起、通知、桌面快捷入口
  'ts_omit_clientupdate',
  'ts_omit_cliconndiag',
  'ts_omit_doctor',
  'ts_omit_completion',
  'ts_omit_webbrowser',
  'ts_omit_webclient',
  'ts_omit_favorites',
  'ts_omit_wakeonlan',
  'ts_omit_syslog',
  'ts_omit_sdnotify',
  // 登录与网络性能里用不到的旁路：设备密钥登录、身份联合、DNS 配置缓存
  'ts_omit_oauthkey',
  'ts_omit_identityfederation',
  'ts_omit_dnsresolvecache',
]

const buildTags = omitFeatures.join(',')

async function newestSourceTime(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  let newest = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceTime(path))
    } else if (entry.name.endsWith('.go') || entry.name === 'go.mod' || entry.name === 'go.sum') {
      newest = Math.max(newest, (await stat(path)).mtimeMs)
    }
  }
  return newest
}

// 产物不入库，构建时按源文件时间戳与编译标记判定是否需要重新编译，避免每次 tsc 都跑 Go。
// 标记清单变了但源码没变时也必须重编译，否则旧产物会悄悄留在原地。
const built = await stat(output).then(entry => entry.mtimeMs, () => 0)
const previousTags = await readFile(signaturePath, 'utf8').then(text => text.trim(), () => '')
if (built > (await newestSourceTime(sourceDirectory)) && previousTags === buildTags) {
  console.log('内嵌节点无需重新编译。')
} else {
  // GOOS=js 让 tsnet 使用用户态网络，产物由 src/tailnet/embedded-node.ts 在 Node 里加载。
  // go.mod 必须位于 tailscale.com 域下，否则 tsnet 依赖的 internal 包不允许跨模块引用。
  const build = spawn('go', ['build', '-trimpath', '-tags', buildTags, '-ldflags', '-s -w', '-o', output, '.'], {
    cwd: sourceDirectory,
    env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
    stdio: 'inherit',
  })
  build.on('exit', async code => {
    if (code !== 0) process.exit(code ?? 1)
    await writeFile(signaturePath, buildTags + '\n')
    const { size } = await stat(output)
    console.log(`内嵌节点已编译：tsnet/tsnet.wasm（${(size / 1000 / 1000).toFixed(1)} MB）`)
  })
}
