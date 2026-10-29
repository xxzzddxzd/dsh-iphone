# DSH iPhone

在 rootless 越狱 iPhone 上独立运行 DeepSeek Harness 后台，通过 Whaleness 原生 App 或保留的 Web GUI 访问同一份会话。

> [!WARNING]
> 仅适用于自行管理的越狱设备。部署前备份 `/var/root/.dsh`，不要把 DSH 端口直接暴露到局域网或公网。

## 功能

- launchd 管理的 DSH 后台、持久会话和 Bash/PTY；App 关闭后后台仍运行。
- Whaleness 原生界面与本机配对，复用聊天、轨迹、模型选择、附件和审批流程。
- 官方响应式 Web GUI、iOS 16 WebKit 兼容和主屏幕图标。
- 图片附件解码、缩放及 PNG/JPEG 编码。
- 系统通知、session 深链接和 Live Activity。
- 原生 Provider 登录、模型偏好、图片/Responses、VLESS；Cline Pass 账号/路由与插件配置表单。
- USB/Wi-Fi 隧道访问；Provider 页管理 OpenAI Codex、xAI、Google OAuth 及各自的可选 VLESS 出口。

## 当前版本与构建目标

| 组件 | 版本 |
| --- | --- |
| Mac / iPhone DSH | `0.2.1-rc.2` |
| dsh-codex | Mac `0.2.12` / iPhone `0.2.11`（pi-ai `1.4.0`、zod `4.4.3`） |
| dsh-cline-pass | `0.2.13` |
| iPhone Mobile Gateway | `0.11.1+iphone.2`，仅本机连接 |
| Whaleness 本地适配版 | `1.7.11 / build 39`，原生 Provider／插件设置已验收 |
| iPhone DSH Debian 包 | `0.2.1~rc.2-3` |
| Node.js | `22.23.2` |
| pnpm | `10.34.5` |
| node-pty | `1.2.0-beta.15` |
| node-addon-require-builtin | `0.1.9`（iOS N-API v9） |
| Safari compatibility | `19` |
| 系统 | 后台 iOS 15.0+；原生 App iOS 16.1+；rootless 越狱 |

目标设备为 iPhone 13 Pro Max（iOS 16.1.1）。已完成的核心、API 与 App 验证分别记录，不能用安装或编译成功代替横竖屏、键盘和输入法验收。精确版本见 [`versions.env`](./versions.env)，结果见[更新记录](./docs/updating.md)。

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
./scripts/package-dsh-codex.sh
./scripts/package-dsh-cline-pass.sh
./scripts/package-mobile-gateway.sh
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

## 原生 App

复用 Whaleness 的 SwiftUI/UIKit 界面和 KMP 客户端状态处理，在同一台手机上连接 `ws://127.0.0.1:3080/ws/mobile`。网关是现有 DSH 进程内的插件，不另起一套 Harness；网页、插件和历史数据继续由原后台管理。部署网关与本机 profile 的步骤见完整流程，单独安装 IPA 不代替后台接入。

```bash
./scripts/package-mobile-gateway.sh
NATIVE_APP_SOURCE=/path/to/reviewed-whaleness ./scripts/build-native-app.sh
NATIVE_APP_IPA="$PWD/build/native-app/Whaleness-iphone-1.7.11-build39.ipa" \
NATIVE_APP_MANIFEST="$PWD/build/native-app/native-app-manifest.json" \
DEVICE_HOST='<iPhone IP>' ./scripts/install-native-app.sh
```

默认 `deploy.sh` 会安装 Gateway 并合并本机 Host profile，保留已安装 App；只有显式传入匹配的 `NATIVE_APP_IPA` 和 `NATIVE_APP_MANIFEST` 才更新 App，避免回装上游 build 32。

构建需要 Xcode/Metal、JDK 17 和 Android SDK；安装使用设备已有的 TrollStoreLite，保留 App 容器和真实 Keychain。首次配对由经授权的本机 UI 深链交给 App 完成，脚本不伪造或注入凭据。

本次将原有活动栏的状态与视图加入 Whaleness 的 Widget，创建、更新和结束仍由原后台链负责，App 不重复创建本机卡片。安装器发布绑定精确 App/Widget 版本的支持标记；broker 还要求卡片带有匹配真实配对的原生会话地址，才选择原生 App 为目标。条件不足时采用旧独立 Widget；已选定原生目标后的失败必须报告，不能悄悄回退。安装、XPC 返回 UUID 或 LaunchServices 注册成功均不证明锁屏实际显示，必须单独验收。完整架构与检查流程见[原生 App 接入](./docs/native-app.md)和[通知与活动栏](./docs/notifications.md)。

## 网页访问

iPhone Safari 和主屏幕 WebClip 首次认证（保持手机解锁）：

```bash
./scripts/open-device.sh
```

Mac 通过 USB 持久转发到本机 3081：

```bash
./scripts/install-usb-proxy.sh
node ./scripts/open-browser.mjs iphone
```

USB 重连后 LaunchAgent 会自动恢复。连接多台 iPhone 时先设置 `DEVICE_UDID`。通过 Wi-Fi 则运行 `./scripts/start-tunnel.sh`，再运行同一个 `open-browser.mjs iphone`。Mac 本机 DSH 使用 `node ./scripts/open-browser.mjs mac`。默认在 Safari 打开；设置 `DSH_BROWSER='Google Chrome'` 可切换浏览器。

DSH 0.2.1 的网页入口使用官方浏览器会话认证。Safari、Chrome 和独立 WebClip 分别保存 Cookie；3080 与 3081 也分别认证。完成后可以直接访问普通根地址。详细流程和检查命令见 [Web 认证](./docs/web-authentication.md)。

Mac 与 iPhone 使用同一份 `dsh-codex` checkout：Mac profile 链接该目录，`deploy.sh` 则从同一目录检查、打包并安装到手机。`dsh-cline-pass 0.2.13` 从锁定的官方 npm 包生成 iPhone 离线候选，Mac 与手机分别安装；原有配置与 `CLINE_PASS_API_KEY` 不由程序包覆盖，也不改变默认模型。iPhone 保留浮动边栏：收起时只显示鲸鱼按钮，展开时覆盖对话、点击遮罩或 Escape 收起，设置页适配窄屏。该适配通过独立 mobile shell 加在官方组件外，不覆盖布局、侧栏、对话或设置 bundle；平台差异集中在 Node、原生模块、Safari 16 和系统集成层。

Cline Pass 的账号池、上游通道和工具开关位于「设置 → 插件 → Cline Pass」。

iPhoneDS 页面关闭 hover/focus 提示浮框及原生 `title` 提示，避免触摸后焦点停留导致提示一直遮挡；按钮的无障碍名称仍保留。菜单里由组件主动聚焦的搜索框不再弹出键盘（直接点它仍可输入），模型清单因此始终可见。从横屏 App 切回独立 WebClip 时，iOS 16 的横屏过渡帧被遮罩盖住，跟随最新消息的对话在旋转后重新贴回最新一条。

旧 `ios/client` WKWebView 壳仅保留作本地实验。核心 deb 默认不带它，`DSH_INCLUDE_LEGACY_WEB_CLIENT=1` 只用于重现旧实验，当前原生入口为 Whaleness。

## 数据与更新

会话、设置和凭据位于 `/var/root/.dsh`。升级前备份：

```bash
cp -a /var/root/.dsh "/var/root/.dsh.before-upgrade-$(date +%Y%m%d-%H%M%S)"
```

后续更新从 [双端快速更新流程](./docs/upgrade-workflow.md) 开始，同时检查 DSH、pi-ai、Cline Pass、模型目录和设置持久化，再做升级前后基线比较及指定模型的真实会话验收。原生路径还需检查网关、真实 App 配对、活动栏目标和实际显示。本次旧 xAI OAuth 的 `invalid_grant` 已由用户官方重新授权解决，严格目录检查重新通过。build 34 的安装、真实 Keychain 保留、回车发送和活动点击属于既有验收；build 37 已另行通过原生活动栏显示、后台生命周期和锁屏点击验收，并修复锁屏期间残留订阅计时。build 39 补齐原生 Provider/插件管理，并修复冷启动首条订阅漏发。

详细说明：[更新 SOP](./docs/updating.md) · [兼容说明](./docs/dsh-compatibility.md) · [历史恢复](./docs/history-migration.md) · [通知](./docs/notifications.md) · [排障](./docs/troubleshooting.md) · [VLESS](./docs/vless-client.md)

本仓库集成代码采用 [MIT License](./LICENSE)，第三方组件适用各自许可证。
