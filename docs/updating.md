# DSH 双端更新标准 SOP

本 SOP 用于把官方 DSH 新版本同步升级到 Mac 与本项目维护的 iPhoneOS 运行时。日常入口与分级检查见 [双端快速更新流程](./upgrade-workflow.md)。默认只升级 DSH；只有运行条件确实变化时，才升级 Node 或 pnpm。

更新分成两个阶段：

1. **审计与构建**：检查上游、更新锁定信息、适配 iOS、完成本地验证，不接触手机。
2. **双端部署与验收**：确认空闲并备份数据，先升级 Mac，再将同一份共享 Provider 和锁定运行时部署到 iPhone，分别做真实会话验证。

部署前必须通过第一阶段。查看到新版本不等于应立即安装。

## 固定原则

- `upstream/deepseek-harness` 是只读的官方 Git 子模块。本项目兼容上游，不要求上游兼容本项目，也不在子模块里保留任何本地修改。
- Git tag/commit 与 npm 发布包是两份独立证据：子模块固定到准确 commit，实际打包使用准确 npm 版本、integrity 和带时间截点的完整 lock。
- DSH 主程序默认跟进 npm `dist-tags.latest`；Provider 的 pi-ai、Cline Pass 和模型目录独立检查。`next`、单独出现的新 tag 或 `master` 新提交只做观察；用户明确指定目标时按其指令执行全部验证门禁。
- iOS 改动只存在于本仓库的 `scripts/`、`shims/`、`ios/`、`web/` 和 `packaging/` 中，并且只修改 `build/dsh-runtime` 内的发布包副本。
- 补丁必须 fail-closed。上游预像、文件名或 hash 变化时停止构建并逐项审计，不能为了让构建通过而放宽成模糊匹配。
- 新的上游版本把 Debian revision 重置为 `-1`；同一上游版本的本地修订依次使用 `-2`、`-3`，不能复用已经部署过的版本号。
- 构建和验证不会重启手机上的 DSH。只有正式部署会重载 DSH 服务；部署后不再额外手工重启。仅 DSH JavaScript 或 Web 资源变化不需要 respring。
- `/var/root/.dsh` 是用户数据，不属于安装包。升级前必须备份，排障或回滚时不得删除它。
- 单人维护默认在 `main` 上完成一个完整升级提交；实机验收通过后再 commit、push，不为每次版本升级创建额外分支。

## 0. 建立升级基线

从干净的父仓库开始：

```bash
cd /path/to/dsh-iphone
git status --short --branch
git submodule status
git -C upstream/deepseek-harness status --porcelain
. ./versions.env
printf 'DSH=%s\nDebian=%s\nUpstream=%s\n' \
  "$DSH_VERSION" "$DSH_DEBIAN_VERSION" "$DSH_UPSTREAM_COMMIT"
```

门禁：

- 父仓库没有与本次升级无关的未提交修改；如有，先保留并避开，不能覆盖。
- 子模块 `status --porcelain` 没有输出。
- `git submodule status`、`DSH_UPSTREAM_COMMIT` 和当前官方版本互相对应。
- 记下当前版本、commit、当前手机包版本和上一份可回滚的 deb。

此时不连接手机、不停止服务。

## 1. 确认官方发布

先只读取官方 Git 和 npm 信息：

```bash
node scripts/check-dsh-update.mjs --save .cache/upgrades/official-release.json
git -C upstream/deepseek-harness fetch --tags origin
git -C upstream/deepseek-harness log --oneline --decorate -20 origin/master
git -C upstream/deepseek-harness tag --sort=-version:refname | head -20
npm view @deepseek-ai/dsh dist-tags --json
. ./versions.env
dsh_latest_version=$(npm view @deepseek-ai/dsh dist-tags.latest)
printf 'installed=%s latest=%s\n' "$DSH_VERSION" "$dsh_latest_version"
```

如果 `dsh_latest_version` 与 `DSH_VERSION` 相同，保留 DSH 子模块、runtime lock 和核心包，继续检查报告中的 Provider 组件。组件和模型目录也无需更新时才结束；较高的 `next` 或 Git tag 不触发 DSH 升级。

只有 `latest` 已变化时才建立候选版本：

```bash
dsh_target_version=$dsh_latest_version
dsh_target_ref="dsh-v${dsh_target_version}"
dsh_target_commit=$(git -C upstream/deepseek-harness rev-parse "$dsh_target_ref^{commit}")
npm view "@deepseek-ai/dsh@$dsh_target_version" version dist.integrity time --json
printf '%s\n' "$dsh_target_commit"
```

候选版本必须同时满足：

- 官方 tag 能解析到一个确定 commit；
- 候选版本等于 npm `dist-tags.latest`，并且不同于当前 `DSH_VERSION`；
- npm 上存在完全相同的版本；后续锁定和安装都使用该完整版本号，不把 `latest` 写入版本文件或 lock；
- npm integrity 可以记录；
- 已阅读目标 tag 相对当前 `DSH_UPSTREAM_COMMIT` 的提交和文件变化；
- 已确认是否包含会话格式、配置格式、Node engine、依赖或授权/API 协议变化。

审查差异：

```bash
git -C upstream/deepseek-harness log \
  --oneline "$DSH_UPSTREAM_COMMIT..$dsh_target_commit"
git -C upstream/deepseek-harness diff \
  --stat "$DSH_UPSTREAM_COMMIT..$dsh_target_commit"
git -C upstream/deepseek-harness diff \
  --name-status "$DSH_UPSTREAM_COMMIT..$dsh_target_commit"
```

如果只有 `origin/master`、`next` 或新 tag 发生变化，而 npm `latest` 没变，不重建 DSH 核心。Provider 独立更新时只构建和部署它自己的 bundle，并验证与当前 DSH 的兼容性。

## 2. 更新精确锁定信息

确认候选版后再移动子模块：

```bash
./scripts/update-upstream.sh "$dsh_target_commit"
git submodule status
```

同步修改：

- `versions.env`
  - `DSH_VERSION`：官方 npm 完整版本；
  - `DSH_DEBIAN_VERSION`：例如 `0.1.0~rc.8-1`；
  - `DSH_UPSTREAM_COMMIT`：目标 tag 的完整 commit；
  - `DSH_NPM_INTEGRITY`：`npm view` 返回的 integrity；
  - `DSH_RELEASE_CUTOFF`：覆盖目标完整闭包各包的实际发布时间，避开下一版；不能直接使用 CLI 发布时间；
  - 上游依赖改变时同步核对 `NODE_PTY_VERSION`、`NODE_ADDON_API_VERSION` 和 require-builtin 的源码、独立 wrapper 头文件与 hash；
  - 浏览器兼容代码或缓存语义改变时才递增 `IOS_COMPAT_VERSION`。
- `dsh-runtime/package.json`：`@deepseek-ai/dsh` 使用完全版本，不用 `^`、`~` 或 `latest`。
- `scripts/patch-dsh.mjs`：支持版本、依赖版本、严格补丁预像、bundle 名和原始 hash。
- 官方布局、侧栏、对话和设置 bundle 保持原样；核对 mobile shell 依赖的 DOM 类名、Safari 转译与入口 cache key，并验证官方产物一致性。
- 共享 `dsh-codex`：同步 DSH peers/dev dependencies、锁文件和发生变化的 API，执行完整 check；不要把旧 DSH peer 打进手机 tarball。
- Provider 的 pi-ai 独立固定版本与 integrity，记录必需模型 ID；本地构建与双端运行中的 `check-provider-components.mjs` 均通过后，再做指定模型真实调用。
- 受版本影响的测试、README、兼容和通知文档。

Debian prerelease 使用 `~`，这样排序仍低于将来的正式版。上游版本没变而只发布本项目修正时，不改 `DSH_VERSION`，只增加 Debian revision。

用版本发布时间截点重建 npm 闭包：

```bash
. ./versions.env
npm install \
  --prefix dsh-runtime \
  --package-lock-only \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --before="$DSH_RELEASE_CUTOFF"
npm ci --prefix dsh-runtime --ignore-scripts --no-audit --no-fund
node tests/test-lockfile.mjs
```

再搜索遗漏的旧版本、旧 bundle 名和硬编码 compatibility 值：

```bash
rg -n 'rc\.[0-9]+|0\.1\.0-rc|ioscompat=[0-9]+' \
  README.md docs scripts tests web dsh-runtime/package.json versions.env
```

搜索结果不要求全部相同，但每个固定旧值都要判断是历史说明、回滚包，还是应该随升级更新的当前值。

## 3. 做 iOS 兼容审计

先运行严格准备流程：

```bash
./scripts/prepare-dsh.sh
```

上游升级后第一次失败通常是正常审计入口，不是应该绕过的错误。按失败位置检查以下兼容面：

| 兼容面 | 必查内容 | 本项目入口 |
| --- | --- | --- |
| 包与原生依赖 | DSH、`node-pty`、`node-addon-api` 版本，Node engine | `versions.env`、`scripts/patch-dsh.mjs`、`scripts/build-node-pty.sh` |
| 终端 | Apple `posix_spawn`、rootless Bash 路径、BSD inspector、PID 身份、PTY 退出清理 | `scripts/build-node-pty.sh`、`scripts/patch-dsh.mjs`、`tests/test-ios-subprocess.mjs` |
| 附件 | `sharp` 的导入位置和 DSH 实际调用面 | `shims/ios-sharp-shim.mjs` |
| Windows 隔离 | `koffi` 是否仍然只在 Win32 路径延迟加载 | 官方发布包与 `scripts/verify.sh` 的 import 验证 |
| 会话锁 | `node-addon-system/flock` 的 linux/darwin 平台判断与官方 C 源 | `scripts/build-ios-flock.sh`、`scripts/patch-dsh.mjs` |
| 内部模块加载 | `node-addon-require-builtin` 源码、独立 C++ wrapper 头文件、N-API ABI、签名和官方缓存开关 | `scripts/build-ios-require-builtin.sh`、`packaging/dsh/dsh22`、`tests/test-require-builtin.mjs` |
| profile 与插件 | HMR loader、pnpm 启动方式、Cordis patch 结构 | `scripts/patch-dsh.mjs` |
| 通知与授权 | `approval/asked` / `approval/decided` 会话事件与官方 Web 审批界面 | `ios/notifications/`、`tests/test-ios-notifications.mjs` |
| Live Activity | turn、goal、agent、tool 事件语义和终态生命周期 | `ios/notifications/`、`ios/activity/` |
| WebKit | hashed bundle 名、入口 hash、polyfill、module import 和 cache key | `web/index.ios.html`、`tests/test-ios16-frontend.mjs` |
| 持久化 | session/workspace/config 的格式版本和迁移说明 | 上游差异、`/var/root/.dsh` 备份与回滚方案 |

处理原则：

1. 先理解上游为什么改变，再决定旧补丁应更新、删除还是由上游能力替代。
2. 每个文本替换仍保持“一次且仅一次”；整文件替换继续校验官方原始 SHA-256。
3. hashed bundle 改名时同步修改补丁器、`web/index.ios.html`、验证脚本和测试。
4. 上游已经原生解决的问题应删掉本地补丁，不保留重复逻辑。
5. 新增兼容行为时同步增加回归测试，不能只修改产物让一次构建通过。
6. 始终确认官方子模块仍然干净：

```bash
git -C upstream/deepseek-harness status --porcelain
```

上一次 rc.6 → rc.7 就不是简单改版本号：`node-pty` 从 1.1.0 变为 1.2.0-beta.15，并改用上游 Apple `posix_spawn` 后端；Web 主 bundle 和入口 hash 也变化，因此同时调整了构建器、严格预像、测试、Web 入口和文档。这是后续升级必须做完整兼容审计的基准。

## 4. 本地构建与验证门禁

兼容审计完成后依次执行：

```bash
./scripts/package-dsh.sh
./scripts/verify.sh
```

`package-dsh.sh` 会重新执行 `npm ci`、严格补丁、node-pty、flock、require-builtin 编译和 iOS 通知组件构建。`verify.sh` 会检查 shell/JavaScript/plist、lockfile、shims、VLESS 配置、通知、Safari 16、移动端悬浮侧栏、原生产物、子模块 commit/版本/洁净度和 Git 污染。require-builtin 的源码与 C++ wrapper 头文件各自锁定 archive/hash，不与 node-pty 的头文件版本混用；构建保持官方运行时探测不变。

检查生成包：

```bash
. ./versions.env
dsh_deb="dist/dsh_${DSH_DEBIAN_VERSION}_iphoneos-arm64.deb"
dpkg-deb --info "$dsh_deb"
shasum -a 256 "$dsh_deb"
git diff --check
git diff --submodule=log
git status --short
```

本地门禁全部满足后才允许部署：

- `prepare-dsh.sh` 和补丁器 `--check` 均通过；
- `package-dsh.sh` 生成预期版本的 deb；
- `verify.sh` 完整通过，没有因缺少必要缓存而漏掉本次相关测试；
- 子模块 commit 正确且无本地修改；
- `build/`、`dist/`、`.cache/` 和 `node_modules/` 没有进入 Git；
- 已保留上一版可安装 deb 及其 SHA-256，能够回滚。

到这里仍然没有必要重启或连接手机。

## 5. 部署前保护手机状态

先在 DSH Web 中确认没有正在运行的 turn、subagent、待授权请求或尚未处理的用户确认。升级必然重载 DSH，不能在任务运行时部署。

本项目常用 USB SSH：

```bash
dsh_device_host=127.0.0.1
dsh_device_port=2224
dsh_device_user=root
ssh -p "$dsh_device_port" \
  "$dsh_device_user@$dsh_device_host" \
  'dpkg-query -W com.xxzzddxzd.dsh com.xxzzddxzd.nodejs22 com.xxzzddxzd.pnpm10; /var/jb/usr/local/bin/dsh22 --version'
```

通过局域网连接时只替换 host 和 port。确认磁盘空间和旧版本后，停止 DSH 并做一致性备份：

```bash
ssh -p "$dsh_device_port" \
  "$dsh_device_user@$dsh_device_host" \
  'launchctl bootout system/ai.deepseek.dsh >/dev/null 2>&1 || launchctl bootout user/foreground/ai.deepseek.dsh >/dev/null 2>&1 || true; dsh_backup=/var/root/.dsh.before-upgrade-$(date +%Y%m%d-%H%M%S); cp -a /var/root/.dsh "$dsh_backup"; printf "Backup: %s\n" "$dsh_backup"'
```

把输出的备份路径记入本次升级记录。安装包只替换程序目录，不应修改或删除此备份。

## 6. 部署

标准部署命令：

```bash
DEVICE_HOST="$dsh_device_host" \
DEVICE_PORT="$dsh_device_port" \
DEVICE_USER="$dsh_device_user" \
./scripts/deploy.sh
```

当前 `deploy.sh` 会安装仓库锁定的 Node、pnpm 和 DSH 三个 deb，并用 `DSH_DEPLOY_DEFER_START=1` 延迟 DSH 启动。使用本地自包含 tarball 的 `--offline` 安装完成 Provider bundle 和历史恢复检查后只 bootstrap 一次 DSH，再等待 3080 返回成功。即使本次只升级 DSH，Node 和 pnpm 的版本也必须仍与 `versions.env` 及 deb 依赖一致；它们不需要无理由升版。

部署会重载 DSH 服务，因此不要在部署之后再执行一遍手工重启。只有以下原生通知内容发生变化时，才额外 respring 一次让 SpringBoard 载入新代码：

- `DSHNotifierBridge.dylib`；
- 对应的 MobileSubstrate plist；
- SpringBoard 注入相关 entitlement 或加载路径。

仅更新 DSH npm 闭包、Host 通知插件、Live Activity broker/helper、Web 资源、配置或 launchd 服务，不需要 respring。

## 7. 实机验收

先做只读检查：

```bash
ssh -p "$dsh_device_port" \
  "$dsh_device_user@$dsh_device_host" \
  'dpkg-query -W com.xxzzddxzd.dsh com.xxzzddxzd.nodejs22 com.xxzzddxzd.pnpm10; /var/jb/usr/local/bin/dsh22 --version; /var/jb/usr/local/bin/pnpm --version; /var/jb/usr/local/bin/dsh-activity status'
```

随后至少完成一轮真实 Web 会话，而不是只检查首页 200：

两端使用 `check-upgrade-host.mjs --save` 保存升级前基线，部署后用 `--compare` 核对原会话与默认模型，再运行 `smoke-upgrade-host.mjs mac|iphone`。具体环境变量和命令见 [快速更新流程](./upgrade-workflow.md)。验收同时检查 `tool/result.isError`、真实输出、退出码、流式帧和完成状态；`turn/end` 本身不代表工具成功。测试结束必须先退出持久 shell，再恢复测试会话权限。

1. 3080 首页可打开，Safari 使用当前 `ioscompat` 入口，没有旧 bundle 或白屏。
2. 工作区和升级前已有会话仍可见，能打开一条旧会话。
3. 新建会话发送普通消息，SSE/流式回复能完整结束。
4. 让模型执行一个短 Bash 工具，验证 node-pty、工具输出和授权流。
5. 验证一次完成通知；涉及事件或 UI 改动时再验证 Live Activity、点击 session 深链接和通知授权按钮。
6. 涉及 GPT 分流时验证代理日志中的 OpenAI 请求；模型执行的 `curl ipify.org` 属于 Bash 工具流量，不能代表 GPT 通道出口。
7. 检查 `/var/root/dsh.log` 没有持续重启、模块加载失败、未处理异常或版本格式错误。

任何一项失败都不提交“升级完成”。先保留日志，判断是上游回归、本项目兼容遗漏还是设备状态问题。

## 8. 回滚

回滚使用上一份已验证 deb，不删除 `/var/root/.dsh`：

```bash
scp -P "$dsh_device_port" \
  dist/dsh_<上一版本>_iphoneos-arm64.deb \
  "$dsh_device_user@$dsh_device_host:/var/root/dsh-rollback.deb"
ssh -p "$dsh_device_port" \
  "$dsh_device_user@$dsh_device_host" \
  'dpkg -i /var/root/dsh-rollback.deb'
```

如果上游已经把持久化数据迁移成旧版本无法读取的格式，停止尝试启动旧版，先保存故障现场，再从第 5 步记录的 `.dsh.before-upgrade-*` 恢复。恢复数据属于有状态回滚，必须先再次备份当前 `.dsh`，不能直接覆盖。

代码侧通过一个新的修正提交恢复旧子模块 gitlink 和对应锁定文件；不要使用 `git reset --hard` 清除已经完成的升级工作。

## 9. 提交与推送

实机验收通过后检查最终范围：

```bash
git diff --check
git diff --submodule=log
git status --short
git add upstream/deepseek-harness versions.env \
  dsh-runtime/package.json dsh-runtime/package-lock.json
# 再逐项添加本次已审查的兼容脚本、测试与文档；不把其他任务的草稿一起 stage。
git diff --cached --stat
git commit -m "Update DSH to <version>"
git push origin main
```

提交应包含子模块 gitlink、版本文件、npm lock、兼容修改、测试和文档；不包含 `build/`、`dist/`、`.cache/`、`node_modules/` 或 deb。

共享 Provider 的相关修改先在其仓库提交并推送，再推送本仓库，保证两端依赖的 checkout 可以恢复到同一份已发布源码。

## 完成标准

每次升级结束前逐项确认：

- [ ] npm `latest` 已变化，且与官方 tag、commit、npm version 和 integrity 对应；
- [ ] `versions.env`、`package.json`、lockfile 和 Debian revision 已同步；
- [ ] 上游差异中的依赖、API、Web、持久化和 iOS 兼容面已审计；
- [ ] 严格补丁没有被放宽，子模块保持干净；
- [ ] `package-dsh.sh` 与 `verify.sh` 完整通过；
- [ ] 上一版 deb、SHA-256 和手机数据备份路径已记录；
- [ ] 部署前没有活动任务，部署后未做无必要的额外重启/respring；
- [ ] Mac 与 iPhone 的旧会话、默认模型、工作区、新对话、工具、通知及受影响功能分别验证通过；
- [ ] 最终提交只含相关源码、锁、测试和文档；共享 Provider 和本仓库均已推送，其他草稿保留。

## Node 或 pnpm 何时跟随升级

DSH 更新不自动等于 Node 或 pnpm 更新。只有出现以下情况才扩大范围：

- 新 DSH 的 `engines.node` 超出当前 Node 22.23.2；
- `node-pty` 或 N-API 变化需要新 Node ABI/头文件；
- DSH 插件管理调用方式与当前 pnpm 10.34.5 不兼容；
- 上游明确修复了当前运行所依赖的问题，并且升级收益经过验证。

### 更新 Node

Node 补丁文件名与版本一一对应。更新时先下载官方源包并记录 SHA-256：

```bash
curl -fLO https://nodejs.org/dist/v22.23.2/node-v22.23.2.tar.xz
shasum -a 256 node-v22.23.2.tar.xz
```

对新版本建立新的 `patches/node-v<version>-ios.patch`，不要覆盖旧补丁后假装兼容。至少重新审查：

- GYP 对 Apple flavor 的处理；
- V8 `RwxMemoryWriteScope` 的构造和生命周期；
- c-ares 的 Darwin feature detection；
- Node crypto 的 Apple 证书实现；
- entitlement 与启动参数是否仍然需要。

在干净官方源包上验证补丁并执行完整构建：

```bash
NODE_ARCHIVE_PATH=../node-v22.23.2.tar.xz ./tests/test-source-patches.sh
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

### 更新 pnpm

pnpm 使用 npm registry 发布的完整 JavaScript 发行包，不使用 Corepack 在设备上即时下载。更新时修改 `versions.env` 的版本、URL、SHA-256 和 Debian revision，然后执行：

```bash
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

实机至少验证 pnpm 版本、一个隔离 store 的 registry 安装，以及：

```bash
dsh plugin --profile web why <已安装插件>
```

pnpm 能运行不代表含原生模块的任意插件已经适配 iPhoneOS。

## Mac 端同步升级

Mac 与 iPhone 使用同一个 DSH npm 完整版本、release cutoff 和共享 Provider checkout。升级前同样确认空闲，bootout `gui/$(id -u)/ai.deepseek.dsh-mac` 并备份 `~/.dsh`、LaunchAgent 和全局 DSH 程序目录；不要清除既有 profile、凭据或会话。

```bash
. ./versions.env
npm install -g "@deepseek-ai/dsh@$DSH_VERSION" --before="$DSH_RELEASE_CUTOFF" --no-audit --no-fund
./scripts/install-mac-pnpm.sh
PATH="$HOME/.local/share/dsh-iphone/bin:$PATH" dsh plugin --profile web add --workspace-root "link:../dsh-codex"
PATH="$HOME/.local/share/dsh-iphone/bin:$PATH" dsh plugin --profile web add --workspace-root "dsh-cline-pass@$DSH_CLINE_PASS_VERSION"
```

Mac DSH 的 LaunchAgent 使用锁定的 pnpm 10.34.5，确保 profile 中 `nodeLinker: hoisted` 和 `autoInstallPeers: false` 生效。pnpm 9 不读取这些 workspace 设置，会为第三方 bundle 解析旧的 DSH peer，不能用于新 profile 的安装。原来启用 Schedule 的 profile 使用 `@deepseek-ai/dsh-experimental-schedule-bundle`，删除针对已移出默认组合的 `ui-schedule` 的旧启用行；保留既有任务库。

官方 Settings 会将旧 `settings.yaml` 导入当前 profile 并重命名为 `.imported`。Provider 自有设置从两种文件名都能导入；验收时检查旧会话、默认模型、模型显示与容量、Provider 登录和出口选择，不能只核对 CLI 版本。

## 2026-10-12：0.2.0-rc.2 升级记录

| 项目 | 最终值 |
| --- | --- |
| Mac / iPhone DSH | `0.2.0-rc.2` |
| iPhone Debian 包 | `0.2.0~rc.2-4` |
| 官方源码 commit | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| npm 发布截点 | `2026-09-30T00:00:00.000Z`，覆盖该版所有内部依赖的发布 |
| Provider bundle | `dsh-codex 0.2.7` / pi-ai `0.87.1` / Cline Pass `0.2.8` |
| Web compatibility | `17` |
| 最终 deb SHA-256 | `571a0bc2ce2c54f5cb45688ee542c1d432d0435c3ba2e08ae80e441f7b0670c9` |

本次对齐 Settings/storage domain、pi-ai transcript、PTC 图片上下文和 v4 会话格式，更新 Safari 16 语法、缓存、重连、通知与图片处理适配。iOS 新增官方 require-builtin 的 N-API v9 构建与签名，使用官方缓存开关；终端复用设备已验证的 BSD process inspector，并将默认 Bash 路径设为 `/var/jb/bin/bash`。保留上游运行时探测、PID 身份复查和权限边界。Mac profile 使用安装归属的 pnpm 10.34.5，并迁移已启用的 Schedule 与本机余额插件到新版接口。

验证结果：

- `package-dsh.sh`、`verify.sh`、Provider 的 70 项测试、类型检查与打包检查通过；官方子模块保持干净。
- 两端均通过认证读取旧会话，并完成真实流式对话；Bash 返回验收标记及退出码 0。
- iPhone 原生 builtin loader、PTY、进程身份校验、透明 PNG、JPEG 缩放与非法图片拒绝验证通过；系统通知桥接和 WebClip 认证通过。
- Mac 升级前的 119 个会话、iPhone 升级前的 141 个会话可见；122 份 Mac 历史压缩会话文件和 227 份 iPhone 历史 JSONL 文件均与备份逐字节一致。
- Provider tarball 包含锁定的纯 JavaScript 生产闭包，无嵌套 DSH peer 或原生模块；手机离线安装通过。Cline Pass 的入口为「设置 → 插件 → Cline Pass」。

数据备份为 Mac 的 `~/.dsh.before-upgrade-0.2.0-rc.2-20261012` 和手机的 `/var/root/.dsh.before-upgrade-0.2.0-rc.2-20261012`。保留上一版 `dsh_0.1.5~rc.1-1_iphoneos-arm64.deb`，SHA-256 为 `4890be7015045770532724e4b2055243b0860149cb9488419ec95a7cf2bbfea8`。本次不需要 respring。

## 2026-10-14：Provider pi-ai 与 GPT-6.1 Sol

本次仅升级共享 Provider。官方 npm `latest` 为 pi-ai `1.2.0`；DSH 和 Cline Pass 的 `latest` 分别仍为 `0.2.0-rc.2`、`0.2.8`。DSH 核心、官方子模块、runtime lock 和 iOS compatibility `17` 保持当前已验证版本。

| 项目 | 最终值 |
| --- | --- |
| Mac / iPhone Provider | `dsh-codex 0.2.8` / pi-ai `1.2.0` |
| 共享 Provider 源码提交 | `f007f04`，已推送至维护用 fork 的 `main` |
| 必需 Codex 模型 | `gpt-6.1-sol`，两端实际 Host 选择目录均可见 |
| pi-ai integrity | `versions.env` 中的 `DSH_CODEX_PI_AI_INTEGRITY`，与官方 npm 和 Provider lock 一致 |
| pi-ai Node engine | `>=22.19.0`；iPhone `22.23.2`、Mac `26.3.1` 满足 |
| 已部署离线包 | `dsh-codex-0.2.8.tgz` |
| 离线包 SHA-256 | `9da2c918c0a2253849ca2159fad121bab9f437781f1bb03ca65dfb7a06338b14` |

适配 pi-ai 的统一图片目录 `Provider.getAllModels()`，同时保留聊天和图片模型的路由别名；继续提供 Grok Imagine 2.0 / Quality。DSH 自带 adapter 的 pi-ai 版本与 Provider 分开锁定，没有整体替换核心依赖。新增认证后的只读组件端点，以及 manifest、lock integrity、编译版本、原始模型目录和实际 Host 选择目录检查。日常更新入口同时检查 DSH、pi-ai、Cline Pass，避免 DSH 版本未变时漏掉组件和模型更新。

验证与数据结果：

- Provider 的 73 项测试、类型检查、构建、导入检查与离线打包通过；iPhone 离线包包含纯 JavaScript 生产依赖，没有嵌套 DSH peer 或原生模块。父仓库 `verify.sh` 通过。
- 两端运行中的组件端点均报告 bundle `0.2.8`、pi-ai `1.2.0`，Codex 原始目录包含 9 个模型；必需模型同时通过 Host 目录检查。
- Mac 验收会话 `session-upgrade-mac-186e5a83-839d-406b-827d-8acb0d8150e3`、iPhone 验收会话 `session-upgrade-iphone-76f9cf9f-0a76-47b9-ac69-d9a19ba6ad76` 的真实请求均使用 `provider-codex / gpt-6.1-sol / low`。分别观察到 87、90 个流式帧，Bash 输出随机标记并以 0 退出，turn 完成。
- 指定模型验收等待异步默认模型保存，再恢复测试开始前的默认值；iPhone 测试会话权限也已恢复。Mac 用户在升级期间主动将默认模型改为 GPT-6.1 Sol（max），确认后保留；原基线不覆盖，另存该确认记录。iPhone 默认模型仍为原 Cline Pass 模型。
- Mac 原有 128 个、iPhone 原有 145 个会话全部保留，旧会话 v4 读取通过；新增验收会话后分别为 129、146 个。Mac 部署前的运行中任务经用户授权停止，之后双端空闲检查通过。
- 两端当前启动后的日志未发现 error/fatal/exception/unhandled；iPhone Safari 认证与现有 DSH WebClip 启动 URL 已刷新。

数据备份为 Mac 的 `~/.dsh.before-pi-ai-1.2.0-20261014` 和 iPhone 的 `/var/root/.dsh.before-pi-ai-1.2.0-20261014`。旧 Provider `0.2.7` 离线包、编译产物、升级前基线和本次验收报告保留在 `.cache/upgrades/provider-pi-ai-20261014/`，不提交凭据或运行数据。本次无需重装核心、编译 Node 或 respring。

## 2026-10-14：Provider 0.2.9 设置保存修复

`0.2.8` 的模型目录与真实调用验收通过后，发现真实 Host 中保存 Provider 设置会返回 `Provider settings service is unavailable`。根因是设置消费者只注入 `storageDomain`，却通过 `ctx.storage.domain` 访问未声明的 `storage` 服务，导致设置初始化失败；根 Context 中的直接调用测试没有复现插件依赖限制。

共享 Provider `0.2.9` 同时注入两个存储服务。Loader 回归先复现原报错，再验证延迟挂载存储服务、保存模型与 Responses 设置，以及卸载重载后保留。组件端点新增持久化设置就绪状态，运行中组件检查要求 `settingsReady: true`；新增 `check-provider-settings.mjs` 按当前有效值实际保存并重读 Codex/xAI 模型、图片工具和 Responses 开关，核对默认模型及有效设置没有改变。

| 项目 | 结果 |
| --- | --- |
| Mac / iPhone Provider | `0.2.9`，pi-ai 保持 `1.2.0` |
| Provider 源码提交 | `77b2e75`，维护 fork 的 `main` |
| 已部署离线包 SHA-256 | `e7c05db357a9914a66e343d3820519bd9865ec93b630de3d9620287d0755a569` |
| 本地门禁 | Provider 73 项测试、类型检查、构建、导入、离线打包及父仓库 `verify.sh` 通过 |
| 双端设置验收 | 设置服务就绪；四组设置实际保存、重读通过，偏好文件已写入各自 `storages` |
| 会话与默认模型 | Mac 原 131 个、iPhone 原 146 个会话全部保留；新增验收后为 132、147 个；两端默认模型不变 |
| GPT-6.1 Sol 再验收 | Mac / iPhone 均完成真实流式对话和 Bash，退出码 0；分别为 94、90 个流式帧 |

真实验收会话分别为 `session-upgrade-mac-1fe6dfcd-b7a5-45d6-bbb1-7266686799c6`、`session-upgrade-iphone-85aea930-9bab-4c35-84d9-48b352ce723e`。测试权限和默认模型均恢复；Mac 保留用户选择的 GPT-6.1 Sol（max）。Mac 部署时按已有授权暂停同一个运行会话，未中断其他会话。

停止服务后的数据备份为 Mac 的 `~/.dsh.before-settings-fix-0.2.9-20261014`、iPhone 的 `/var/root/.dsh.before-settings-fix-0.2.9-20261014`。原 Provider `0.2.8` 包、编译产物、基线和验收报告位于 `.cache/upgrades/provider-settings-20261014/`。两端启动后的运行日志未发现新错误，Mac 浏览器与 iPhone WebClip 认证已刷新。DSH 核心、子模块、Node、Cline Pass 和原生组件保持原版本。

## 2026-10-27：DSH 0.2.1 与原生 iPhone App

按用户要求同时更新 Mac 和 iPhone，保留手机独立的 launchd DSH 服务及原网页入口。原生界面复用 Whaleness，未把 Harness 引擎搬进 App。DSH 目标取当时 npm `latest` 的 `0.2.1-rc.2`，没有用更高的 Git tag 或 `next` 代替发布策略。

| 项目 | 最终值 |
| --- | --- |
| Mac / iPhone DSH | `0.2.1-rc.2`；iPhone Debian `0.2.1~rc.2-1` |
| 官方 commit / 发布截点 | `687f282e8625c6b8d11ff58211a90524be2e4317` / `2026-10-18T00:00:00.000Z` |
| Provider | `0.2.10` / pi-ai `1.4.0` / zod `4.4.3`，源码提交 `d2fec70` |
| Cline Pass / Gateway | `0.2.13` / `0.11.1+iphone.1` |
| 原生 App | Whaleness `1.7.11 / build 34`，iOS `16.1+` |
| App 上游源码 | `9bf3955c8add4ebffaed5699d59e75ddc86733ad`，MIT 许可随补丁保留 |
| App 补丁 SHA-256 | `b0d4ee2b527e3192e6120a634b52175ddec8fe2b2d618b017755f080edcc26be` |
| builtin / Safari compatibility | `0.1.9`（N-API v9）/ `18` |
| Node / pnpm / Xray | 保留 `22.23.2` / `10.34.5` / `26.3.27` |

已部署产物 SHA-256：

| 产物 | SHA-256 |
| --- | --- |
| DSH deb | `8393dabe4da3744d49e571ad4ad6a04a0ba438b7dc7d3732ee7ba613eecff643` |
| Provider tarball | `9328b1e72a3bf71fcc370ed2b6b40b144795f7990917b213e314807af8740373` |
| Cline Pass tarball | `02702d9616cbfb1fbae5bd66f085c5031cac54cb22d0a553a4870b070e7803a7` |
| Gateway tarball | `1698b918d0eaf8ad89723a3b333850c34c3485a6009273c4c882ab6b5558ec6f` |
| App build 34 IPA | `538dbaac1d866ade1b8ffbe7ccc8bb9be532e4acaea9a992eb10a253e8717e39` |

适配与验证：

- builtin 拆包后仍按 entry 目录加载本地 N-API 产物，锁定新 loader、源码及 30 个编译单元；缓存禁用，stock internal require 仍拒绝。更新 frontend 资产/hash 和 Safari 16 转译，Node client 不打浏览器补丁。
- Provider 对齐 DSH peers，移除官方退役的空 invariant companion。直接 Zod 与 storage-domain 边界对齐，默认堆下通过类型检查；pi-ai 1.4 退役的 Spark/GPT-5.5 不再由新目录承诺可调用，旧会话内容保留。Mac 退役 schedule bundle 与余额插件按精确预像迁移，任务库不删。
- Gateway 只挂载 `127.0.0.1:3080/ws/mobile`，不启用额外 LAN/Tunnel 或 fork 重启/停止 DSH；离线生产闭包无嵌套 DSH peers、原生模块或手机 registry 解析。
- App 经 TrollStoreLite 正常容器安装，真实 Keychain 配对及关闭进程后的自动重连通过，build 34 升级保留同一容器。本机模式不依赖定位/静音音频保活，不重复创建通知或 Activity；Root 后台保留原活动窗样式，通过受信本机 profile 映射跳转原生根会话，缺失映射时回退网页。
- build 34 键盘回车复用现有发送回调和门禁，保留 marked-text 确认、多行粘贴及硬件 Shift+Return 换行。用户实机确认“发送和活动窗都正常”。新增 UIKit/XCTest 源码语法解析通过，但未运行 Simulator XCTest，不将其记为已执行测试。
- Provider 73 项测试、类型检查、构建和导入通过；Gateway、Cline、profile 迁移、URL 拒绝条件及 App 安装/映射测试通过。KMP Release framework、build 33/34 两次完整 App archive 成功。
- 升级前 Mac 159 个、iPhone 152 个会话 ID 和默认模型基线保留，各新增一条验收会话。旧会话 v4 读取通过；手机首次 22 MB 冷日志 follow 曾超时，随后原严格条件下约 1.5 秒通过，未为此放宽检查。
- Mac 验收会话 `session-upgrade-mac-eb9bf4a1-8695-4c2d-a02c-c1bac2937a43`、iPhone `session-upgrade-iphone-f078050e-9343-471c-8cf3-9b70ef440356` 均使用 `provider-codex / gpt-6.1-sol / low`，分别 90、94 个流式帧；Bash 标记、退出码 0、turn 完成均通过。测试权限与默认模型恢复。
- Native Gateway 真实配对、token 重连、10 个工作区、旧历史、原子 snapshot 和必需模型通过；只撤销验收器自己的设备，App 配对保留。手机 builtin、flock 实锁竞争、PTY Bash、PNG Alpha/缩放、JPEG 与非法图拒绝均实测通过；5 个原生产物的平台/架构/签名 hash、新网页及 8 个资产 hash 通过，原 3081 服务保留。
- 新目录门禁暴露手机旧 xAI 授权无法刷新；OAuth 实现及旧凭据未被升级改写。用户完成官方重新授权后目录无失败，grok2api API Key 路由独立保留。通知桥在用户授权后只重载一次 SpringBoard，原生通知链接被桥接受，活动点击经用户确认正常。

数据备份为 Mac `~/.dsh.before-native-0.2.1-20261027`、手机 `/var/root/.dsh.before-native-0.2.1-20261027`；程序备份为本次缓存中的 `mac-program-before`、手机 `/var/root/dsh-program.before-native-0.2.1-20261027`，旧 Provider 源码/lib 另行保留。脱敏报告、日志和产物摘要在 `.cache/upgrades/native-0.2.1-20261027/`，不提交会话正文、Cookie、token、配对串或 App 数据。
