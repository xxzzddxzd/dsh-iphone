# DSH iPhone

在 rootless 越狱 iPhone 上构建并运行 DeepSeek Harness Web GUI。

> [!WARNING]
> 仅适用于自行管理的越狱设备。部署前备份 `/var/root/.dsh`，不要把 DSH 端口直接暴露到局域网或公网。

## 功能

- DSH Web GUI、持久会话和 Bash/PTY。
- iOS 16 WebKit 兼容、移动端布局和主屏幕图标。
- 图片附件解码、缩放及 PNG/JPEG 编码。
- 系统通知、session 深链接和 Live Activity。
- USB/Wi-Fi 隧道访问；Provider 页管理 OpenAI Codex、xAI、Google OAuth 及各自的可选 VLESS 出口。

## 验证版本

| 组件 | 版本 |
| --- | --- |
| DSH | `0.1.1-rc.2` |
| dsh-codex | `0.2.5-iphone.7` |
| Node.js | `22.23.2` |
| pnpm | `10.34.5` |
| node-pty | `1.2.0-beta.15` |
| 系统 | iOS 15.0+、rootless 越狱 |

已在 iPhone 13 Pro Max（iOS 16.1.1）实机验收。精确版本见 [`versions.env`](./versions.env)。

## 构建与安装

Mac 准备：

```bash
xcode-select --install
brew install node dpkg gnu-tar ripgrep libimobiledevice
git clone --recurse-submodules https://github.com/xxzzddxzd/dsh-iphone.git
cd dsh-iphone
```

iPhone 需要 OpenSSH、`dpkg`、`ldid`、`bash`、`uikittools`、`ellekit`；通知还需要 `net.limneos.libbulletin`。

```bash
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

通过 Wi-Fi SSH 部署：

```bash
DEVICE_HOST='<iPhone IP>' DEVICE_PORT=22 ./scripts/deploy.sh
```

通过 USB 部署，先在一个终端运行 `iproxy -s 127.0.0.1 2224:22`，再在另一个终端执行：

```bash
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 ./scripts/deploy.sh
```

## 访问

iPhone Safari：

```text
http://127.0.0.1:3080/?ioscompat=9
```

Mac 通过 USB 持久转发到本机 3081：

```bash
./scripts/install-usb-proxy.sh
open 'http://127.0.0.1:3081/?ioscompat=9'
```

USB 重连后 LaunchAgent 会自动恢复。连接多台 iPhone 时先设置 `DEVICE_UDID`。通过 Wi-Fi 则运行 `./scripts/start-tunnel.sh`，访问地址仍为 `http://127.0.0.1:3081/?ioscompat=9`。

## 数据与更新

会话、设置和凭据位于 `/var/root/.dsh`。升级前备份：

```bash
cp -a /var/root/.dsh "/var/root/.dsh.before-upgrade-$(date +%Y%m%d-%H%M%S)"
```

详细说明：[更新 SOP](./docs/updating.md) · [兼容说明](./docs/dsh-compatibility.md) · [通知](./docs/notifications.md) · [排障](./docs/troubleshooting.md) · [VLESS](./docs/vless-client.md)

本仓库集成代码采用 [MIT License](./LICENSE)，第三方组件适用各自许可证。
