# Deepseek Harness Remote Over Tailnet

[![CI](https://github.com/demoliisher/dsh-remote-over-tailnet/actions/workflows/ci.yml/badge.svg)](https://github.com/demoliisher/dsh-remote-over-tailnet/actions/workflows/ci.yml)

项目全名 `dsh-remote-over-tailnet`，文档中简称 ROT。

ROT 是 DeepSeek Harness Desktop 的 Host 插件，主要面向 Windows 上的 DeepSeek Harness Desktop 用户：开启中继服务后，同一 tailnet 内的 DSH Remote 客户端可以继续操作本机正在运行的会话，逐字流式输出保持原样，电脑不需要公网 IP、端口映射或第三方网关。DSH Go 是其中一个安卓客户端，任何接入 DSH Remote 的程序都可以连接。

衍生自 MIT 项目 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)。ROT 去掉了对公共网关的依赖，改为在本机启动中继服务器，再通过 Tailscale 把它接入 tailnet。默认使用本机已装并已登录的 Tailscale 客户端；也可以按需下载 wasm 版 tsnet 作为内嵌节点。客户端只需填写侧栏入口弹窗里的地址和账号密码。

## 前置条件

- Windows、macOS 或 Linux 上的 DeepSeek Harness Desktop 0.2.2-rc.1 或兼容版本
- 系统模式：本机已安装并登录 Tailscale 客户端；内嵌模式：在面板下载 wasm 组件后由插件自行加入 tailnet。两种方式二选一
- 客户端设备与电脑在同一个 tailnet，且已安装 Tailscale；客户端需支持 DSH Remote（例如安卓上的 DSH Go）

## 安装

把 ROT 装进要对外提供远程访问的那个 profile。DeepSeek Harness Desktop 启动的是 `desktop` profile，`dsh web` 命令行服务启动的是 `web` profile，两者互不相干。装完重启 DeepSeek Harness Desktop：

```powershell
dsh plugin --profile desktop add dsh-remote-over-tailnet
```

也可以在插件页点「添加插件」（Add plugin）选中已经构建好的插件目录，这种方式适合自己构建的用户，构建步骤见[开发、构建与本地验证](docs/development.md)。仓库里不保存构建产物，直接克隆源码的目录装不了。

## 使用

1. 安装 ROT，重启 DeepSeek Harness Desktop。
2. 打开「插件 → Remote Over Tailnet → 远程设置」，确认「组网模式」为系统 Tailscale（默认），在「DSH Remote 本地中继服务」那一行右侧打开开关。
3. 首次开启时，左下角「Remote Over Tailnet」入口的弹窗会显示组网状态：系统 Tailscale 已登录时直接给出服务地址；已安装未登录时按提示登录并点「刷新」；要用内嵌节点则先下载组件再切换模式，首次开启按提示在浏览器里授权。
4. 弹窗会显示 DSH Remote 服务器地址、账号与密码。在客户端中添加自定义服务器，填入这三项登录。
5. 要在 DSH Go 里用 SSH 直连（不经过中继、也不经过第三方服务器），在同一个弹窗的「SSH 服务」那一行右侧打开开关，把「通用连接信息」里的地址、账号、密码，加上 SSH 端口 22、「DSH 端口」与 DSH 登录令牌填进 DSH Go 的「添加 SSH 主机」，实例管理选「只连接」。点一下「DSH 端口」右侧的「固定」，之后客户端配置只需要做一次。这一步不要求「中继服务」开着，两套服务各自独立。详见 [SSH 直连](docs/ssh.md)。

插件开启中继服务时会自动完成这些步骤，不需要命令行：

- 读取系统 Tailscale 客户端的状态与地址（系统模式），或启动内嵌 wasm 节点（内嵌模式，首次需要一次浏览器授权，也可填 `tailnet.authKey` 跳过）
- 生成中继账号与密码，保存在 `$DSH_HOME/dsh-remote-over-tailnet/tailnet/`（权限 0600）
- 在 `127.0.0.1:8080` 启动中继服务器
- 在 tailnet 地址上对外监听：系统模式 8080、内嵌模式 80，转发到本机中继

中继进程只监听回环地址，对外监听绑定在 tailnet 地址与回环，物理局域网无法访问。系统模式的客户端地址形如 `http://<节点名>.<你的 tailnet>:8080`，内嵌模式形如 `http://dsh-remote.<你的 tailnet>`（80 端口不写）。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `http://127.0.0.1:8080` | 中继地址，必须是 http 回环地址，端口即中继端口 |
| `tailnet.enabled` | `true` | 关闭后不启动节点、不启动中继 |
| `tailnet.mode` | `system` | `system` 用本机已登录的 Tailscale 客户端，`embedded` 用下载的 wasm 节点 |
| `tailnet.authKey` | 空 | 内嵌模式可选的授权密钥，填了就跳过首次的浏览器授权 |
| `tailnet.dataDirectory` | `$DSH_HOME/dsh-remote-over-tailnet/tailnet` | 账号密码、内嵌节点状态、relay.lock、relay.log 与中继 state.json 的存放目录，可改到其他磁盘 |
| `ssh.enabled` | `false` | 在 tailnet 节点上再开一个 SSH 监听，只放行到当前 DSH Web 端口的隧道 |
| `ssh.pinnedPort` | 空 | 面板「固定」按钮记下的 DSH 端口；实例换端口后由本机回环代理接住旧端口 |

身份目录按 `serverUrl` 的 origin 做哈希，改变中继端口等于更换 Host 身份，因此端口应保持稳定。

## 限制

- 两种模式都只提供 tailnet 内的访问，不做 Funnel，tailnet 之外的设备连不上。
- 内嵌节点组件按需从 GitHub raw 下载，当前不启用其他镜像；下载失败请自行检查网络后重试。
- 可以和上游插件 `ds-harness-remote` 同时安装：控制接口与界面用本插件自己的名字，`dshRemote` 服务名让给上游插件。一个 profile 里保留一个远程入口即可。详见 [Tailscale 要求与排障](docs/tailscale.md)。
- 不修改客户端，也不支持扫码配对，需要在客户端中手动填写服务器地址与账号密码。本插件面向所有接入 DSH Remote 的客户端，DSH Go 只是其中之一。
- 本插件与 Tailscale Inc.、DeepSeek 均无关联，未获其背书。

## 更多文档

- [SSH 直连](docs/ssh.md)
- [Tailscale 要求与排障](docs/tailscale.md)
- [开发、构建与本地验证](docs/development.md)

## 许可

MIT。保留上游 LICENSE 与 NOTICE，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
