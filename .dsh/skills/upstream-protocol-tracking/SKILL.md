---
name: upstream-protocol-tracking
description: 当需要跟进上游 ds-harness-remote 的协议变化、把新版本的中继与协议层同步进本仓库、或判断某个上游提交是否必须跟随时使用。本文给出必须保持原文的兼容契约清单、只读对比步骤、差异分类规则、同步与验证命令、已知陷阱。
---

# 上游协议跟进

本仓库（ROT，Remote Over Tailnet）是上游 ds-harness-remote 的 fork。定位：协议层（packages/protocol、packages/crypto、packages/webrtc）与打包进本仓库的中继 server 运行时代码保持上游原文，只精简插件业务流程层。因此升级的判定标准是「触碰了哪一层」，与提交数量无关。

## 第一步：确认当前基线

读文件，不要凭印象：

1. 本仓库版本四处：根 `package.json` 的 `version`、`packages/plugin/package.json` 的 `version`、`packages/plugin/src/version.ts` 的 `PLUGIN_VERSION`、`packages/plugin/server/version.json` 的 `pluginVersion` 与 `upstreamVersion`。
2. 上游参考克隆：`D:/Projects/dsh-exp/ds-harness-remote`。取 `git -C <上游> describe --tags`、`git -C <上游> rev-parse HEAD`、`git -C <上游> rev-parse --is-shallow-repository`。
3. 打包脚本默认从上述路径取产物，可用环境变量 `DSH_REMOTE_UPSTREAM` 覆盖，见 `packages/plugin/scripts/build-server.mjs`。

## 必须保持与上游一致的契约

以下内容任何一处改变都属于破坏性协议变更，Host 与客户端必须同时升级；同步时照抄上游原文，不夹带本地风格改动。表中 plugin 路径按本仓库当前状态列出；某文件已被裁剪删除时，以上游同名文件为准，动手前先确认文件是否存在。

| 契约 | 权威位置 | 破坏性改动 |
| --- | --- | --- |
| 中继 HTTP 路由 /api/v1/auth/login、/auth/me、/auth/logout、/auth/refresh、/account/devices、/devices、/devices/register、/devices/register-owned-role、/devices/self、/me、/turn/credentials，以及 /health、/healthz、/ready | `apps/server/src/server.ts`（上游） | 增删路径、状态码或响应字段 |
| 中继 WebSocket 路径只接受 `/ws/v1/connect` | `apps/server/src/gateway.ts:141-142`；客户端拼接见上游 `packages/plugin/src/client-runtime-contract.ts:175` 与本仓库 `packages/plugin/src/server-connection.ts:1410` | 路径或拼接方式变化 |
| Noise IK 套件名 `Noise_IK_25519_ChaChaPoly_SHA256` | `packages/crypto/src/noise.ts:11` | 套件名或校验逻辑变化 |
| Noise 序言结构与字面量顺序：DSH-REMOTE、v=1、connection、host、client，以 NUL 分隔 | `packages/crypto/src/noise.ts:141-146` | 字段、顺序或分隔变化 |
| 密钥派生 salt 与 AEAD 附加数据 `dsh-remote-v1`；算法 ChaCha20-Poly1305 | `packages/crypto/src/index.ts:27`、`:32`、`:41` | 任一参数变化 |
| 协议版本 `PROTOCOL_VERSION` | `packages/protocol/src/index.ts:33` | 数值变化 |
| 恢复能力串 `transport.relay.resume.v1`、`transport.webrtc.resume.v1` | `packages/protocol/src/index.ts:5-6` | 字符串变化 |
| 能力数组上限 `MAX_REMOTE_CAPABILITY_ENTRIES` = 128 | `packages/protocol/src/index.ts:57` | 上限变化 |
| RPC 方法名 `rpcMethods` | `packages/protocol/src/index.ts:148-200` | 增删改名 |
| 服务端事件名 `remoteEvents` | `packages/protocol/src/index.ts:202-215` | 增删改名 |
| 错误码 `errorCodes` | `packages/protocol/src/index.ts:217-262` | 增删改名 |
| 桥接白名单 `HARNESS_REMOTE_ALLOWLIST` 与端点字符串校验 | `packages/plugin/src/harness-remote-bridge.ts:112-199`，校验在 `:61` | 白名单条目增删 |
| 能力协商 hostCapabilities | `packages/plugin/src/service.ts:521-539`（fork 裁剪后为 `:371-383`） | 能力串增删改 |
| 客户端能力探测 probeRemoteHostFeatures | `packages/plugin/src/client-capabilities.ts:21-76` | 消费的能力串或失败文案变化 |
| 路由层 `HOST_CAPABILITIES` 与 `apiMethods` | `packages/plugin/src/rpc-router.ts:64-73`、`:26-62`（fork 已删 ACP 项） | 列表增删 |
| 打包中继的版本与产物哈希 | `packages/plugin/server/version.json`，由 build-server.mjs 生成 | pluginVersion 与插件不一致即启动失败 |

## 只读对比流程

1. 看远端有没有新 tag：`git ls-remote --tags https://github.com/liguobao/ds-harness-remote.git`。不要用本地 `git tag` 断言没有新版本，参考克隆是浅克隆，历史 tag 不在本地。
2. 看主干提交：`git ls-remote --heads https://github.com/liguobao/ds-harness-remote.git` 取 main 哈希。tag 才是升级依据，main 领先不构成必须跟随。
3. 取某一提交的源码做逐文件对比，在 `.scratch/`（已被 .gitignore 忽略）建部分克隆：

```powershell
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/liguobao/ds-harness-remote.git .scratch/upstream-compare
git -C .scratch/upstream-compare sparse-checkout init --cone
git -C .scratch/upstream-compare sparse-checkout set packages/protocol packages/crypto packages/plugin/src apps/server
git -C .scratch/upstream-compare checkout <ref>
```

4. 先看范围，再逐文件：

```powershell
git diff --no-index --stat <旧目录>/packages/protocol/src <新目录>/packages/protocol/src
git diff --no-index --stat <旧目录>/packages/crypto/src <新目录>/packages/crypto/src
git diff --no-index --stat <旧目录>/packages/plugin/src <新目录>/packages/plugin/src
git diff --no-index --stat <旧目录>/apps/server/src <新目录>/apps/server/src
```

5. 确认协议包有没有被 fork 改过：`git -C . diff --stat fd2901d..HEAD -- packages/protocol packages/crypto packages/webrtc`。输出为空说明三个包仍是上游原文；出现输出说明有人改动过协议层，先查清再升级。
6. 直接抓 raw.githubusercontent 在本机经常失败，比对一律走两份工作树加 `git diff --no-index`；不要用提交标题推断代码差异。

## 差异分类

必跟（协议层）：`packages/protocol/src`、`packages/crypto/src`、`apps/server/src`，以及上表命中的白名单、能力串、RPC 方法名、事件名、错误码。落在这些位置的改动一律同步，并保持上游原文。

需要判断：`packages/webrtc/src` 与 `packages/plugin/src` 里的契约文件（harness-remote-bridge.ts、client-capabilities.ts、client-secure-transport.ts、client-runtime-contract.ts、workspace-bridge.ts、typert-gateway-contract.ts）。这些文件在 fork 中保持原文；升级前先确认改动与已裁剪的业务不冲突。

不跟（业务层）：ACP 与 codex 桥接、Android、Web 与 TUI 界面、云账号与 gateway 路由（`packages/plugin/src/server-api.ts` 已裁剪）、`apps/server/web` 前端、README 与 docs 文案、examples 与 fixtures。判定方法：`git -C . diff --stat fd2901d..HEAD -- <路径>` 看 fork 是否已裁剪该文件；已裁剪且与新协议无关的不跟。

## 同步步骤

1. 准备可写的上游工作副本。参考克隆保持只读，不在里面 install、build、checkout：

```powershell
git clone https://github.com/liguobao/ds-harness-remote.git D:/Projects/dsh-exp/ds-harness-remote-build
cd D:/Projects/dsh-exp/ds-harness-remote-build
git checkout <新 tag>
pnpm install
pnpm --filter @dsh-remote/server build
```

2. 协议层：把差异文件按上游新版本的原文写入本仓库对应路径，包括 `packages/protocol/src`、`packages/crypto/src` 与命中的 `packages/plugin/src` 契约文件。
3. 重新打包中继：`pnpm build:server`。脚本用 esbuild 把上游 `apps/server/dist/main.js` 打成 CJS、内联 `dist/public`、写 `packages/plugin/server/version.json`，并在随机空闲端口启动产物、用临时账号轮询 `/health` 自检。
4. 四处同步版本：根 `package.json`、`packages/plugin/package.json`、`packages/plugin/src/version.ts`、`packages/plugin/server/version.json` 的 `pluginVersion`。前三处由 `node packages/plugin/scripts/verify-version-sync.mjs` 校验，第四处由运行期的 readServerBundleInfo 校验。
5. 文档只改必要处：流程写进 `docs/development.md`；README 不重复协议细节。

## 验证

1. 类型检查与整体构建：`pnpm -r build`。插件构建会先跑 `verify-version-sync`，再做 tsc 与 esbuild，版本不同步会当场失败。
2. 协议包单测：`pnpm --filter @dsh-remote/protocol test`，或只跑相关的 `npx vitest run packages/protocol/tests/<文件>`。默认不跑全量测试，开窗口与占显卡的用例会影响本机使用。
3. 中继自检结果看 `pnpm build:server` 的输出，失败会直接抛错。
4. 运行链路：`tailscale serve status --json` 中 443 指向 `http://127.0.0.1:8080`；`curl https://<DNSName>/health` 返回 `status ok`；面板四步状态正常；客户端连接后逐字收到输出。
5. 本地验证必须用独立 `DSH_HOME` 与 `--profile dev --no-open`，禁止 `--profile web`。

## 常见陷阱

- 本机同时运行 Desktop 实例，`--profile web` 会与它冲突；验证统一用独立 `DSH_HOME` 加 `--profile dev --no-open`。
- `127.0.0.1:3080` 是常驻开发服务，不属于 tailnet 中继，不要重启或关闭。
- `127.0.0.1:8080` 上运行的是当前中继，重启会让已连接客户端断线；接手验证前先确认它是否必须由本次操作接管。
- 上游参考克隆是浅克隆，本地看不到历史 tag；判断新版本用 `git ls-remote --tags`。
- 中继产物是 CJS bundle（target node20）。改了 protocol 或 server 后必须重新 `pnpm build:server`，否则 version.json 与代码不一致，运行期报 `RELAY_VERSION_MISMATCH`。
- `packages/plugin/server/dist/main.cjs` 被 gitignore，不作为源码编辑；中继源码在上游 `apps/server/src`。
- fork 已删除 ACP 与 codex 的业务实现，hostCapabilities 不再推送 agent.acp.*。上游若把某项能力移到协议必需层，先重新评估再跟。
- Noise 套件名、序言、salt 与附加数据属于破坏性契约，Host 与客户端必须同时升级。
- 上游自检会占用临时端口并写临时数据文件，不要复用真实的 state.json。
- 本仓库工作区可能正被并行会话改动。同步前先 `git status --porcelain` 查看现状，不要把他人未完成的裁剪当成基线；协议包是否被改过用提交范围判断，不要看工作树。
- 只读调研时不得在上游参考克隆里执行 install、build、checkout 等写操作；对比产物放 `.scratch/`。

## 纪律

- 只读命令优先，写入只落在本仓库必要文件与 `.scratch/`。
- 不用 git 回滚代码；需要恢复时手工编辑文件。
- 不跑全量构建与测试、不重启服务，除非任务明确要求。
