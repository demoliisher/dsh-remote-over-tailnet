# Tailscale 要求与排障

阶段一直接复用系统安装的 Tailscale，插件不创建新的 tailnet 节点。

## 前置条件

- 电脑已安装 Tailscale，已登录，`tailscale status --json` 的 `BackendState` 为 `Running`、`Self.Online` 为 `true`。
- 手机与电脑在同一个 tailnet，手机 Tailscale 在线。
- tailnet 已开启 HTTPS Certificates：Tailscale 管理台 → DNS → HTTPS Certificates。开启后 Tailscale 会为节点签发 `https://<节点名>.<tailnet>.ts.net` 证书。

## 插件会做什么

| 步骤 | 动作 | 失败时的提示 |
| --- | --- | --- |
| Tailscale | 读取 `tailscale status --json`，取节点 DNSName 与证书域名 | 未安装、未登录、未运行、离线、无域名，各有对应中文提示 |
| 本地中继 | 以固定账号密码在 `127.0.0.1:<端口>` 启动中继服务器，数据写入 `$DSH_HOME/ds-harness-remote/tailnet/` | 端口被占用、版本不匹配、已有实例在运行 |
| HTTPS 地址 | 执行幂等的 `tailscale serve --bg --https=443 http://127.0.0.1:<端口>`，并复查实际转发目标 | 证书未开启时提示去管理台开启，并给出管理台地址 |
| Host 授权 | 用中继账号密码登录并注册本机 Host 身份 | 账号或密码与服务端不一致时提示并自动重建中继数据 |

验证命令：

```powershell
tailscale serve status --json
```

输出中应出现 `Web["<DNSName>:443"].Handlers["/"].Proxy` 等于 `http://127.0.0.1:8080`（端口以实际配置为准）。

## 常见问题

### 面板提示 HTTPS 证书未开启

到 Tailscale 管理台开启 HTTPS Certificates，等待证书签发后点面板的「重新检测」。开启后首次签发证书可能需要几十秒，插件已把 serve 调用超时放宽到 180 秒。

### 另一实例已启动中继

中继同一时间只能被一个 DSH 实例占用。关闭其他正在运行的 DSH 实例后重试。插件会在 `$DSH_HOME/ds-harness-remote/tailnet/relay.lock` 记录监督进程与中继进程；上次退出异常留下的中继进程会被检测并终止。

### 端口被占用

如果 `127.0.0.1:8080` 被其他程序占用，插件会报端口冲突且不会杀进程。请释放端口，或修改 `serverUrl` 的端口。修改端口会更换身份目录，需要重新授权。

### 手机打不开地址

依次确认：手机 Tailscale 在线；能解析节点域名；浏览器打开 `https://<DNSName>/health` 返回 `{"status":"ok"}`。dsh-go 中填写的应是 `https://` 地址，不能填回环地址。

### 账号密码丢了

凭据保存在 `$DSH_HOME/ds-harness-remote/tailnet/credentials.json`（权限 0600）。面板的「显示」可以查看并复制；删除该文件后插件会重新生成账号密码，中继数据中的旧令牌随之失效，Host 会自动重新注册。

### 想放到数据盘

把配置里的 `tailnet.dataDirectory` 改到数据盘目录。中继的 `state.json`、日志、锁与凭据都会写入该目录。

## 安全边界

- 中继只监听 `127.0.0.1`，不向局域网或公网开端口；对外入口只有 Tailscale 的 443。
- Tailscale 负责 TLS 终止与设备身份；插件不额外暴露管理接口。
- 账号密码只写入权限 0600 的文件，面板按需读取，不写日志。
- 使用范围受 tailnet ACL 约束；如需限制手机访问，请在 Tailscale 管理台配置 ACL。
