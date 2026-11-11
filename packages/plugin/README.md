# dsh-remote-over-tailnet

DeepSeek Harness Desktop 的 Host 插件，项目文档简称 ROT。主要面向 Windows 上的 DeepSeek Harness Desktop 用户：复用系统已安装的 Tailscale，把本机正在运行的会话发布成 tailnet 内的 HTTPS 地址，供同一 tailnet 内的 DSH Remote 客户端远程连接，保留逐字流式输出。DSH Go 是其中一个安卓客户端，任何接入 DSH Remote 的程序都可以连接。

插件启动时自动检测 Tailscale、在回环地址启动中继、配置 `tailscale serve`，并在面板显示服务器地址、账号与密码。客户端不需要修改，手动填写这三项即可。

## 安装

在 DeepSeek Harness Desktop 的插件管理中从 npm 安装当前版本，然后重启 Desktop：

```text
dsh-remote-over-tailnet@0.6.4
```

也可以使用官方 `dsh` 启动器安装到对应 profile。本地开发时可用 `link:` 指向仓库，参考根目录的 `docs/development.md`。

## 前置条件

- Windows 上的 DeepSeek Harness Desktop 0.2.2-rc.1 或兼容版本
- 电脑已安装 Tailscale 并登录，客户端设备在同一 tailnet
- tailnet 已开启 HTTPS Certificates

## 说明

阶段一复用系统 Tailscale，电脑必须运行 Tailscale；内嵌 tsnet 的阶段二尚未实现。详细要求与排障见仓库根目录的 `docs/tailscale.md`。

本项目衍生自 MIT 项目 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，保留其 LICENSE 与 NOTICE；与 Tailscale Inc.、DeepSeek 均无关联，未获其背书。
