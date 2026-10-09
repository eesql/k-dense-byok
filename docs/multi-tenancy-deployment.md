# macOS 内网多租户部署

首版已实现并完成本地验收，结果见 [验收矩阵](multi-tenancy-verification.md)。规格和限制见 [多租户规格](multi-tenancy-spec.md)。

## 初始化

依赖沿用现有项目要求：Node ≥22.19、npm、uv 和 Git。先安装现有前后端依赖，再从仓库根目录执行：

```sh
npm --prefix server run start:multitenant -- --init-admin
```

在本机终端输入管理员用户名和至少 12 个字符的密码。密码输入不回显，数据库仅保存带随机盐的哈希；重复初始化会拒绝覆盖已有管理员。初始化为本机操作，没有公开的初始化 HTTP 接口。

忘记管理员密码时，先等待任务结束并停止应用，在仓库根目录执行：

```sh
npm --prefix server run start:multitenant -- --reset-admin
```

输入已有管理员用户名与新密码（至少 12 个字符、不回显），然后按原部署命令重启应用。命令仅重置该管理员密码并撤销其旧登录会话，保留团队、项目、凭据与用量；没有公开的重置 HTTP 接口。使用自定义 `KADY_MT_ROOT` 时，重置命令必须设置同一目录。不要删除数据库或重新初始化来找回账号。

## 开关与入口

从仓库根目录运行：

```sh
KADY_MULTI_TENANT=1 ./start.sh
```

默认对外入口为 `http://localhost:3000`，内部 Next.js UI 为 loopback 的 3001 端口；项目后端使用自动分配的 loopback 端口。普通浏览器请求只访问管理入口，不需要知道项目后端端口或 Token。

开关不设置或设置为 `0`、`off`、`false` 时，`./start.sh` 使用原有单用户路径。停止后再重启切换模式；关闭不删除管理数据，也不把租户项目加入单用户项目目录。开关值无效或显式开启失败时停止，不静默回退成单用户服务。

## 配置

| 配置 | 默认／含义 |
| --- | --- |
| `KADY_MULTI_TENANT` | 默认关闭；`1`、`on`、`true` 开启。 |
| `KADY_MT_ROOT` | `~/.kady/multitenant`；管理数据库、租户配置与工作空间。初始化与启动必须使用同一根目录。 |
| `KADY_FRONTEND_PORT` | 管理入口端口，默认 3000。 |
| `KADY_UI_INTERNAL_PORT` | 内部 UI 端口，默认入口端口加一；始终绑定 loopback。 |
| `KADY_MT_HOST` | 管理入口监听地址，默认 `127.0.0.1`。 |
| `KADY_PUBLIC_URL` | 浏览器实际使用的完整 origin；本机默认 `http://localhost:3000`，内网必须配置为 HTTPS origin。它仅设置公共地址和会话策略，不会启用 TLS。 |

内网使用由部署入口终止 TLS 的 HTTPS 反向代理，将请求转到管理入口。保留配置的公共 Host 与 Origin；域名和 scheme 必须与 `KADY_PUBLIC_URL` 一致。使用 HTTPS 时会话 cookie 标记 Secure。UI 与 API 必须同源；额外模型、文件及流式入口仍经过该入口。

### 不用 DNS：内网 IP 与 Caddy HTTPS

应用的 3000 端口始终是 HTTP。直接访问 `https://内网IP:3000` 会出现 `ERR_SSL_PROTOCOL_ERROR`；把公共地址写成 HTTPS 不会改变监听协议。下面将 Caddy 的 HTTPS 入口放在 8443，应用保持本机 HTTP 3000。

先在部署 Mac 安装 Caddy：

```sh
brew install caddy
```

停止原来的应用，再从仓库根目录启动（将 IP 替换为实际内网 IP）：

```sh
KADY_MULTI_TENANT=1 \
KADY_MT_HOST=127.0.0.1 \
KADY_PUBLIC_URL=https://172.20.10.10:8443 \
./start.sh
```

在另一终端从仓库根目录启动代理；同步修改 `docs/Caddyfile.lan.example` 中的 IP：

```sh
caddy run --config docs/Caddyfile.lan.example --adapter caddyfile
```

浏览器访问 **`https://172.20.10.10:8443`**，不要访问 HTTPS 3000。Caddy 自动处理 WebSocket，配置中的即时刷新保留 SSE 流式响应。

此配置使用 Caddy 的本地 CA，不依赖公共 DNS，也不会自动修改系统证书信任。让 `caddy run` 的终端保持运行；在第三个终端执行 `caddy trust --address 127.0.0.1:2019`，按 macOS 的权限提示信任本地 CA。该命令需要连接正在运行的 Caddy 管理接口。若报告 `connect: connection refused`，先检查代理是否已退出、启动日志是否有错误。也可用 `caddy start --config docs/Caddyfile.lan.example --adapter caddyfile` 启动后台代理，再执行信任命令。其他访问设备也需要信任同一个根证书；macOS 默认存放在 `~/Library/Application Support/Caddy/pki/authorities/local/root.crt`。仅向客户端分发 `root.crt`，不要分发任何 `.key` 文件。证书尚未受信任时，浏览器会报告证书颁发机构错误；这与协议不匹配的 `ERR_SSL_PROTOCOL_ERROR` 是不同的问题。

已有组织信任的证书时，可将 `tls internal` 换成 `tls /path/to/cert.pem /path/to/key.pem`，使用证书中包含的 IP 或域名。代理和应用在同一台 Mac 上时，保留应用 loopback 监听，不必对内网开放 HTTP 3000 或 UI 3001。

例如，内网 DNS 将 `kady.lab.example` 指向 Mac 的内网 IP，HTTPS 反向代理也运行在这台 Mac 上时，从仓库根目录启动：

```sh
KADY_MULTI_TENANT=1 KADY_PUBLIC_URL=https://kady.lab.example ./start.sh
```

将示例域名替换成实际域名，反向代理把 HTTPS 请求转发到 `http://127.0.0.1:3000`，保留公共 Host、Origin 和 WebSocket 升级；各客户端访问 `https://kady.lab.example`。此时管理服务保留默认 loopback 监听，由反向代理对内网提供入口。如果反向代理运行在另一台机器上，再设置 `KADY_MT_HOST=0.0.0.0`，并限制 3000 端口只允许该代理连接。内部 UI 的 3001 端口始终只供本机使用。

页面通过其他 Host 打开时会跳转到配置的公共地址，避免认证/API/WebSocket 使用不同地址而卡在加载页。不要在内网部署中将公共地址配置为 localhost；单独设置监听地址也不会改变公共地址。内网 HTTP 地址会被启动校验拒绝，需使用客户端信任的 HTTPS 证书。修改这些启动配置后重启服务生效。

进入 UI 后，平台管理员创建团队，生成负责人邀请链接，并可设置平台 OpenRouter Key、累计模型预算和并发上限。负责人继续邀请团队成员。邀请链接仅使用 URL fragment，默认有效一天且只能消费一次。平台主 Key 通过正常配置流程仅保存在管理服务中。

顶部 **Team settings** 打开独立团队管理页，并定位到当前项目所属团队：**Projects** 管理项目及其访问来源，**Members** 管理邀请与成员，**Usage & limits** 查看所选团队的用量和额度，管理员的 **Platform access** 配置供所有团队使用的平台 Key。创建项目时必须明确选择平台访问或团队 BYOK；改变来源要点击 **Apply access change** 才会保存。具体模型仍在聊天选择器中选择；BYOK 项目的 **Configure team providers** 会打开对应项目的 Providers 设置，凭据由该团队的 BYOK 项目共享。管理页和项目列表刷新不会卸载已有工作区。

每个项目选择 BYOK 或平台模型供给；忙碌时拒绝切换。调用失败不自动改变来源。平台费用显示估算、预约和未结算状态；管理员核对供应商用量后可对未结算记录填写确认费用。预算调整不会重置既有支出。

## 信任与恢复

这是全体使用者互相信任的本机协作部署。网页和 API 校验租户归属，Agent shell 仍具有宿主机 OS 用户权限；目录和独立工作进程不是安全隔离，主 Key 也不能抵御同 OS 用户代码读取。

保留管理状态目录和项目工作空间。不要将运行中的数据库文件直接复制为备份；应停止服务后复制整个管理状态目录，并保护其中的凭据。重启保留已记账费用和未结算调用，不会恢复已用额度；普通运行中的聊天仍遵循原有后端重启终止语义，持久化任务按原有恢复能力处理。
