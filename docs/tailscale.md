# Tailscale 组网与排障

ROT 支持两种组网模式，在「远程设置 → 组网模式」里切换：

| 模式 | 节点来源 | 对外中继端口 | 对外 SSH 端口 | 前提 |
| --- | --- | --- | --- | --- |
| 系统 Tailscale（默认） | 本机已装并已登录的 Tailscale 客户端 | 8080 | 2222 | 三平台任一安装好并登录的客户端 |
| 内嵌节点 | 按需下载的 wasm tsnet，运行在插件进程里 | 80 | 22 | 先下载内嵌节点组件 |

两种模式下，中继与 SSH 的认证、账号密码、客户端填法完全一致，只有节点来源与端口不同。

## 系统 Tailscale 模式

### 前置条件

- 本机已安装并登录 Tailscale。三个平台的命令行用法接近：安装后登录一次即可，插件直接读取系统客户端的状态与地址。
- 客户端设备与本机在同一个 tailnet，且 Tailscale 在线。
- 只提供 tailnet 内的访问，不做 Funnel。

### Three 平台 CLI 差异

已经装好并登录时，查询状态、地址的命令三平台一致：`tailscale status --json`、`tailscale ip`、`tailscale whoami`。插件用 `status --json` 的 `BackendState`、`AuthURL`、`Self.DNSName`、`Self.TailscaleIPs` 判断安装与登录状态。差异集中在可执行文件的位置：

- Windows：`C:\Program Files\Tailscale\tailscale.exe`。
- macOS Standalone 版：`/usr/local/bin/tailscale`；App Store 版在 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，插件执行时设 `TAILSCALE_BE_CLI=1` 强制走命令行。
- Linux：`tailscale` 在 PATH 里，常见 `/usr/bin/tailscale`。

### 插件会做什么

- 检测系统客户端是否安装、是否登录：未安装提示安装，或改下载内嵌组件；已安装未登录则给出登录引导，登录后在面板点「刷新」。
- 读取本机的 tailnet 域名与 IPv4 作为对外地址。
- 中继进程监听 `127.0.0.1:<serverUrl 端口>`，另在 tailnet 地址上监听 8080 转给中继，供 tailnet 内客户端访问。
- SSH 服务在 tailnet 地址的 2222 端口监听，只放行到当前 DSH Web 端口的转发。绑定只针对 tailnet 地址与回环，物理局域网无法访问。

### 客户端填什么

- 服务器地址：`<本机 tailnet 域名>:8080`（系统模式的 8080 必须写出）。
- SSH：主机填 tailnet 域名，端口 2222。

## 内嵌节点模式

### 前置条件

- 先在「远程设置 → 内嵌节点组件」点「下载组件」。组件从 GitHub raw 下载，失败时请自行检查网络后重试；当前不启用其他镜像。
- 下载成功后，「内嵌节点」选项才可用，切换后插件在进程内加载 wasm tsnet 作为独立节点加入 tailnet，节点名固定为 `dsh-remote`。
- 客户端设备与电脑在同一个 tailnet。

### 插件会做什么

- 首次使用给出授权链接；也可填 `tailnet.authKey` 直接注册。
- 中继进程监听 `127.0.0.1:<serverUrl 端口>`，wasm 节点在 tailnet 的 80 端口监听并转发到中继。
- SSH 服务在 wasm 节点的 22 端口监听。
- 对外地址形如 `http://dsh-remote.<tailnet>.ts.net`（80 端口不写）。

## 通用排障

### 验证连通

在任意一台已登录 tailnet 的设备上执行 `tailscale status`，能看到本机节点；用浏览器打开面板显示的服务地址加 `/health`，返回 `{"status":"ok"}`。

### 密钥过期

节点密钥默认 180 天后过期。长期运行的电脑建议在 Tailscale 管理台关闭对应节点的密钥过期。

### 提示监听失败

节点已在 tailnet 端口监听，但访问本机中继的 `/health` 没有成功。先看插件日志中的 `TAILNET_LISTEN_UNREACHABLE` 细节；`relay.log` 在数据目录下。

### 另一个实例已启动中继

中继同一时间只能被一个 DSH 实例占用。关闭其他正在运行的 DSH 实例后重试。插件会在数据目录的 `relay.lock` 记录进程号。

### 端口被占用

系统模式默认对外 8080、SSH 2222；内嵌模式用 80、22。这些端口在 tailnet 地址上监听。如果被占用，插件报具体错误，请释放后重试，或改配置里的 serverUrl 端口。

### 客户端打不开地址

依次确认：客户端 Tailscale 在线；地址填的是 tailnet 域名或 IP，不是回环地址；系统模式要带 8080 端口；能解析 `<节点名>.<tailnet>.ts.net`。在电脑上用面板地址访问 `/health` 能通，说明插件侧正常，问题在客户端网络或 tailnet ACL。

### 节点要重新登录

系统模式：在系统客户端执行 `tailscale up` 登录后回面板点「刷新」。内嵌模式：删除数据目录下 `node/` 目录后重新开启组网，插件会重新注册并给出新的授权链接。

### 账号密码丢了

凭据保存在数据目录的 `credentials.json`（权限 0600）。弹窗里可以查看并复制；删除后插件重新生成，中继数据中的旧令牌随之失效，Host 会自动重新注册。

### 和 ds-harness-remote 同时安装

上游插件 `ds-harness-remote` 也实现 DSH Remote，两边可以同时安装：

- 控制接口用本插件自己的前缀 `/dsh-remote-over-tailnet`，界面入口、设置项与语言包也用自己的名字。
- 服务名 `dshRemote` 是对外约定，上游插件启用时本插件不再注册自己的实例。
- 局域网直传路径仍是 `/ds-harness-remote/upload/<ticket>`，与客户端协议一致。

### 想放到数据盘

把配置里的 `tailnet.dataDirectory` 改到数据盘目录。节点状态、凭据、中继的 `state.json`、日志、扩展组件与锁都会写入该目录。

## 安全边界

- 中继进程只监听 `127.0.0.1`，对外监听绑定在 tailnet 地址与回环，不向物理局域网或公网开端口；链路本身由 WireGuard 加密。
- 不做 TLS 证书、不做 `tailscale serve` 与 Funnel，没有证书签发问题，也不受 443 端口占用影响。
- 账号密码只写入权限 0600 的文件，弹窗按需读取，不写日志。
- 使用范围受 tailnet ACL 约束；如需限制客户端访问，请在 Tailscale 管理台配置 ACL。
