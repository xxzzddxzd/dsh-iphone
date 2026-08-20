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
| Web GUI | compatibility 7 | Safari/Chrome 的 iOS 16 WebKit、通知 session 深链接、移动端悬浮侧栏 |

仓库不提交 Node/DSH 完整源码副本、npm 依赖目录、`.deb` 或 Mach-O 产物。DSH 官方源码通过 [`upstream/deepseek-harness`](./upstream/deepseek-harness) 子模块引用，Node 官方源包按 SHA-256 下载后应用版本化补丁。

## 构建

Mac 需要 Xcode Command Line Tools、Node.js 22 或更高版本、npm 和 Debian 打包工具：

```bash
xcode-select --install
brew install node dpkg gnu-tar ripgrep
git clone --recurse-submodules https://github.com/xxzzddxzd/dsh-iphone.git
cd dsh-iphone
```

iPhone 需要 rootless 越狱环境中的 OpenSSH、`dpkg`、`ldid`、`bash`、`uikittools` 和 `ellekit`。系统通知还依赖 `net.limneos.libbulletin`，安装时由 `dpkg` 检查。

```bash
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

构建产物位于 `dist/`，包括 Node、pnpm 和 DSH 三个必需包：

```text
dist/nodejs22_*_iphoneos-arm64.deb
dist/pnpm10_*_iphoneos-arm64.deb
dist/dsh_*_iphoneos-arm64.deb
```

## 部署与访问

先指定手机的 SSH 地址。部署完成后，同一终端可继续建立 Mac 本地转发：

```bash
export DEVICE_HOST='<iPhone SSH 地址>'
export DEVICE_PORT=22
export DEVICE_USER=root
./scripts/deploy.sh
./scripts/start-tunnel.sh
```

Mac 浏览器打开：

```text
http://127.0.0.1:3082/?ioscompat=7
```

iPhone 本机 Safari 直接打开：

```text
http://127.0.0.1:3080/?ioscompat=7
```

`127.0.0.1` 是固定的本机回环地址，不是手机的局域网出口 IP。通过 USB 连接时，在第一个终端运行：

```bash
iproxy 2224 22
```

在第二个终端部署并建立 Web 转发：

```bash
export DEVICE_HOST=localhost
export DEVICE_PORT=2224
export DEVICE_USER=root
./scripts/deploy.sh
./scripts/start-tunnel.sh
```

## 可选 VLESS 出口

仅让 DSH 的 GPT/OpenAI 通道使用独立固定出口时，再构建 Xray 包：

```bash
./scripts/build-xray.sh
./scripts/package-xray.sh
```

默认配置 fail-closed、不包含 VLESS 凭据且不启用 TUN。配置方法见[独立 VLESS 客户端](./docs/vless-client.md)。

## 数据与更新

会话、设置和凭据保存在 `/var/root/.dsh`，不属于安装包；部署不会删除该目录，但升级前仍应先备份。官方 DSH 通过只读子模块锁定，本项目的 iOS 适配只修改构建副本，补丁预像不匹配时会直接失败。

版本锁定见 [`versions.env`](./versions.env)，升级与备份流程见 [DSH 更新标准 SOP](./docs/updating.md)，运行问题见[部署与运行排障](./docs/troubleshooting.md)。

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
