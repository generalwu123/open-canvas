# Open Canvas 公网访问（IPv6 直连）

访问地址：`https://canvas.generalwu.com`

登录凭证在 `deploy/caddy.env` 里（`CANVAS_AUTH_USER` / `CANVAS_AUTH_PASS`），
该文件不入 git，权限 600。浏览器首次访问会弹 HTTP Basic Auth。

## 为什么选 IPv6 直连而不是 Cloudflare Tunnel

两条路都能用，这里用 IPv6 直连，理由是画布要做视频生成：

- **速度**：Tunnel 会把流量绕到最近的 Cloudflare 机房再回源。视频节点
  返回的是几十 MB 的 mp4，多一跳中转在预览和拖动进度条时很明显。
  直连是访客到这台 Mac 的单跳路径。
- **上传**：Replicate / Cyberbara 生成的视频要回传到画布。Tunnel 的
  cloudflared 对大请求体有额外缓冲和超时约束，直连没有这层限制。
- **稳定性**：这是 Tunnel 的优势，它不依赖家里 IPv6 前缀是否变化，
  也不依赖光猫的入站策略。直连靠 DDNS 抵消前缀变化的影响（见下）。

实测结论：这台 Mac 的公网 IPv6 入站是通的。Caddy 访问日志里出现过
DigitalOcean（`2a03:b0c0::`）、Linode（`2607:9000::`）、Google Cloud
（`2600:1900::`）等外部 IPv6 地址，都完成了 TLS 握手并拿到 401。

## 链路

```
访客浏览器
  -> Cloudflare DNS（仅 AAAA，dns-only 不走代理）
  -> 这台 Mac 的公网 IPv6 :443
  -> Caddy（TLS 终止 + Basic Auth）
  -> 127.0.0.1:8090
  -> open-canvas 容器（Next.js standalone）
```

只有 AAAA、没有 A 记录，所以 IPv4-only 的网络访问不了这个域名。
手机用蜂窝网络（有 IPv6）可以正常访问。

## 为什么必须 HTTPS

容器跑 `NODE_ENV=production`，`middleware.ts` 给 `open_canvas_client_id`
cookie 打了 `secure` 标记。纯 HTTP 下浏览器会丢弃这个 cookie，
而画布数据是按 client id 归属的（`shared/models/local-canvas-store.ts`），
丢了就会表现为"刷新后画布变空"。所以入口必须是 HTTPS。

## 为什么用 DNS-01 签证书

macOS 自带的 Apache httpd（`_www`，pid 会变）已经占着 80 端口，
HTTP-01 挑战没法应答。所以用 Cloudflare DNS API 做 DNS-01。

这里有个坑：Clash Verge TUN 会把本机所有 DNS 查询返回 fake-ip
（`198.18.0.x`），连 TXT 查询都被劫持成假 A 记录。Caddy 自己查不到
刚写入的 TXT，于是报 `timed out waiting for record to fully propagate`。
修复是在 Caddyfile 里设 `propagation_timeout -1` 关掉本机检查——
Let's Encrypt 是直接查 Cloudflare 权威 NS 的，不受本地 DNS 影响。

## 为什么加了 Basic Auth

open-canvas 本身没有任何登录鉴权，而 `app/api/media/proxy/route.ts`
是个开放代理：接受任意 `?url=` 并在服务端发起请求，可以用来探测和
抓取内网地址。公网暴露前必须有一层认证，所以由 Caddy 统一加。

同时容器端口收窄成 `127.0.0.1:8090`，否则别人能直连 8090 绕过认证。
实测 `http://[IPv6]:8090/` 已连不上。

## 组成部分

| 文件 | 作用 |
| --- | --- |
| `deploy/Caddyfile` | TLS（DNS-01）、Basic Auth、反代到 8090、访问日志 |
| `deploy/caddy.env` | 用户名、明文密码、bcrypt 哈希、Cloudflare token（不入 git） |
| `deploy/bin/caddy` | 自编译 Caddy 2.11.4，含 `caddy-dns/cloudflare` 插件（不入 git） |
| `deploy/start-caddy.sh` | 启动脚本，顺带确保容器已起 |
| `docker-compose.yml` | 容器端口改为仅监听 loopback |
| `~/Library/LaunchAgents/com.generalwu.canvas-caddy.plist` | 开机自启 + 崩溃自愈 |
| `/Users/johncarter/Documents/Script/ddns/update-ipv6.sh` | 已加入 `canvas.generalwu.com`，每 5 分钟同步 AAAA |

`deploy/bin/caddy` 是自编译的，因为 brew 版 Caddy 不含 Cloudflare DNS 插件：

```bash
export GOTOOLCHAIN=auto   # Caddy 2.11 需要 Go >= 1.25，本机是 1.23
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
~/go/bin/xcaddy build --with github.com/caddy-dns/cloudflare \
  --output deploy/bin/caddy
```

## 日常操作

```bash
cd /Users/johncarter/Documents/Script/open-canvas

# 看服务状态
launchctl print gui/$(id -u)/com.generalwu.canvas-caddy | head -5
docker ps --filter name=open-canvas

# 改了代码后重新构建并重启容器
docker compose up -d --build

# 改了 Caddyfile 后热加载
launchctl kickstart -k gui/$(id -u)/com.generalwu.canvas-caddy

# 看谁访问过（含客户端 IP 和状态码）
tail -f deploy/caddy-access.log

# 改密码：更新明文后重新生成哈希
deploy/bin/caddy hash-password --plaintext "新密码"
# 然后编辑 deploy/caddy.env，注意哈希值必须保留单引号，
# 否则 shell 会把 $2a$14$ 当变量展开吃掉。
```

## 数据位置

画布和运行记录在 `data/open-canvas-db.json`（已挂载到容器 `/app/data`）。
provider 设置存在浏览器 cookie 里，不进这个文件。

## 已知边界

- 光猫重启会换 IPv6 前缀，DDNS 最多 5 分钟后才追上；期间域名解析到旧地址。
- IPv4-only 的网络（部分公司网、老设备）访问不了，因为没有 A 记录。
- Basic Auth 是明文凭证走 TLS，够用但不是强认证；如果要长期公开分享，
  建议在应用层加登录，而不是继续依赖入口 Basic Auth。
- Mac 关机或休眠时站点不可用。要保持 7×24 可用需关掉自动休眠。

