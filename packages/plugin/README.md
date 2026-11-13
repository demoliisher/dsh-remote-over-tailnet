# dsh-remote-over-tailnet

DeepSeek Harness Desktop 的 Host 插件，项目文档简称 ROT。主要面向 Windows 上的 DeepSeek Harness Desktop 用户：插件内嵌一个 WebAssembly 版的 Tailscale 节点，把本机正在运行的会话接入 tailnet，供同一 tailnet 内的 DSH Remote 客户端远程连接，保留逐字流式输出。DSH Go 是其中一个安卓客户端，任何接入 DSH Remote 的程序都可以连接。

插件启动时自动启动内嵌节点、在回环地址启动中继、让节点在 tailnet 内监听并转发到中继，并在面板显示服务器地址、账号与密码。客户端不需要修改，手动填写这三项即可。

## 安装

在 DeepSeek Harness Desktop 的插件管理中从 npm 安装当前版本，然后重启 Desktop：

```text
dsh-remote-over-tailnet@0.6.4
```

也可以使用官方 `dsh` 启动器安装到对应 profile。本地开发时可用 `link:` 指向仓库，参考根目录的 `docs/development.md`。

## 前置条件

- Windows 上的 DeepSeek Harness Desktop 0.2.2-rc.1 或兼容版本
- 一个可用的 tailnet 账号；电脑不需要安装系统 Tailscale
- 客户端设备与电脑在同一 tailnet，且已安装 Tailscale

## 说明

首次开启远程服务时面板会给出一次授权链接，也可以填 `tailnet.authKey` 跳过浏览器授权。节点名固定为 `dsh-remote`，对外地址为 `http://dsh-remote.<tailnet>.ts.net:<端口>`。详细要求与排障见仓库根目录的 `docs/tailscale.md`。

本项目衍生自 MIT 项目 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，保留其 LICENSE 与 NOTICE；与 Tailscale Inc.、DeepSeek 均无关联，未获其背书。
