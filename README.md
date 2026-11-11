# DSH Remote over Tailscale

通过 Tailscale 从手机继续使用本机 DeepSeek Harness 会话的 Host 插件。衍生自 MIT 项目 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，去掉公共网关依赖：插件在本机启动中继服务器，用系统已安装的 Tailscale 把它发布成 HTTPS 地址。手机端 dsh-go 只需填写这个地址和面板上的账号密码，即可连上**已经跑着的** Desktop 会话，逐字流式输出保持原样。

## 前置条件

- DSH Desktop 0.2.2-rc.1 或兼容版本
- 电脑已安装 Tailscale 并登录，节点在线
- tailnet 已开启 HTTPS Certificates（Tailscale 管理台 → DNS）
- 手机与电脑在同一个 tailnet，手机已安装 Tailscale 与 dsh-go

## 使用

1. 安装插件，重启 DSH Desktop。
2. 打开「插件 → DSH Remote over Tailscale → 远程设置」，等待三步状态变为完成。
3. 面板会显示 DSH Go 服务器地址、账号与密码（可显示、可复制）。在 dsh-go 中添加自定义服务器，填入这三项登录。

插件启动时会自动完成这些步骤，不需要命令行：

- 检测 `tailscale status --json`：安装、登录、在线、设备域名
- 生成中继账号与密码，保存在 `$DSH_HOME/ds-harness-remote/tailnet/`（权限 0600）
- 在 `127.0.0.1:8080` 启动中继服务器
- 确保 `tailscale serve` 把 443 转发到该端口；已存在且目标一致时跳过，不一致时修正

中继只监听回环地址，公网入口由 Tailscale 提供并终止 TLS。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `http://127.0.0.1:8080` | 中继地址，必须是 http 回环地址，端口即中继端口 |
| `tailnet.enabled` | `true` | 关闭后不检测 Tailscale、不启动中继、不配置 serve |
| `tailnet.servePort` | `443` | tailscale serve 对外提供的 HTTPS 端口 |
| `tailnet.dataDirectory` | `$DSH_HOME/ds-harness-remote/tailnet` | 账号密码、relay.lock、relay.log 与中继 state.json 的存放目录，可改到其他磁盘 |

身份目录按 `serverUrl` 的 origin 做哈希，改变中继端口等于更换 Host 身份，因此端口应保持稳定。

## 限制

- 阶段一复用系统 Tailscale，电脑必须安装并运行 Tailscale；内嵌 tsnet 的阶段二尚未实现。
- 不修改 dsh-go，也不支持它的扫码配对，需要在 dsh-go 中手动填写服务器地址与账号密码。
- 本插件与 Tailscale Inc.、DeepSeek 均无关联，未获其背书。

## 更多文档

- [Tailscale 要求与排障](docs/tailscale.md)
- [开发、构建与本地验证](docs/development.md)

## 许可

MIT。保留上游 LICENSE 与 NOTICE，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
