# Remote Over Tailnet

`dsh-remote-over-tailnet`（文档简称 ROT）是 Windows 上 DeepSeek Harness Desktop 的 Host 插件：插件内嵌一个 WebAssembly 版的 Tailscale 节点，把本机正在运行的会话接入 tailnet，供同一 tailnet 内的 DSH Remote 客户端远程连接，保留逐字流式输出。DSH Go 是其中一个安卓客户端。

## 主要功能

- 自带 Tailscale 节点，电脑不需要安装系统 Tailscale，也不需要公网 IP、端口映射或第三方中继。
- 插件自动在回环地址启动中继服务器，让内嵌节点在 tailnet 内监听并转发到中继。
- 左下角入口的弹窗显示 DSH Remote 服务器地址、账号、密码。
- 连接的是本机正在运行的 DeepSeek Harness Desktop 会话，支持逐字流式输出；不修改客户端。

## 开始使用

1. 在 DeepSeek Harness Desktop 安装并启用 ROT，重启 Desktop。
2. 打开「插件 → Remote Over Tailnet → 远程设置」，在「DSH Remote 本地中继服务」那一行右侧打开开关。
3. 首次开启时左下角入口的弹窗给出授权链接，在浏览器里登录 tailnet 账号并同意加入；也可以在配置里填 `tailnet.authKey` 跳过这一步。
4. 在 DSH Remote 客户端（例如 DSH Go）中添加自定义服务器，填入弹窗显示的地址与账号密码。

前置条件：客户端设备与电脑在同一个 tailnet，且客户端设备的 Tailscale 在线。与上游插件 `ds-harness-remote` 可以同时启用，两者各用各的控制接口与界面入口；细节见仓库根目录的 `docs/tailscale.md`。

本项目衍生自 MIT 项目 ds-harness-remote，与 Tailscale Inc.、DeepSeek 均无关联。
