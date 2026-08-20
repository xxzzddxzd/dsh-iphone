# DSH 更新标准 SOP

本 SOP 用于把官方 DSH 新版本升级到本项目维护的 iPhoneOS 运行时。默认只升级 DSH；只有新 DSH 的运行条件确实变化时，才进入后面的 Node 或 pnpm 升级流程。

更新分成两个阶段：

1. **审计与构建**：检查上游、更新锁定信息、适配 iOS、完成本地验证，不接触手机。
2. **部署与验收**：确认没有正在运行的任务，备份数据，再安装到手机并做真实会话验证。

部署前必须通过第一阶段。查看到新版本不等于应立即安装。

## 固定原则

- `upstream/deepseek-harness` 是只读的官方 Git 子模块。本项目兼容上游，不要求上游兼容本项目，也不在子模块里保留任何本地修改。
- Git tag/commit 与 npm 发布包是两份独立证据：子模块固定到准确 commit，实际打包使用准确 npm 版本、integrity 和带时间截点的完整 lock。
- 只有 npm `dist-tags.latest` 与当前 `DSH_VERSION` 不同时才启动升级。`next`、单独出现的新 tag 或 `master` 新提交只做观察，不构建、不部署。
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
git -C upstream/deepseek-harness fetch --tags origin
git -C upstream/deepseek-harness log --oneline --decorate -20 origin/master
git -C upstream/deepseek-harness tag --sort=-version:refname | head -20
npm view @deepseek-ai/dsh dist-tags --json
. ./versions.env
dsh_latest_version=$(npm view @deepseek-ai/dsh dist-tags.latest)
printf 'installed=%s latest=%s\n' "$DSH_VERSION" "$dsh_latest_version"
```

如果 `dsh_latest_version` 与 `DSH_VERSION` 相同，到此停止。即使 `next` 或 Git tag 更高，也不继续移动子模块、生成 lock、构建或部署。

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

如果只有 `origin/master`、`next` 或新 tag 发生变化，而 npm `latest` 没变，不进入打包部署流程。

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
  - `DSH_RELEASE_CUTOFF`：目标版已经发布、下一版尚未发布的 UTC 时间；
  - 上游依赖改变时同步核对 `NODE_PTY_VERSION`、`NODE_ADDON_API_VERSION`；
  - 浏览器兼容代码或缓存语义改变时才递增 `IOS_COMPAT_VERSION`。
- `dsh-runtime/package.json`：`@deepseek-ai/dsh` 使用完全版本，不用 `^`、`~` 或 `latest`。
- `scripts/patch-dsh.mjs`：支持版本、依赖版本、严格补丁预像、bundle 名和原始 hash。
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
| 终端 | Apple `posix_spawn` 后端、helper 路径、iPhoneOS 头文件声明 | `scripts/build-node-pty.sh`、`shims/native/` |
| 附件 | `sharp` 的导入位置和 DSH 实际调用面 | `shims/ios-sharp-shim.mjs` |
| Windows 隔离 | `koffi` 是否仍然只在 Win32 路径使用 | `shims/ios-koffi-stub.mjs` |
| profile 与插件 | HMR loader、pnpm 启动方式、Cordis patch 结构 | `scripts/patch-dsh.mjs` |
| 通知与授权 | 事件名、mux 路径、`rpcId`、`/api/respond` 响应格式 | `ios/notifications/`、`tests/test-ios-notifications.mjs` |
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
./scripts/prepare-dsh.sh
node scripts/patch-dsh.mjs --root build/dsh-runtime --check
./scripts/package-dsh.sh
./scripts/verify.sh
```

`package-dsh.sh` 会重新执行 `npm ci`、严格补丁、node-pty 编译和 iOS 通知组件构建。`verify.sh` 会检查 shell/JavaScript/plist、lockfile、shims、VLESS 配置、通知、Safari 16、原生产物、子模块 commit/版本/洁净度和 Git 污染。

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
  'dpkg-query -W com.xxzzddxzd.dsh com.xxzzddxzd.nodejs22 com.xxzzddxzd.pnpm10; tail -n 40 /var/root/dsh.log'
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

当前 `deploy.sh` 会安装仓库锁定的 Node、pnpm 和 DSH 三个 deb，执行包内签名/launchd 安装，并等待 3080 返回成功。即使本次只升级 DSH，Node 和 pnpm 的版本也必须仍与 `versions.env` 及 deb 依赖一致；它们不需要无理由升版。

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
  'dpkg-query -W com.xxzzddxzd.dsh com.xxzzddxzd.nodejs22 com.xxzzddxzd.pnpm10; /var/jb/usr/local/bin/dsh22 --version; /var/jb/usr/local/bin/pnpm --version; /var/jb/usr/local/bin/dsh-activity status; tail -n 120 /var/root/dsh.log'
```

随后至少完成一轮真实 Web 会话，而不是只检查首页 200：

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
git add .gitmodules upstream/deepseek-harness versions.env \
  dsh-runtime packaging patches scripts shims ios web tests docs \
  README.md THIRD_PARTY_NOTICES.md
git diff --cached --stat
git commit -m "Update DSH to <version>"
git push origin main
```

提交应包含子模块 gitlink、版本文件、npm lock、兼容修改、测试和文档；不包含 `build/`、`dist/`、`.cache/`、`node_modules/` 或 deb。

## 完成标准

每次升级结束前逐项确认：

- [ ] npm `latest` 已变化，且与官方 tag、commit、npm version 和 integrity 对应；
- [ ] `versions.env`、`package.json`、lockfile 和 Debian revision 已同步；
- [ ] 上游差异中的依赖、API、Web、持久化和 iOS 兼容面已审计；
- [ ] 严格补丁没有被放宽，子模块保持干净；
- [ ] `package-dsh.sh` 与 `verify.sh` 完整通过；
- [ ] 上一版 deb、SHA-256 和手机数据备份路径已记录；
- [ ] 部署前没有活动任务，部署后未做无必要的额外重启/respring；
- [ ] 旧会话、工作区、新对话、工具、通知及受影响功能已实机验证；
- [ ] 最终提交只含源码、锁、测试和文档，并已 push 到 `main`。

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
