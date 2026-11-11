# 开发、构建与本地验证

ROT 的主要受众是 Windows 上的 DeepSeek Harness Desktop 用户。

## 命名

- 项目全名：`dsh-remote-over-tailnet`
- 文档简称：ROT
- UI 显示名与左下角按钮文字：Remote Over Tailnet

包名同时决定客户端 bundle 的模块 id 与安装名，改名时须同步 `packages/plugin/package.json`、`packages/plugin/dsh-plugin.json`、`cordis.patch.yml` 与文档。

## 本地化

界面文案只维护简体中文与英文：`packages/plugin/src/client-locale.ts` 的 `en` 与 `zh` 两份字典必须同时补齐。`locale/` 与 `packages/plugin/locale/` 只保留 `README.zh.md`、`README.en.md`、`zh.json`、`en.json`。

## 环境

- Windows 11 + PowerShell 7（其他平台未验证）
- Node.js 22 及以上；仓库用 corepack 固定 `pnpm@9.15.4`
- DeepSeek Harness Desktop 0.2.2-rc.1，`dsh` CLI 通过安装目录下的 `resources/runtime/cli/bin/dsh.cmd` 调用

## 安装与构建

```powershell
pnpm install
pnpm -r build
```

`packages/plugin` 的构建包含三步：校验版本同步、TypeScript 编译、esbuild 打包。产物为：

- `packages/plugin/dist/index.js`：Host 侧插件入口
- `packages/plugin/dist/client.github.js`：浏览器客户端面板

客户端 bundle 注册的模块 id 来自 `packages/plugin/package.json` 的 `name`，改名时必须一起改。

## 中继服务器产物

仓库不保存上游服务器源码。中继由 `packages/plugin/scripts/build-server.mjs` 从上游 v0.6.4 的构建产物打包成单文件：

```powershell
$env:DSH_REMOTE_UPSTREAM = 'D:\path\to\ds-harness-remote-copy'
pnpm build:server
```

脚本读取上游副本的 `apps/server/dist/main.js`，输出：

- `packages/plugin/server/dist/main.cjs`（被 gitignore）
- `packages/plugin/server/version.json`（入库，记录插件版本、上游版本、构建时间与 sha256）

构建完成后脚本会真正启动一次中继并轮询 `/health` 自检。上游副本需要先在副本内完成 `pnpm install` 与 `apps/server` 构建；不要在只读的参考克隆里构建。

## 版本同步

以下位置的版本必须一致：

1. 根 `package.json` 的 `version`
2. `packages/plugin/package.json` 的 `version`
3. `packages/plugin/src/version.ts` 的 `PLUGIN_VERSION`
4. `packages/plugin/server/version.json` 的 `pluginVersion`

`verify-version-sync.mjs` 校验前三项，`readServerBundleInfo()` 在启动时校验第四项；不一致会拒绝启动中继。

## 本地验证

不要动用户桌面 profile（`--profile web`）。用独立 `DSH_HOME` 和独立 profile 验证：

```powershell
$env:DSH_HOME = 'D:\path\to\.scratch\dsh-home'
& 'D:\Program Files\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd' --profile dev --no-open
```

隔离 profile 的 `package.json` 用 `link:` 指向本仓库，并把插件列入 `dsh.profile.bundles`。日志会打印 `tailnet relay ready`、`host identity ready`、`Host account authorized` 与 `server control connection online`。浏览器地址中的 token 从日志首行 `dsh web: ...` 获取。

停止隔离实例时按命令行精确过滤，避免误杀当前 runner 或桌面实例：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'cli\.js' -and $_.CommandLine -notmatch 'runner\.js' -and $_.CommandLine -notmatch '--profile web' } |
  Stop-Process -Force
```

完整验证清单：

1. `tailscale serve status --json` 中 443 的转发目标是 `http://127.0.0.1:8080`。
2. `https://<DNSName>/health` 返回 `{"status":"ok"}`。
3. 插件详情页的「远程设置」显示服务器地址、账号、密码与四步状态。
4. DSH Remote 客户端填入地址与账号密码后能连上已有会话并看到逐字输出。

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `packages/plugin/src/index.ts` | 插件入口，编排中继、Runtime 与授权 |
| `packages/plugin/src/tailnet/detect.ts` | 检测 Tailscale 状态 |
| `packages/plugin/src/tailnet/serve.ts` | 读取并确保 `tailscale serve` 配置 |
| `packages/plugin/src/tailnet/relay.ts` | 启动、健康检查与清理中继进程 |
| `packages/plugin/src/tailnet/credentials.ts` | 首次生成并保存中继账号密码 |
| `packages/plugin/src/tailnet/orchestrator.ts` | 串起检测、中继、serve 与授权状态 |
| `packages/plugin/src/client/settings.ts` | 插件面板 |

## 测试

默认不跑完整测试套件（会打开窗口占用显卡）。需要时只跑单个测试文件，并在改动说明里写清原因。
