# Remote Over Tailnet

项目全名 `dsh-remote-over-tailnet`，文档中简称 ROT。

ROT 是 DeepSeek Harness Desktop 的 Host 插件，主要面向 Windows 上的 DeepSeek Harness Desktop 用户：开启远程服务后，同一 tailnet 内的 DSH Remote 客户端可以继续操作本机正在运行的会话，逐字流式输出保持原样，电脑不需要公网 IP、端口映射或第三方网关。DSH Go 是其中一个安卓客户端，任何接入 DSH Remote 的程序都可以连接。

衍生自 MIT 项目 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)。ROT 去掉了对公共网关的依赖，改为在本机启动中继服务器，再由插件内嵌的 Tailscale 节点（编译成 WebAssembly 的 tsnet）把它接入 tailnet。客户端只需填写侧栏入口弹窗里的地址和账号密码。

## 前置条件

- Windows 上的 DeepSeek Harness Desktop 0.2.2-rc.1 或兼容版本
- 一个可用的 tailnet 账号；本机如何加入 tailnet 由插件自己完成，不需要安装系统 Tailscale
- 客户端设备与电脑在同一个 tailnet，且已安装 Tailscale；客户端需支持 DSH Remote（例如安卓上的 DSH Go）

## 使用

1. 安装 ROT，重启 DeepSeek Harness Desktop。
2. 打开「插件 → Remote Over Tailnet → 远程设置」，打开「远程服务」开关。
3. 首次开启时，左下角「Remote Over Tailnet」入口的弹窗给出授权链接，在浏览器里点开并登录 tailnet 账号、同意加入；授权完成后弹窗里出现服务地址。
4. 弹窗会显示 DSH Remote 服务器地址、账号与密码。在客户端中添加自定义服务器，填入这三项登录。

插件开启远程服务时会自动完成这些步骤，不需要命令行：

- 启动内嵌 Tailscale 节点，节点名固定为 `dsh-remote`，首次需要一次浏览器授权（也可以在配置里填 `tailnet.authKey` 跳过这一步）
- 生成中继账号与密码，保存在 `$DSH_HOME/dsh-remote-over-tailnet/tailnet/`（权限 0600）
- 在 `127.0.0.1:8080` 启动中继服务器
- 让内嵌节点在 tailnet 内监听 80 端口并转发到本机中继

中继只监听回环地址，tailnet 内的节点通过 WireGuard 访问 `http://dsh-remote.<你的 tailnet>`（地址里不写端口）。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `http://127.0.0.1:8080` | 中继地址，必须是 http 回环地址，端口即中继端口 |
| `tailnet.enabled` | `true` | 关闭后不启动内嵌节点、不启动中继 |
| `tailnet.authKey` | 空 | 可选的 tailnet 授权密钥，填了就跳过首次的浏览器授权 |
| `tailnet.dataDirectory` | `$DSH_HOME/dsh-remote-over-tailnet/tailnet` | 账号密码、内嵌节点状态、relay.lock、relay.log 与中继 state.json 的存放目录，可改到其他磁盘 |

身份目录按 `serverUrl` 的 origin 做哈希，改变中继端口等于更换 Host 身份，因此端口应保持稳定。

## 限制

- 内嵌节点只提供 tailnet 内的访问，不做 Funnel，tailnet 之外的设备连不上。
- 不修改客户端，也不支持扫码配对，需要在客户端中手动填写服务器地址与账号密码。本插件面向所有接入 DSH Remote 的客户端，DSH Go 只是其中之一。
- 本插件与 Tailscale Inc.、DeepSeek 均无关联，未获其背书。

## 更多文档

- [Tailscale 要求与排障](docs/tailscale.md)
- [开发、构建与本地验证](docs/development.md)

## 许可

MIT。保留上游 LICENSE 与 NOTICE，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
