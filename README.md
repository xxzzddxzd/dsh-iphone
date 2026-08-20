# DSH iPhone

在 rootless 越狱 iPhone 上构建并运行 DeepSeek Harness Web GUI 的可复现部署工程。

> [!WARNING]
> 本项目只适用于自行管理的越狱设备。Node 包含私有/JIT entitlement，不能用于 App Store、普通未越狱 iOS 或生产安全边界。部署前备份 `/var/root/.dsh`。

当前锁定并验证的组合：

| 组件 | 版本 | 验证环境 |
| --- | --- | --- |
| iPhone | iPhone 14 Pro | iOS 16.1.1、rootless 越狱 |
| Node.js | 22.23.2 | iPhoneOS arm64，最低 iOS 15.0 |
| DSH | 0.1.0-rc.7 | 上游提交 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| node-pty | 1.2.0-beta.15 | iOS `posix_spawn` 后端 |
| Xray（可选） | 26.3.27 | 仅回环 HTTP 入站、VLESS 出站 |
| Web GUI | compatibility 5 | Safari/Chrome 的 iOS 16 WebKit、通知 session 深链接 |

仓库不提交 Node/DSH 完整源码副本、npm 依赖目录、`.deb` 或 Mach-O 产物。DSH 官方源码通过 [`upstream/deepseek-harness`](./upstream/deepseek-harness) 子模块引用，Node 官方源包按 SHA-256 下载后应用版本化补丁。

## 快速开始

Mac 需要 Xcode Command Line Tools、Node.js 22 或更高版本、npm，以及 Debian 打包工具。以下流程以 Apple Silicon Mac 为主，也支持 Intel Mac 的 host tools：

```bash
xcode-select --install
brew install node dpkg gnu-tar ripgrep
git clone --recurse-submodules https://github.com/xxzzddxzd/dsh-iphone.git
cd dsh-iphone
```

iPhone 需要 rootless 越狱环境中的 OpenSSH、`dpkg`、`ldid`、`bash`、`uikittools` 和 `ellekit`。DSH 系统通知还依赖 Limneos 源中的 `net.limneos.libbulletin`，安装 DSH 包时由 `dpkg` 检查。先构建 Node；首次完整编译通常需要较长时间，可通过 `JOBS` 控制并发：

```bash
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

产物位于 `dist/`：

```text
dist/nodejs22_22.23.2-1_iphoneos-arm64.deb
dist/pnpm10_10.34.5-1_iphoneos-arm64.deb
dist/dsh_0.1.0~rc.7-1_iphoneos-arm64.deb
```

仅让 DSH 的 GPT/OpenAI 通道使用独立 VLESS 固定出口时，再构建单独的 Xray 包：

```bash
./scripts/build-xray.sh
./scripts/package-xray.sh
```

它默认安装 fail-closed 配置，不包含 VLESS 凭据，也不启用 TUN。完整配置和部署步骤见[独立 VLESS 客户端](./docs/vless-client.md)。

设备通过 `10.99.6.77:22` 可达时，安装三个包并启动服务：

```bash
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 DEVICE_USER=root ./scripts/deploy.sh
```

另开一个终端建立 Mac 本地转发：

```bash
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 DEVICE_USER=root ./scripts/start-tunnel.sh
```

浏览器打开：

```text
http://127.0.0.1:3082/?ioscompat=5
```

iPhone 本机 Safari 直接打开：

```text
http://127.0.0.1:3080/?ioscompat=5
```

通过 USB `iproxy` 连接时使用：

```bash
iproxy 2224 22
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 DEVICE_USER=root ./scripts/deploy.sh
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 DEVICE_USER=root ./scripts/start-tunnel.sh
```

## 构建内容

脚本生成三个基础软件包以及一个可选的 Xray 软件包：

| 路径 | 用途 |
| --- | --- |
| `/var/jb/usr/local/lib/nodejs22/node` | iPhoneOS Node 22 二进制 |
| `/var/jb/usr/local/bin/node22` | 不覆盖系统或 Node 18 的入口 |
| `/var/jb/usr/local/lib/pnpm10` | 锁定的 pnpm JavaScript 发行包 |
| `/var/jb/usr/local/bin/pnpm` | 固定使用 Node 22 的 profile 插件管理入口 |
| `/var/jb/usr/local/lib/dsh-vless/xray` | iPhoneOS arm64 Xray 核心（可选包） |
| `/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-vless.plist` | 回环端口 18080 的独立 VLESS 服务 |
| `/var/jb/usr/local/lib/dsh` | 锁定的 DSH npm 闭包与 iOS shim |
| `/var/jb/usr/local/bin/dsh22` | 带 iOS V8 参数的 DSH 入口 |
| `/var/jb/usr/local/bin/dsh-notify` | 通过 SpringBoard 发布可点击系统通知的 helper |
| `/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib` | 接收 helper 请求并安全发布通知的 arm64/arm64e SpringBoard 桥 |
| `/var/jb/Applications/DSH.app` | 隐藏的通知图标宿主，向 iOS 注册 DSH 黑鲸鱼图标 |
| `/var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist` | 端口 3080 的 Web 服务 |
| `/var/root/.dsh` | 会话、设置和凭据目录，不属于安装包 |

`package-dsh.sh` 使用提交的 `package-lock.json` 执行 `npm ci --ignore-scripts`，随后执行严格、可重复运行的 DSH 补丁器，并为 iPhoneOS 编译 `pty.node`、`spawn-helper` 与通知桥。任一上游文件或 bundle 名称不匹配时，补丁器会直接失败。

## 保留现有会话

Node 18 和 Node 22 的启动器都使用 `/var/root/.dsh`，因此同一 DSH 数据目录可继续使用。升级前停止服务并备份：

```bash
ssh -p 22 root@10.99.6.77 'launchctl bootout user/foreground/ai.deepseek.dsh >/dev/null 2>&1 || true; cp -a /var/root/.dsh /var/root/.dsh.backup'
```

软件包只替换 `/var/jb/usr/local/lib/dsh`、Node 22 和 pnpm 10 自己的安装目录，不删除 `/var/root/.dsh`。如果同时改变 DSH 版本，应先阅读上游迁移说明再复用会话。

## 跟踪上游

官方仓库地址保存在 [`.gitmodules`](./.gitmodules)，当前发布提交保存在 [`versions.env`](./versions.env)。查看当前引用：

```bash
git submodule status
git -C upstream/deepseek-harness log -1 --oneline
```

更新流程不是直接拉取后部署，而是更新子模块和版本锁、重新生成 npm lock、修复严格补丁的失败预像、运行完整验证，再备份、部署和实机验收。具体步骤见 [DSH 更新标准 SOP](./docs/updating.md)。

## 文档

- [Node.js 的 iOS 修正](./docs/node-ios-patch.md)
- [pnpm 与 profile 插件](./docs/pnpm.md)
- [独立 VLESS 客户端](./docs/vless-client.md)
- [DSH 与 Safari 16 兼容层](./docs/dsh-compatibility.md)
- [iOS 系统通知与 session 深链接](./docs/notifications.md)
- [DSH 更新标准 SOP](./docs/updating.md)
- [部署与运行排障](./docs/troubleshooting.md)
- [第三方软件声明](./THIRD_PARTY_NOTICES.md)

本仓库的集成代码采用 [MIT License](./LICENSE)。Node.js、DSH 与 npm 依赖仍适用各自许可证。
