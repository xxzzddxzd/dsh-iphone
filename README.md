# DSH iPhone

在 rootless 越狱 iPhone 上构建并运行 DeepSeek Harness Web GUI。

> [!WARNING]
> 仅适用于自行管理的越狱设备。部署前备份 `/var/root/.dsh`，不要把 DSH 端口直接暴露到局域网或公网。

## 功能

- DSH Web GUI、持久会话和 Bash/PTY。
- 官方响应式 Web GUI、iOS 16 WebKit 兼容和主屏幕图标。
- 图片附件解码、缩放及 PNG/JPEG 编码。
- 系统通知、session 深链接和 Live Activity。
- USB/Wi-Fi 隧道访问；Provider 页管理 OpenAI Codex、xAI、Google OAuth 及各自的可选 VLESS 出口。

## 验证版本

| 组件 | 版本 |
| --- | --- |
| DSH | `0.1.5-rc.1`（内部包 `0.1.5-rc.2`） |
| dsh-codex | `0.2.6`（pi-ai `0.85.1`） |
| dsh-cline-pass | `0.1.1` |
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

iPhone 需要 OpenSSH、`dpkg`、`ldid`、`bash`、`python3`、`uikittools`、`ellekit`；通知还需要 `net.limneos.libbulletin`。

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

iPhone Safari 和主屏幕 DSH 首次认证（保持手机解锁）：

```bash
./scripts/open-device.sh
```

Mac 通过 USB 持久转发到本机 3081：

```bash
./scripts/install-usb-proxy.sh
node ./scripts/open-browser.mjs iphone
```

USB 重连后 LaunchAgent 会自动恢复。连接多台 iPhone 时先设置 `DEVICE_UDID`。通过 Wi-Fi 则运行 `./scripts/start-tunnel.sh`，再运行同一个 `open-browser.mjs iphone`。Mac 本机 DSH 使用 `node ./scripts/open-browser.mjs mac`。默认在 Safari 打开；设置 `DSH_BROWSER='Google Chrome'` 可切换浏览器。

DSH 0.1.5 使用官方浏览器会话认证。Safari、Chrome 和独立 WebClip 分别保存 Cookie；3080 与 3081 也分别认证。完成后可以直接访问普通根地址。详细流程和检查命令见 [Web 认证](./docs/web-authentication.md)。

Mac 与 iPhone 使用同一份 `dsh-codex` checkout：Mac profile 链接该目录，`deploy.sh` 则从同一目录检查、打包并安装到手机。`dsh-cline-pass` 从 Mac Web profile 已安装的 `0.1.1` 打包进手机，配置与 `CLINE_PASS_API_KEY` 需另行同步，不覆盖 iPhone 默认模型。iPhone 保留浮动边栏：收起时只显示鲸鱼按钮，展开时覆盖对话、点击遮罩或 Escape 收起，设置页适配窄屏。该适配通过独立 mobile shell 加在官方组件外，不覆盖布局、侧栏、对话或设置 bundle；平台差异集中在 Node、原生模块、Safari 16 和系统集成层。

iPhoneDS 页面关闭 hover/focus 提示浮框及原生 `title` 提示，避免触摸后焦点停留导致提示一直遮挡；按钮的无障碍名称仍保留。

## 数据与更新

会话、设置和凭据位于 `/var/root/.dsh`。升级前备份：

```bash
cp -a /var/root/.dsh "/var/root/.dsh.before-upgrade-$(date +%Y%m%d-%H%M%S)"
```

详细说明：[更新 SOP](./docs/updating.md) · [兼容说明](./docs/dsh-compatibility.md) · [历史恢复](./docs/history-migration.md) · [通知](./docs/notifications.md) · [排障](./docs/troubleshooting.md) · [VLESS](./docs/vless-client.md)

本仓库集成代码采用 [MIT License](./LICENSE)，第三方组件适用各自许可证。
