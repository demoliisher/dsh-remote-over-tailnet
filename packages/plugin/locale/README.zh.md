# DSH Remote over Tailscale

通过 Tailscale 组网，从手机端远程连接本机 DeepSeek Harness 会话，支持逐字流式输出，无需公网网关。

## 主要功能

- 复用电脑上已安装的 Tailscale，不需要公网 IP、端口映射或第三方中继。
- 插件自动在回环地址启动中继服务器，并幂等配置 `tailscale serve` 对外发布 HTTPS 地址。
- 面板显示 DSH Go 服务器地址、账号、密码，以及 Tailscale、中继、HTTPS 地址、Host 授权四步状态。
- 连接的是本机正在运行的 DSH Desktop 会话，支持逐字流式输出；不修改 dsh-go。

## 开始使用

1. 在 DSH Desktop 安装并启用插件，重启 Desktop。
2. 打开「插件 → DSH Remote over Tailscale → 远程设置」，等待四步状态完成。
3. 在手机 dsh-go 中添加自定义服务器，填入面板显示的 HTTPS 地址与账号密码。

前置条件：电脑与手机在同一 tailnet，电脑已登录 Tailscale，tailnet 已开启 HTTPS Certificates。

本项目衍生自 MIT 项目 ds-harness-remote，与 Tailscale Inc.、DeepSeek 均无关联。
