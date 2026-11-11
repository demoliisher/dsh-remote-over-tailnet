# Remote Over Tailnet

`dsh-remote-over-tailnet`（文档简称 ROT）是 Windows 上 DeepSeek Harness Desktop 的 Host 插件：通过 Tailscale 组网，从同一 tailnet 内的 DSH Remote 客户端连接本机正在运行的会话，支持逐字流式输出，无需公网网关。DSH Go 是其中一个安卓客户端。

## 主要功能

- 复用电脑上已安装的 Tailscale，不需要公网 IP、端口映射或第三方中继。
- 插件自动在回环地址启动中继服务器，并幂等配置 `tailscale serve` 对外发布 HTTPS 地址。
- 面板显示 DSH Remote 服务器地址、账号、密码，以及 Tailscale、中继、HTTPS 地址、Host 授权四步状态。
- 连接的是本机正在运行的 DeepSeek Harness Desktop 会话，支持逐字流式输出；不修改客户端。

## 开始使用

1. 在 DeepSeek Harness Desktop 安装并启用 ROT，重启 Desktop。
2. 打开「插件 → Remote Over Tailnet → 远程设置」，等待四步状态完成。
3. 在 DSH Remote 客户端（例如 DSH Go）中添加自定义服务器，填入面板显示的 HTTPS 地址与账号密码。

前置条件：客户端设备与电脑在同一 tailnet，电脑已登录 Tailscale，tailnet 已开启 HTTPS Certificates。

本项目衍生自 MIT 项目 ds-harness-remote，与 Tailscale Inc.、DeepSeek 均无关联。
