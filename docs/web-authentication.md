# DSH 0.1.5 Web 认证

Mac 与 iPhone 保留官方 `dsh-client-connection` 认证实现，没有免认证补丁。当前 CLI 是 `0.1.5-rc.1`，内部连接包是 `0.1.5-rc.2`。

## 认证流程

每次进程启动生成一个随机 launch token，启动日志中的 `/?token=…` 只能在 `GET /` 交换浏览器会话。交换返回 `303 /` 和签名 Cookie，页面最终地址不带 token。同一进程的 token 可重复使用；重启后旧 token 失效，但此前签发的 Cookie 仍有效。

Cookie 由 DSH 凭据存储中的 `client-connection/browser-session` 密钥签名，默认有效期 30 天，属性为 `HttpOnly; SameSite=Strict; Path=/`。本机 HTTP 不设置 `Secure`。Cookie 名称和签名内容都绑定 hostname 与 port，因此 `127.0.0.1:3080`、`127.0.0.1:3081`、`localhost:3080` 必须分别交换。Mac 的两个端口分别连接不同的 DSH，也使用各自的签名密钥。

根页面和 index 需要浏览器 Cookie；静态资源公开。所有 RPC 与 `/api/remote.mux` WebSocket 同样需要 Cookie。API 不接受 query token 或 Bearer token；Host/Origin/Fetch Metadata 校验仍生效。`trustedHosts` 只允许访问来源，并不关闭认证。当前没有关闭认证的官方开关。

## 打开与修复

在仓库目录运行：

```bash
# Mac 本机 DSH，默认在 Safari 打开
node ./scripts/open-browser.mjs mac

# iPhone 已转发到 Mac 127.0.0.1:3081
node ./scripts/open-browser.mjs iphone

# 指定 Chrome；它与 Safari 分别保留 Cookie
DSH_BROWSER='Google Chrome' node ./scripts/open-browser.mjs iphone

# 手机 Safari 和主屏幕 DSH WebClip；手机需要保持解锁
./scripts/open-device.sh
```

脚本内部读取当前启动地址并先验证交换，不在终端打印 token。Mac 日志默认是 `~/Library/Logs/dsh-mac.log`，可用 `DSH_MAC_LOG` 指定。手机默认通过 `root@10.99.1.41:22` 读取 `/var/root/dsh.log`，支持 `DEVICE_HOST`、`DEVICE_PORT`、`DEVICE_USER`；Mac 转发端口支持 `LOCAL_PORT`。

iPhone Safari 和独立 WebClip 使用不同 Cookie 容器。`open-device.sh` 先激活 MobileSafari 再打开认证地址，并刷新匹配 DSH WebClip 的 URL 和缓存 manifest start_url。原配置备份在手机 `/var/root/.dsh-webclip-backup`。如果独立应用仍停在旧错误页面，退出后重新点 DSH 图标。启动地址中的 token 会保留在手机 WebClip 配置中，实际浏览器交换后重定向到 `/`；部署后脚本会更新它。Cookie 过期、清除网站数据或签名密钥更换后重新运行此脚本。

## 验证

```bash
node ./scripts/check-web-auth.mjs
```

检查两个运行中的服务：根页面/index、启动交换、Cookie 属性、RPC、WebSocket，以及未认证、错误 token、篡改 Cookie、错误 hostname、跨来源、非浏览器会话 Bearer/query token 的拒绝路径。该检查不调用模型、不修改会话，也不输出 token 或 Cookie。

认证后白屏应检查 WebKit Console。iOS 16.1 不支持新版主 bundle 的 class static block；compatibility 13 使用锁定的 esbuild 将官方主 bundle 与文档预览 bundle 转成 Safari 16.1 语法，并在启动前加载 core-js 标准 API polyfill，提供文档预览插件所需的 Iterator 等 API。布局、对话和侧栏逻辑继续使用官方实现。若出现历史事件迁移错误，见 [历史恢复](./history-migration.md)。

## 安装插件后持续重启

先检查是否额外注册了执行 `launchctl kickstart -k` 的常驻重启任务。
`launchctl submit` 提交的任务可能带有 `KeepAlive`，一次性重启脚本退出后又被启动，
从而不断重启正常的 DSH。实际曾出现的遗留任务名是 `com.local.dsh-web-restart`；
应移除这个任务，保留真正的 `ai.deepseek.dsh-mac` 服务。一次性重启脚本直接运行即可。

就绪检查不能再用 `curl -f http://127.0.0.1:3080/`：未认证请求返回 401 是预期行为，
不是启动失败。就绪检查应接受 200/401，随后使用本页的认证检查验证 RPC 和 WebSocket。
判断插件是否加载失败应看当前插件清单及最新启动后的日志，不能把更早构建的报错当成
当前故障。
