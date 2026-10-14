# Mac 与 iPhone 双端快速更新流程

所有升级使用一份 `versions.env`、一份官方源码 gitlink、一份 npm lock 和同一份 `dsh-codex` checkout。每个阶段保留结果；USB 中断时从手机部署阶段继续，不重复升级已经验收的 Mac。详细命令和回滚步骤见 [更新 SOP](./updating.md)。

```mermaid
flowchart LR
  A[检查官方 latest] --> B[固定候选并审计差异]
  B --> C[适配与构建检查]
  C --> D[两端空闲基线与备份]
  D --> E[Mac 部署与验收]
  E --> F[iPhone 离线部署与验收]
  F --> G[双端记录与提交推送]
```

## 日常入口

在 `dsh-iphone` 根目录执行：

```bash
node scripts/check-dsh-update.mjs --save .cache/upgrades/official-release.json
```

这个命令读取官方 DSH npm/tag，以及 Provider 的 pi-ai、Cline Pass 的独立 npm 发布：对照准确版本、commit、integrity、Node engine 和依赖变化。`dshStatus` 表示 DSH 本身是否变化，顶层 `status` 汇总组件变化；只有两者及组件都为 current 才结束检查。较高的 `next` 只作观察。网络失败、发布不完整或锁定信息不符时停止，不能按“没有更新”处理。

**DSH 主版本不变，也可能需要更新 Provider 和模型目录。** pi-ai 有自己的发布周期和静态模型数据，升级 DSH 不会自动把本地 Provider 的 pi-ai 升到最新版本。

报告中的 engine 为 `null` 表示 CLI manifest 未声明，仍需检查完整闭包和官方启动实现，不能据此认定运行条件没有变化。

默认跟进 npm `latest`。用户明确指定其他版本时，按指定版本建立候选并执行相同门禁。

## 每次更新的七个阶段

| 阶段 | 自动执行的内容 | 需要审计或确认的内容 | 完成证据 |
| --- | --- | --- | --- |
| 1. 候选 | 官方 npm/tag 检查、依赖与 engine 差异 | release notes、准确 Git 差异；不能用 master 代替发布 tag | 候选版本、commit、integrity |
| 2. 版本闭包 | 更新 runtime lock、严格预像检查 | 内部包版本、完整发布时间截点、Provider peer/API | `versions.env` 与 lock 一致 |
| 2a. Provider 组件与目录 | pi-ai/Cline Pass 发布检查，Provider manifest、lock integrity、编译版本与模型清单核对 | 新增/删除模型、默认容量、图片/聊天 API 变化；本次要求的模型 ID | 本地与两端实际加载的组件、目录一致 |
| 3. 本地门禁 | Provider check、iOS 构建、`verify.sh` | 失败补丁与新增兼容面；上游已修复的旧补丁应移除 | 检查成功、deb/tarball SHA |
| 4. 保护数据 | 保存两端会话与默认模型基线 | Web 中确认队列、后台任务、审批和问答已处理；停止服务后备份 | 基线、数据与程序备份 |
| 5. Mac | 精确 npm 安装、锁定 pnpm、共享 Provider 更新、健康与对话验收 | 已启用的额外插件与配置迁移 | Mac 版本与验收结果 |
| 6. iPhone | 上传已构建产物、签名、Provider 离线安装、历史检查、一次 bootstrap、健康与对话验收 | SSH/USB 连通、原生模块、Safari 与通知 | iPhone 包版本与验收结果 |
| 7. 收尾 | 基线比较、数据核对、保存记录 | 所有受影响功能通过；只提交本次相关源文件 | 双端均通过、两份仓库已推送 |

### 只审计本次变化，但始终保留核心验收

| 上游变化 | 本次重点 |
| --- | --- |
| 普通修复、直接依赖与公共接口没有变化 | 更新精确版本和 lock；验证严格预像、旧会话、真实对话和 Bash |
| Web bundle、DOM 类名或使用的 JS API 改变 | 审计 Safari 16 语法、polyfill、缓存、重连、侧栏、输入框和设置入口；必要时递增 `IOS_COMPAT_VERSION` |
| Node engine、native addon、subprocess 或 PTY 改变 | 检查所有平台分支、rootless 路径、ABI、签名、原生加载、终端启动与清理；先做设备原生探针，再做真实 Bash |
| Settings、storage、LLM 或工具上下文改变 | 对齐 Provider peers，检查偏好导入/持久化、默认模型、OAuth、pi-ai transcript、图片与压缩接口 |
| 会话格式、事件或持久化改变 | 使用备份和官方历史格式目录；确认旧世代保留、子会话事实、插件自有事件和新 writer 格式 |
| 通知/Live Activity 事件或原生注入改变 | 验证完成、审批、问答、目标和终态；只有注入代码确实改变才 respring |

Node、pnpm、Xray 和原生通知组件按依赖变化升级，普通 DSH 更新复用它们的准确版本与已验证产物。不要每次都重新编译 Node，也不要顺带升级所有第三方库。

## 候选准备与构建

1. 更新只读官方子模块指针、`versions.env`、`dsh-runtime/package.json` 和完整 lock；审计 `patch-dsh.mjs` 的支持版本、预像和 bundle hash。
2. 同步共享 Provider 的 DSH peers/dev dependencies 与 pnpm lock。只有实际需要时更新 pi-ai、Cline Pass 和 native addon；本地 Provider 代码变更要升自己的 bundle 版本。
3. `DSH_RELEASE_CUTOFF` 必须覆盖目标闭包各包的实际发布时间，并避开下一版。**CLI 的发布时间不代表其依赖已全部发布**。本次 rc.2 的部分内部包晚于 CLI 发布，直接用 CLI 时间会解析失败。
4. 同一上游版本的修订必须递增 Debian revision；已部署的编号不再复用。

常规构建入口：

```bash
./scripts/package-dsh.sh
./scripts/verify.sh
./scripts/package-dsh-codex.sh
./scripts/package-dsh-cline-pass.sh
node scripts/check-provider-components.mjs local
```

`package-dsh.sh` 内部已经执行 prepare、严格补丁和原生构建。只在排查预像时单独调用 `prepare-dsh.sh`，不把它再重复当作常规构建前置。Provider 打包内部执行共享 checkout 的 check。Cline Pass 打包默认读取 Mac 已安装的准确版本；需要先构建候选时，用 `DSH_CLINE_PASS_SOURCE` 指向审计过的解包目录。

Provider 代码更新时同步 `DSH_CODEX_VERSION`、`DSH_CODEX_PI_AI_VERSION`、`DSH_CODEX_PI_AI_INTEGRITY` 和 `DSH_CODEX_REQUIRED_MODELS`。打包器强制检查 manifest、pnpm lock 和编译产物中的版本及必需模型，不能只改版本文件。pi-ai 1.2.0 的图片目录使用统一 `Provider.getAllModels()` 并按 `type` 过滤；DSH 自带 pi-ai 与 Provider 的版本可不同，不能整体覆盖 DSH 的内部依赖。

## 保存双端基线

保持 iPhone USB 连接，2224 为 SSH、3081 为 Web 转发。为每次候选建立独立目录：

```bash
. ./versions.env
dsh_upgrade_run=".cache/upgrades/${DSH_DEBIAN_VERSION}-$(date +%Y%m%d-%H%M%S)"
node scripts/check-upgrade-host.mjs mac --save "$dsh_upgrade_run/mac-before.json"
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/check-upgrade-host.mjs iphone --save "$dsh_upgrade_run/iphone-before.json"
```

基线工具验证浏览器认证、HTTP RPC、WebSocket control、旧会话读取、运行状态与模型目录。只保存会话 ID 和默认模型等必要元数据，不保存会话正文、token 或 Cookie；文件权限为 0600，已有基线拒绝覆盖。它检查 `running` 的已知状态；队列、后台任务和待答问题仍按 SOP 在 Web 中确认，不能把 API 未提供的字段当成零。

若上游改变 Remote 协议、需要修改验收器，先用当前版本的验收器保存生产基线，再适配工具；保留旧报告，部署前重新确认空闲。基线无需等待所有构建完成，但一致性数据备份必须在服务停止后进行。

随后按 SOP 停止服务，备份 Mac/手机的 DSH home、Mac LaunchAgent、旧程序和可回滚 deb。**程序版本回滚与用户数据回滚是两件事**，格式已经迁移时不能只换回旧程序。

## 双端部署与验收

标准顺序为 Mac → iPhone：Mac 使用准确 npm 版本和安装归属的 pnpm 10；共享 `dsh-codex` 使用本地 link；iPhone 使用同一 checkout 生成的自包含离线 tarball。手机端安装完 Provider 和历史检查后再 bootstrap，不在部署结束后重复 kickstart。

部署完成后分别执行：

```bash
node scripts/check-upgrade-host.mjs mac --compare "$dsh_upgrade_run/mac-before.json"
node scripts/smoke-upgrade-host.mjs mac

DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/check-upgrade-host.mjs iphone --compare "$dsh_upgrade_run/iphone-before.json"
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/smoke-upgrade-host.mjs iphone
```

组件和指定模型必须单独验证。例如这次要求 GPT-6.1 Sol：

```bash
node scripts/check-provider-components.mjs mac
node scripts/check-provider-settings.mjs mac --save "$dsh_upgrade_run/mac-settings.json"
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/check-provider-components.mjs iphone
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/check-provider-settings.mjs iphone --save "$dsh_upgrade_run/iphone-settings.json"
node scripts/smoke-upgrade-host.mjs mac \
  --provider provider-codex --model gpt-6.1-sol --reasoning-effort low \
  --save "$dsh_upgrade_run/mac-gpt61.json"
DEVICE_HOST=127.0.0.1 DEVICE_PORT=2224 LOCAL_PORT=3081 \
  node scripts/smoke-upgrade-host.mjs iphone \
  --provider provider-codex --model gpt-6.1-sol --reasoning-effort low \
  --save "$dsh_upgrade_run/iphone-gpt61.json"
```

组件检查读取运行中插件的 `/plugins/dsh-openai-codex/components`，同时核对真实 Host 的模型选择目录。它区分“文件已安装”“进程仍加载旧版本”和“模型被隐藏/未登录”。指定模型验收还核对真实 `request/header` 中的 provider/model；只有目录出现新名称不算可用。DSH 的模型选择 API 会异步保存默认模型，验收器等待保存完成，并在结束或异常时恢复升级前默认值，再检查基线。

组件检查还要求持久化设置就绪。`check-provider-settings.mjs` 只在 Host 空闲时执行，按当前值实际保存 Codex/xAI 模型设置、图片工具和 Responses 开关，再重读并核对有效设置及默认模型未改变。Provider 的 Loader 回归测试同时覆盖存储服务延迟挂载、设置保存和重新加载后保留，不能用根 Context 里的直接调用测试替代真实插件依赖检查。

基线比较要求原会话全部仍存在，默认模型没有意外改变。真实验收器会新建一个有明确标题的 `/tmp` 测试会话，调用一次 Bash 打印随机标记并 `exit`，要求匹配的 `tool/result` 为成功、输出含标记、退出码 0、存在流式帧且 turn 完成。标记只出现在提示词、没有工具结果或工具报错，均判失败。

用户在升级期间主动改选默认模型时，保留原始基线，确认新值后单独记录该变更，再核对原会话与最终默认值；不能覆盖升级前文件，也不能擅自把用户的新选择恢复回去。

iPhone 的 Bash 没有 Workspace Write 沙箱后端；验收器只对自己新建的会话使用 Full access，结束 shell 后恢复原会话权限，并核对默认模型。用户既有会话不参与测试。若失败后测试 PTY 未关闭，命令会指出需要清理的唯一测试会话；不通过放宽权限门禁或重启整个服务清理它。

以下证据单独保留：

- Mac：CLI 版本、Provider 版本、额外插件、旧会话/默认模型、真实对话与 Bash。
- iPhone：Debian/CLI/pnpm 版本、builtin/flock/PTY 原生加载、图片、旧会话、Safari 设置入口、通知和本次受影响的 Live Activity 行为。
- 完成通知、图片、登录/出口与视觉交互按本次变化实测；CLI 验收器不替代这些检查。
- 日志只检查当前 boot 的错误并隐藏 token，避免把整份带认证 URL 的日志复制到报告。

## 中断恢复与提交

| 当前状态 | 后续动作 |
| --- | --- |
| 本地预像/类型检查失败 | 留在审计阶段，修复后重建；生产服务继续原版 |
| Mac 通过、手机断线 | 保留产物 SHA 和基线，标记 iPhone 待部署；连接恢复后检查空闲并继续手机阶段 |
| 手机包已安装但启动失败 | 保留当前日志与数据；修正程序、递增 revision、重建验证后再装 |
| 会话或默认模型基线不符 | 先核对迁移和用户期间新增/修改；不能直接报告完成 |
| 两端均通过 | 更新记录，先推送共享 Provider，再推送 dsh-iphone |

一次升级记录至少包含：目标版本/commit/integrity/cutoff、Provider 和 native pins、产物 SHA、双端备份路径、基线比较、真实工具结果、受影响功能验证及两个提交。只 stage 已审查的相关文件；保留其他任务的草稿和修改。记录双端分别完成的状态，手机仍待连接时不把整体标记为完成。

后续可直接使用任务指令：**“检查 DSH 和 Provider 组件的 latest 及模型目录；有更新则按双端 SOP 适配、构建、备份、部署和验收指定模型，完成后提交推送。”**
