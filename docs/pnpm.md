# pnpm 与 profile 插件

DSH 的 `plugin` 子命令在目标 profile 目录中执行 pnpm，成功后再把声明了 `dsh.bundle` 的依赖加入 profile 的 bundle 列表。iOS 的 `posix_spawn` 不能由 Node 直接启动 shell-script 包装器，因此 DSH iOS 补丁使用当前 Node 22 进程执行 `/var/jb/usr/local/lib/pnpm10/bin/pnpm.cjs`。pnpm 自己也包含一处 iOS-only 补丁，在执行 profile 的 `.bin` 命令时先解析 shebang，再启动真正的解释器。交互式终端中的 `/var/jb/usr/local/bin/pnpm` 和 `pnpx` 包装器始终使用 `/var/jb/usr/local/lib/nodejs22/node`，并把该 Node 目录放到子进程 PATH 首位；系统 Node 18 保持不变。

pnpm 以独立 deb 发布，版本和 registry 归档 SHA-256 锁定在 `versions.env`。构建命令：

```bash
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
```

设备安装后可检查版本并管理 Web profile 插件：

```bash
ssh -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/pnpm --version'
ssh -t -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root package@version'
```

profile 模板使用 `nodeLinker: hoisted` 和 `autoInstallPeers: false`。外部 bundle 的 DSH peer dependencies 从 Harness 维护的安装后备目录解析，不会在 profile 中重复安装整套 DSH。

## Provider bundle

DSH `0.2.1-rc.2` 当前版本固定为 `dsh-codex@0.2.10`。Mac 与 iPhone 共用
同一个 checkout 和版本；插件适配了 0.2.1 的 provider 图片预算、持久化 auth 注入、replay，以及
`prepareCall()` 冻结调用路径下的原生 Codex compaction；Provider 页还提供 pi-ai
OpenAI Codex、xAI 与 `@kelvinwww/dsh-oauth` Google OAuth 三个子页；锁定 pi-ai
`1.4.0` 后，OpenAI Codex 目录包含 GPT-6.1 Sol、GPT-6 Astra，xAI 对话目录包含 Grok 4.6，图片设置提供 Imagine 2.0 / Quality，并为三者分别保存
直连/VLESS 出口。对应模型路由分别为 `provider-codex`、`provider-xai` 与
`provider-google`，不会覆盖“模型”页的 `openai-codex`、`xai` API Key 路由；未登录的
OAuth 路由不会出现在聊天模型选择器中。`deploy.sh` 会先运行完整检查，从同级
`dsh-codex` checkout 生成 tarball，再安装进手机 Web profile：

```bash
./scripts/package-dsh-codex.sh
DEVICE_HOST=10.99.1.139 DEVICE_PORT=22 ./scripts/deploy.sh
ssh -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-codex'
ssh -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-cline-pass'
```

`dsh-cline-pass@0.2.13` 没有本地维护的产品分支：`cline-pass/package-lock.json` 固定官方 npm 包和 integrity。`package-dsh-cline-pass.sh` 默认从该输入打包，不先改变 Mac live profile；构建时不自动安装其 Host peers。它仍使用相对 fetch，iOS 补丁保留绝对同源 URL/Cookie/XHR 回退，并锁定 0.2.13 完整预像。Cline 的原有账号、配置和 `CLINE_PASS_API_KEY` 不由 deb 或原生 App 安装器写入。

Provider 的 zod 精确固定 `4.4.3`，与 DSH storage-domain 的公开 schema 类型一致。DSH 自带 pi-ai `1.3.0` 与 Provider 的 `1.4.0` 分开维护，不能全局覆盖成同一版本。原空 invariant companion 随 0.2.1 已退役接口删除。

## iPhone 原生网关

`mobile-gateway/package-lock.json` 固定官方 `dsh-plugin-mobile-gateway@0.11.1` 的纯 JavaScript 生产闭包。`package-mobile-gateway.sh` 生成 `0.11.1+iphone.1` 本机变体，包含完整依赖，不带 DSH peers 或 Linux setup/init 入口。它复用现有 `web` profile 和 `:3080/ws/mobile`，不另起 Harness；`lanEnabled:false`，不会占用手机上已有的 3081 服务。

```bash
./scripts/package-mobile-gateway.sh
```

安装与 profile 调整都在 Host 停止并备份后完成：用 `dsh22 plugin --profile web add --workspace-root --offline <网关 tarball>` 安装，再用 `scripts/install-native-profile.mjs` 的 dry-run/`--apply` 流程合并本机配置。该脚本修改 Host 的 `cordis.patch.yml` 并保留私有备份，不是向 App 注入配对或 Keychain。生命周期由 launchd 管理，网关不能 fork 重启/停止 Web，也不能启动桌面 Tunnel。App 安装、真实配对和验收见[原生 App 接入](./native-app.md)。

## OAuth 与凭据

无 Codex CLI 的设备使用插件自带的设备码登录：

```bash
ssh -tt -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/dsh22 plugin --profile web exec dsh-openai-codex login --device-code'
ssh -p 22 root@10.99.1.139 '/var/jb/usr/local/bin/dsh22 plugin --profile web exec dsh-openai-codex status'
```

浏览器完成授权后，插件把凭据以 `0600` 权限保存到 `/var/root/.dsh/.openai-codex-auth.json` 并自动刷新。该文件与 Codex CLI 的 `~/.codex/auth.json` 有独立的 refresh-token 生命周期；不要复制或共用 CLI 凭据文件。登录、状态和 Web 设置接口都不应输出 token。

Google OAuth 需要在 DSH 启动环境中配置 `GEMINI_CLIENT_ID` 与
`GEMINI_CLIENT_SECRET`；非免费 Code Assist 还需 `GOOGLE_CLOUD_PROJECT` 或
`GOOGLE_CLOUD_PROJECT_ID`。VLESS 节点统一在“设置 → VLESS”维护，三个 Provider
子页只保存自己的出口选择。Google 使用动态本机回调端口，手机部署必须在 iPhone
Safari 中完成授权；不要从 Mac 的 USB `3081` 页面发起，否则回调会落到 Mac。

pnpm 本身是 JavaScript，并已在 `ios/arm64` 上验证 registry 下载、解包、lockfile 和链接布局。这个结果不代表任意 npm 包都能在 iOS 运行：带平台限制、未提供 iPhoneOS arm64 产物的原生模块，或依赖本机编译工具链的生命周期脚本仍会失败。优先安装带预构建 JavaScript 产物且不需要安装脚本的 DSH bundle。

xAI OAuth 路由 `provider-xai` 与自有 grok2api 的 `xai` API Key 路由独立。若旧 OAuth 返回 `invalid_grant`，保留原凭据，由用户在 Provider → xAI 重新授权；不得隐藏模型目录失败来通过升级门禁。
