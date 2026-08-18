# DSH iPhone

在 rootless 越狱 iPhone 上构建并运行 DeepSeek Harness Web GUI 的可复现部署工程。

> [!WARNING]
> 本项目只适用于自行管理的越狱设备。Node 包含私有/JIT entitlement，不能用于 App Store、普通未越狱 iOS 或生产安全边界。部署前备份 `/var/root/.dsh`。

当前锁定并验证的组合：

| 组件 | 版本 | 验证环境 |
| --- | --- | --- |
| iPhone | iPhone 14 Pro | iOS 16.1.1、rootless 越狱 |
| Node.js | 22.23.2 | iPhoneOS arm64，最低 iOS 15.0 |
| DSH | 0.1.0-rc.6 | 上游提交 `fb82698709c39f1860b0ab0ed147e1fa30c1d5d0` |
| node-pty | 1.1.0 | iOS `forkpty` 后端 |
| Web GUI | compatibility 4 | Safari/Chrome 的 iOS 16 WebKit |

仓库不提交 Node/DSH 完整源码副本、npm 依赖目录、`.deb` 或 Mach-O 产物。DSH 官方源码通过 [`upstream/deepseek-harness`](./upstream/deepseek-harness) 子模块引用，Node 官方源包按 SHA-256 下载后应用版本化补丁。

## 快速开始

Mac 需要 Xcode Command Line Tools、Node.js 22 或更高版本、npm，以及 Debian 打包工具。以下流程以 Apple Silicon Mac 为主，也支持 Intel Mac 的 host tools：

```bash
xcode-select --install
brew install node dpkg gnu-tar ripgrep
git clone --recurse-submodules https://github.com/xxzzddxzd/dsh-iphone.git
cd dsh-iphone
```

iPhone 需要 rootless 越狱环境中的 OpenSSH、`dpkg`、`ldid`、`bash` 和 `curl`。先构建 Node；首次完整编译通常需要较长时间，可通过 `JOBS` 控制并发：

```bash
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

产物位于 `dist/`：

```text
dist/nodejs22_22.23.2-1_iphoneos-arm64.deb
dist/dsh_0.1.0~rc.6-1_iphoneos-arm64.deb
```

设备通过 `10.99.6.77:22` 可达时，安装两个包并启动服务：

```bash
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 DEVICE_USER=root ./scripts/deploy.sh
```

另开一个终端建立 Mac 本地转发：

```bash
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 DEVICE_USER=root ./scripts/start-tunnel.sh
```

浏览器打开：

```text
http://127.0.0.1:3082/?ioscompat=4
```

iPhone 本机 Safari 直接打开：

```text
http://127.0.0.1:3080/?ioscompat=4
```

通过 USB `iproxy` 连接时使用：

```bash
iproxy 2224 22
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 DEVICE_USER=root ./scripts/deploy.sh
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 DEVICE_USER=root ./scripts/start-tunnel.sh
```

## 构建内容

脚本生成两个可共存的软件包：

| 路径 | 用途 |
| --- | --- |
| `/var/jb/usr/local/lib/nodejs22/node` | iPhoneOS Node 22 二进制 |
| `/var/jb/usr/local/bin/node22` | 不覆盖系统或 Node 18 的入口 |
| `/var/jb/usr/local/lib/dsh` | 锁定的 DSH npm 闭包与 iOS shim |
| `/var/jb/usr/local/bin/dsh22` | 带 iOS V8 参数的 DSH 入口 |
| `/var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist` | 端口 3080 的 Web 服务 |
| `/var/root/.dsh` | 会话、设置和凭据目录，不属于安装包 |

`package-dsh.sh` 使用提交的 `package-lock.json` 执行 `npm ci --ignore-scripts`，随后执行严格、可重复运行的 DSH 补丁器，并为 iPhoneOS 编译 `pty.node` 与 `spawn-helper`。任一上游文件或 bundle 名称不匹配时，补丁器会直接失败。

## 保留现有会话

Node 18 和 Node 22 的启动器都使用 `/var/root/.dsh`，因此同一 DSH 数据目录可继续使用。升级前停止服务并备份：

```bash
ssh -p 22 root@10.99.6.77 'launchctl bootout system/ai.deepseek.dsh >/dev/null 2>&1 || true; cp -a /var/root/.dsh /var/root/.dsh.backup'
```

软件包只替换 `/var/jb/usr/local/lib/dsh` 和 Node 22 自己的安装目录，不删除 `/var/root/.dsh`。如果同时改变 DSH 版本，应先阅读上游迁移说明再复用会话。

## 跟踪上游

官方仓库地址保存在 [`.gitmodules`](./.gitmodules)，当前发布提交保存在 [`versions.env`](./versions.env)。查看当前引用：

```bash
git submodule status
git -C upstream/deepseek-harness log -1 --oneline
```

更新流程不是直接拉取后部署，而是更新子模块和版本锁、重新生成 npm lock、修复严格补丁的失败预像、运行完整验证。具体步骤见[更新 DSH 与 Node](./docs/updating.md)。

## 文档

- [Node.js 的 iOS 修正](./docs/node-ios-patch.md)
- [DSH 与 Safari 16 兼容层](./docs/dsh-compatibility.md)
- [更新 DSH 与 Node](./docs/updating.md)
- [部署与运行排障](./docs/troubleshooting.md)
- [第三方软件声明](./THIRD_PARTY_NOTICES.md)

本仓库的集成代码采用 [MIT License](./LICENSE)。Node.js、DSH 与 npm 依赖仍适用各自许可证。
