# 内嵌节点与排障

ROT 不依赖系统安装的 Tailscale：插件把 tsnet 编译成 WebAssembly 放进自己的 Node 进程里运行，作为独立节点加入 tailnet，节点名固定为 `dsh-remote`。

## 前置条件

- 一个可用的 tailnet 账号。电脑本身不需要安装 Tailscale，加入 tailnet 由插件完成。
- 客户端设备与电脑在同一个 tailnet，客户端设备的 Tailscale 在线。
- 只提供 tailnet 内的访问，不做 Funnel。

## 插件会做什么

| 步骤 | 动作 | 失败时的提示 |
| --- | --- | --- |
| 内嵌节点 | 在 `<数据目录>/node/` 保存节点身份并启动 wasm 版 tsnet；首次使用给出授权链接 | 未授权时左下角入口的弹窗显示授权链接；填了 `tailnet.authKey` 则直接注册 |
| 本地中继 | 以固定账号密码在 `127.0.0.1:<端口>` 启动中继服务器 | 端口被占用、版本不匹配、已有实例在运行 |
| tailnet 监听 | 节点在 tailnet 的 80 端口监听，每个入站连接转发到本机中继；这个监听发生在用户态网络实现里，不占用宿主机端口 | 节点已监听但回环中继不通时提示 `TAILNET_LISTEN_UNREACHABLE` |
| Host 授权 | 用中继账号密码登录并注册本机 Host 身份 | 账号或密码与服务端不一致时提示并自动重建中继数据 |

验证方式：在任意一台已登录 tailnet 的设备上执行 `tailscale status`，能看到 `dsh-remote` 节点；用浏览器打开弹窗里显示的服务地址加 `/health`，返回 `{"status":"ok"}`。

## 密钥过期

节点密钥默认 180 天后过期，过期后需要重新授权才能继续使用。放在家里长期运行的电脑建议在 Tailscale 管理台关闭这个节点的密钥过期：Devices → 选择 `dsh-remote` → Disable key expiry。服务器每天都要用浏览器点一次授权显然不现实，所以这一步是一次性的必要设置。

## 常见问题

### 首次开启时给出授权链接

在浏览器打开链接，登录 tailnet 账号并同意加入。授权完成后弹窗里会出现服务地址，不需要重启。若希望完全跳过人工授权，把 `tailnet.authKey` 填成管理台生成的授权密钥（建议勾选 pre-approved，且不复用给其他设备）。

### 提示监听失败

内嵌节点已经在 tailnet 内监听，但节点自己访问服务地址的 `/health` 没有成功。先确认中继是否在运行，再看插件日志中的 `TAILNET_LISTEN_UNREACHABLE` 细节；`relay.log` 在数据目录下。

### 另一个实例已启动中继

中继同一时间只能被一个 DSH 实例占用。关闭其他正在运行的 DSH 实例后重试。插件会在 `$DSH_HOME/dsh-remote-over-tailnet/tailnet/relay.lock` 记录监督进程与中继进程；上次退出异常留下的中继进程会被检测并终止。

### 端口被占用

如果 `127.0.0.1:8080` 被其他程序占用，插件会报端口冲突且不会杀进程。请释放端口，或修改 `serverUrl` 的端口。修改端口会更换身份目录，需要重新授权。

### 客户端打不开地址

依次确认：客户端设备的 Tailscale 在线；能解析 `dsh-remote.<tailnet>.ts.net`；服务地址是 `http://dsh-remote.<tailnet>.ts.net` 这样的域名，不能填回环地址。在电脑上用弹窗里的地址访问 `/health` 能通，说明插件侧正常，问题在客户端的网络或 tailnet ACL。

### 节点要重新登录

删除数据目录下的 `node/` 目录后重新开启中继服务，插件会重新注册节点并给出新的授权链接。

### 账号密码丢了

凭据保存在 `$DSH_HOME/dsh-remote-over-tailnet/tailnet/credentials.json`（权限 0600）。弹窗里可以查看并复制；删除该文件后插件会重新生成账号密码，中继数据中的旧令牌随之失效，Host 会自动重新注册。

### 和 ds-harness-remote 同时安装

上游插件 `ds-harness-remote` 也实现 DSH Remote，两边可以同时安装，与加载顺序无关：

- 控制接口：本插件用自己的前缀 `/dsh-remote-over-tailnet`，界面入口、设置项与语言包也用自己的名字，不会顶掉对方的接口或在浏览器里抢先挂载。
- 服务名：`dshRemote` 是对外约定，上游插件启用时本插件不再注册自己的实例，把服务名让给它；本插件照常运行，弹窗与客户端走自己的控制接口。
- 局域网直传：上传路径仍是 `/ds-harness-remote/upload/<ticket>`，这是与客户端约定的协议路径，两边一致。

一个 profile 里同时开两个远程入口没有实际用处，客户端填一处地址即可：要 `ds-harness-remote` 的公共网关或其他功能就留着它，只用 tailnet 直连时卸载它、只留本插件。

### 想放到数据盘

把配置里的 `tailnet.dataDirectory` 改到数据盘目录。节点状态、凭据、中继的 `state.json`、日志与锁都会写入该目录。

## 安全边界

- 中继只监听 `127.0.0.1`，不向局域网或公网开端口；唯一对外入口是内嵌节点在 tailnet 内的 80 端口，链路本身由 WireGuard 加密。
- 不做 TLS 证书、不做 `tailscale serve` 与 Funnel，因此没有证书签发问题，也不受 443 端口占用影响。
- 账号密码只写入权限 0600 的文件，弹窗按需读取，不写日志。
- 使用范围受 tailnet ACL 约束；如需限制客户端访问，请在 Tailscale 管理台配置 ACL。
