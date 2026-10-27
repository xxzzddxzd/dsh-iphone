# iOS 系统通知与 Live Activity

DSH Web profile 在 rootless iOS 上内置 `ios-notifier` Host 插件。它不启动 TUN、不改变网络出口，也不依赖 Shadowrocket；通知发布和 Live Activity 都只发生在手机本机。

## 与官方 DSH 0.2.1 的边界

本项目是官方 `dsh-v0.2.1-rc.2` 的 iOS 适配层，不要求 DSH 反向兼容本项目。当前活动栏版本为 Debian `0.2.1~rc.2-2` 与 Whaleness `1.7.11 / build 37`，实际安装和实机结果见[更新记录](./updating.md)。

- `upstream/deepseek-harness` 子模块固定在官方 0.2.1 提交，构建和验证都要求子模块工作区干净。
- 授权仍由官方 `approval/request` waterfall 和官方 Web 组件处理。通知插件只观察持久化的 `approval/asked` / `approval/decided` 会话事件，不接管应答者位置。
- 浏览器事件流使用经过浏览器会话认证的 `/api/remote.mux` 和 `$events` 逻辑流。iOS 插件不建立第二条私有浏览器连接，也不改写该协议。
- iOS 打包阶段只在生成的运行时副本中加入插件及加载项；`scripts/patch-dsh.mjs` 对准确版本和每个官方预像做精确校验，未知版本直接停止构建。

## 通知覆盖范围

默认发送以下通知：

| 情况 | 事件 | 通知内容与操作 |
| --- | --- | --- |
| 等待工具授权 | `approval/asked` | “会话标题 · 请求确认”和实际指令；点击后在官方会话界面处理 |
| 普通回复完成 | 根会话 `turn/end completed` | 会话标题、完成状态、最后一条 assistant 可见文本摘要 |
| 显式目标完成 | `goal/changed complete` | 会话标题和目标内容 |
| 显式目标阻塞 | `goal/changed block` | 会话标题、目标和阻塞原因 |
| 本轮阻塞 | 根会话 `turn/end blocked` | 会话标题、阻塞状态和最后可见说明 |
| 等待用户回答 | `ask_user_question` | 会话标题和第一个问题 |
| 等待计划确认 | `exit_plan_mode` | 会话标题和计划摘要 |
| 运行失败 | `turn/end error` | 会话标题、错误代码和错误消息 |
| 输出超限 | `turn/end max-tokens` | 会话标题、截断说明和最后可见内容 |
| 异常中断 | `turn/end interrupted` | 会话标题和恢复时发现的中断说明 |
| 系统钩子停止 | `turn/end aborted` + `hook` | 会话标题和停止原因 |

用户主动取消、父代取消子代理、正常服务关闭不发通知。根会话的终止状态才发通用通知，避免多个 subagent 完成时刷屏；subagent 内真正需要用户处理的问题、计划和显式 goal 通知仍保留。

普通通知摘要只提取 assistant 最终可见的 `text` 块，不提取 reasoning、工具参数、API key、VLESS 凭据或设置。等待工具审批时是一个有意的例外：标题为“会话标题 · 请求确认”，正文按 `callId` 找到对应工具调用并显示 `指令：<command>`，让用户进入会话前看到实际命令；无法取得命令时只显示工具名，不再重复泛化的审批原因。正文仍受 `maxBodyChars` 限制，点击 URL 只包含 session 标识。若锁屏上不应显示命令，应在 iOS 通知设置中关闭锁屏预览。

显式 goal 的完成或阻塞先缓存到当前 turn，等 `turn/end` 后再发送。同一 turn 只发一条结果通知；如果 turn 最终为错误、超限或中断，优先报告真实终止原因。

## 授权处理

点击授权通知会打开对应 session，由当前会话界面的官方审批协议返回 `allowed-once` 或 `rejected`。系统通知不直接提交授权结果，因而不会与 Mac 或另一个客户端争用 waterfall 中唯一的决定位置。用户问答和计划确认同样在会话界面完成。

## Live Activity

根会话开始一个 turn 时，插件创建或更新一条 Live Activity，显示：

- 会话标题和当前阶段；
- 圆环中从本轮开始时间连续刷新的执行时长；圆点只表示此刻状态为 `running` 的根代理和 subagent，子代理回到 `idle` 后立即减少，终态卡不保留历史圆点；
- `GOAL` 区块只在根会话存在 `active` 目标时显示目标内容，目标暂停、阻塞、完成或清除后立即隐藏；
- `进展` 区块优先展示最近一条有效的 ASSISTANT 文本；尚无模型文本时才回退到 Think 摘要、搜索/工具动作或计划进度。待用户处理的问题以及阻塞、失败等终态原因仍具有更高优先级；无目标时最多显示四行，有目标时最多显示三行；
- `TOOL` 区块只显示最近一次工具的类型与状态（运行中、已完成、执行失败或等待授权），并区分网络搜索、网页读取、文件搜索、内容搜索等类型，不再重复 `进展` 的动作正文；
- 等待回答、计划确认或操作授权时使用醒目的等待状态和“打开处理”入口。

插件通过当前 DSH 的 `Session.snapshotEvents()` 读取事件快照，并使用 `inheritedEventCount` 区分子会话继承的事件；旧的 `session.events` 和 `header.seedLength` 已不再使用。回归检查包含真实发布包 Session 的开始、结束和通知摘要，防止仅用旧版测试对象掩盖接口变化。

三个内容区使用同一组左右两列：左列固定显示 `GOAL`、`PROG`、`TOOL`，右列显示内容，进展可占三至四行。三个标签使用同一套圆角字体、字号与列宽；单行的目标和工具内容保持垂直居中。进展正文会去掉 Markdown 的标题、引用、代码围栏和链接地址，将列表转换为项目符号，并由原生 `AttributedString` 渲染粗体、删除线和行内代码；解析失败时回退为去除常见标记的纯文本。

卡片向 `activityBackgroundTint` 传入 `nil`，并在内容层铺设不透明的 UIKit `systemBackground`：浅色模式使用白色背景，暗色模式使用黑色背景，同时避免锁屏壁纸透过系统材质降低对比度。标题、计时与三个内容区使用高对比度系统主文字色，左上鲸鱼以模板图配合系统主文字色渲染，因此浅色为黑色、暗色为白色；操作按钮、圆环和各状态色继续使用系统语义色，切换外观时不需要重建或重新配置 Live Activity。

`assistant/chunk` 不会用“模型正在输出”覆盖正文；Codex 流中完整的 `**Think 标题**` 会实时更新，普通 token 片段继续忽略，以免高频刷新原生 Activity。完整且非空的 `assistant/message` 会保存为最近一条有效模型文本；随后出现搜索或其他工具动作时，`PROG` 继续显示这条 ASSISTANT 文本，`TOOL` 单独切换工具状态。只有尚无 ASSISTANT 文本时，搜索或工具动作才进入 `PROG`。等待回答、计划确认、操作授权以及阻塞或失败原因不会被旧 ASSISTANT 文本覆盖。顶部状态同步显示“正在执行 Bash”“等待操作授权”“正在思考”等真实阶段，不显示内部的轮次和步数计数。

同时有多个任务时，只展示最后开始且仍在运行的根任务。该任务结束后，如果较早任务仍在运行，会自动回退展示它。插件监听 DSH 权威的 `agent/status`：subagent 进入 `running` 时增加圆点，回到 `idle` 时立即移除；另外，若根 agent 异常中断且没有写入 `turn/end`，回到 `idle` 时会移除这条未完成任务，避免它继续计时或在较新任务结束后重新占位。已有完整终态的卡片不受影响。全部任务结束后，最后一张卡片冻结执行时长，保留最终结果和“查看结果”入口；用户可自行划掉，开始下一项根任务时 broker 会结束旧 Activity 并创建新卡。用户主动取消的 turn 不保留终态卡。subagent 不单独抢占这张卡片。

系统通知与 Live Activity 并行发送，终态卡不会替代完成、阻塞或失败通知。手机当前为 iOS 16.1，Live Activity 本身不支持真正的交互按钮，因此卡片中的“打开处理”/“查看结果”是点击提示，点击整张 Live Activity 会打开对应 DSH session。

Live Activity 请求进入独立的 launchd broker `DSHActivityD`（`UserName=mobile`，UID 501）。broker 本身不加载 ActivityKit，而是为每次 create、update 或 end 启动固定名称、带最小私有权限的短命原生 helper `DSHActivityOp`。helper 调用 iOS 16.1.1 的私有 ActivityKit input XPC 接口，显式指定 platter target 并校验返回 descriptor 的 UUID 与目标身份。请求不由前台 App 创建，也不依赖 App 保活或 APNs。若 broker、helper、私有接口或服务端不可用，操作会返回错误，不会退回前台启动 App。

### 原生 App 承载与目标选择

Whaleness build 37 在现有 `AgentLiveActivityWidget.appex` 中增加 `DSHRootActivityWidget`，复用原活动栏的 `DSHActivityAttributes` 与视图。它与上游远端主机的 `AgentActivityAttributes` 配置并存；本机 App 继续跳过重复 Activity 创建。状态与生命周期仍由原后台链负责，只有 Widget 所属的 containing App 目标改变。

安装器在最终 manifest 声明 `root-live-activity-widget-v1`、准确 App/Widget 已安装且均通过签名和版本检查后，原子发布支持记录：

| 路径 | 所有者与权限 | 内容 |
| --- | --- | --- |
| `/var/root/.dsh/native-client/activity-widget.json` | root `0600` | 私有安装记录 |
| `/var/mobile/Library/DSHNotifier/native-client/activity-widget.json` | root `0644`；父 `native-client` 目录 root `0755` | 相同的非敏感元数据镜像，供 mobile broker 只读 |

两份记录都只含 `schema:1`、`managedBy:dsh-iphone/native-client`、`bundleId:com.clark.dshmobile.dev`、准确版本/build/安装路径、`attributesType:DSHActivityAttributes` 与 `widgetKind:DSHRootActivityWidget`，不含 Keychain、token 或消息。不要把 broker 改为 root 或放松 root 私有目录权限。发布器拒绝符号链接及外来标记；安装不支持版本或校验失败时，只移除本工具生成的旧记录，保留真实配对、凭据和映射。

broker 从镜像核对 root 所有权、禁止 group/world 写、schema/身份及当前安装的 App/Widget 精确版本。随后还要检查卡片的 `launchURL`：它必须来自已配对且激活的本机 profile，指向 `dshmobile://session`，且 session 与卡片任务一致。两类条件同时满足才选择 `com.clark.dshmobile.dev`；不满足时使用旧 `ai.deepseek.dsh` 独立 Widget，并在诊断中明确实际目标。

选定原生目标后的 create/update/end 失败必须报告，不能静默改用旧目标。Activity UUID 与创建时的 target 绑定；target 改变时先结束旧卡，再为新目标创建新 UUID。结束旧卡失败时不继续创建，避免双卡；`activity.id`、`activity.target` 和任务身份一起恢复，不能把旧 UUID 直接改绑给原生 App。

不能让 SpringBoard 自己成为 ActivityKit XPC 的请求者：SessionKit 会无条件把真实请求进程加入 content source；Activity 结束时会回收该请求进程，实机上表现为 SpringBoard 被重启。由 SpringBoard 直接 `posix_spawn` helper 也不安全，因为 helper 会继承 SpringBoard 的 RunningBoard 责任链。独立 launchd broker 把这条责任链完全隔离；end 后 broker 可能保持运行，也可能被系统回收并由 launchd 自动重启，但 SpringBoard、sessionkitd 和通知 bridge 均不受影响。

## 点击行为

普通点击先移除该条 Bulletin，再由后台桥验证本机网关和 App 的真实非敏感 profile 映射。存在已配对且激活的本机 profile 时，优先打开原生根会话：

```text
dshmobile://session?gateway=<App-profile-id>&id=<root-session-id>
```

服务器 `gatewayId` 与 App `profile.id` 不同，UUID 大小写也必须保留；子会话事件归到根会话入口。没有有效原生映射时，在后台通过 `uiopen` 使用 Web 回退：

```text
http://127.0.0.1:3080/?session=session-…
```

compatibility 入口会在 DSH module graph 启动前把目标写入 `dsh.sessions.current`，随后从地址栏移除一次性参数，按官方恢复路径打开 session。Web subagent 地址还携带 `parent` 与 `mode`，因此可以恢复直接父地址后选择子会话。原生目标的 Activity 必须携带匹配任务的原生 session 地址，不能创建后再靠网页回退掩盖错误映射。

此地址只适用于 iPhone 本机，因为 DSH 服务监听 `127.0.0.1:3080`。Mac 通过 SSH 转发访问的端口与通知点击无关。

## 安装结构

DSH deb 声明以下原生依赖：

```text
net.limneos.libbulletin
ellekit
uikittools
```

主要组件如下：

| 路径 | 用途 |
| --- | --- |
| `/var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs` | 0.2.1 Host 插件、任务状态与官方授权协议适配 |
| `/var/jb/usr/local/bin/dsh-notify` | 通知发布、撤回 helper |
| `/var/jb/usr/local/bin/dsh-activity` | Live Activity 调试 helper |
| `/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib` | SpringBoard Bulletin 发布与点击 bridge；不包含 ActivityKit |
| `/var/jb/usr/local/lib/dsh/ios/DSHActivityD` | launchd 常驻的 Live Activity socket broker |
| `/var/jb/usr/local/lib/dsh/ios/DSHActivityOp` | 实际调用私有 ActivityKit XPC 的短命原生 helper |
| `/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-activity.plist` | broker 的独立 launchd job |
| `/var/jb/Applications/DSH.app` | 旧目标的隐藏 Bundle/widget 容器；条件不足时使用 |
| 已安装 Whaleness 的 `PlugIns/AgentLiveActivityWidget.appex` | 原生目标的 `DSHRootActivityWidget` 与上游远端 Widget 配置 |
| `/var/mobile/Library/DSHNotifier/native-client/activity-widget.json` | root 发布的安装能力只读镜像 |
| `/var/mobile/Library/DSHNotifier/notify.sock` | 通知请求 socket |
| `/var/mobile/Library/DSHNotifier/activity.sock` | Live Activity 更新 socket |
| `/var/mobile/Library/DSHNotifier/activity.id` | 当前 Activity UUID，用于 respring 后继续更新或结束 |
| `/var/mobile/Library/DSHNotifier/activity.target` | 当前 UUID 创建时的 containing App bundle ID |
| `/var/mobile/Library/DSHNotifier/activity.finished` | 当前卡片是否为保留终态；下一项任务据此强制换新 Activity UUID |

旧 `DSH.app` 带有 `SBAppTags = hidden`，只提供旧 Bundle 身份、图标和 Widget。其最小 `DSHActivityHost` 不包含 ActivityKit、不监听 socket、不创建窗口，完成 UIKit check-in 后退出。原生目标则使用正常容器和 Keychain 的 Whaleness；不能把旧壳的 entitlement 或退出策略套给它。系统在 Activity 结束时可能唤醒 containing App，必须对新目标重新验证生命周期，不能沿用旧目标的实测结论。

`.mjs` helper 固定使用 Node 22。DSH 受管 subprocess 先启动已签名的 rootless Bash，再连接本机 socket；SpringBoard 的点击处理在后台执行，避免阻塞主线程。首次安装或升级原生桥后需要 respring 一次，使 ElleKit 把新版 dylib 注入 SpringBoard。

## 配置与开关

当前插件设置页可以呈现浏览器侧插件注册的设置卡片，但 iOS 通知插件只有 Host 侧，因此暂时没有 Web 表单。通知开关仍由 Web profile 的 Cordis patch 控制；修改 `$DSH_HOME/cordis.patch.yml` 后，DSH 配置 watcher 会热重载。

关闭全部通知和 Live Activity：

```yaml
- id: ios-notifier
  disabled: true
```

保留插件并选择功能：

```yaml
- id: ios-notifier
  config:
    enabled: true
    notifyComplete: true
    notifyBlocked: true
    notifyConfirm: true
    notifyFailure: true
    liveActivity: true
    browserBaseUrl: http://127.0.0.1:3080/
    bundleId: ai.deepseek.dsh
    completeTitle: DSH 回复已完成
    blockedTitle: DSH 会话被阻塞
    confirmTitle: DSH 等待确认
    errorTitle: DSH 运行失败
    maxTokensTitle: DSH 输出已截断
    interruptedTitle: DSH 会话异常中断
    stoppedTitle: DSH 会话已停止
    maxBodyChars: 800
    logSuccess: true
```

patch 会替换整份 `config`，但以上字段都有 schema 默认值，可以只写需要改变的字段。`soundId` 可设为 iOS system sound 的安全整数；省略时不主动指定声音。

## 单独测试

普通点击通知：

```bash
/var/jb/usr/local/bin/dsh-notify \
  --url 'http://127.0.0.1:3080/?session=session-…' \
  'DSH 点击测试' \
  '点击后应打开对应会话'
```

Live Activity 状态：

```bash
/var/jb/usr/local/bin/dsh-activity status
/var/jb/usr/local/bin/dsh-activity inspect
```

通知发送成功或失败会按 `ios-notifier` 记录：

```bash
grep 'ios-notifier' /var/root/dsh.log
```

`notify.sock` 由 SpringBoard bridge 监听，注入桥确实更新时才统一 respring。`activity.sock` 由 launchd job `ai.deepseek.dsh-activity` 监听，不依赖 SpringBoard；缺失时检查该 job 或重新安装包。`DSHActivityOp` 只在一次 Activity 操作期间短暂存在，不主动前台启动 App。若 `activity.id` 存在，broker 会恢复该 UUID 及 target；终态卡保留时文件继续存在，下一项任务或 target 变化会换新 UUID。如果浏览器打开 DSH 但没有选中会话，确认 session 仍存在于 `/var/root/.dsh/sessions`。

## 活动栏迁移检查流程

1. 对照最终 IPA manifest，检查已安装主 App、Widget 的 bundle ID、版本/build、最低系统和签名；确认 `DSHRootActivityWidget` 配置与 `DSHActivityAttributes` 一起进入实际归档。LaunchServices 登记到扩展仅证明注册阶段，不能当作渲染成功。
2. 核对两份支持记录内容一致、root 私有记录为 `0600`、mobile 镜像为 root `0644`，镜像父目录为 root `0755`。确认真实本机配对和当前激活 profile，再刷新非敏感映射，不读取或重写 Keychain。
3. 在现有后台创建独立测试会话，通过 `dsh-activity inspect` 记录 `preferredTargetBundleId`、`targetBundleId`、`activityId` 和 `task`。前者只表示安装能力选择；实际 target 还依赖本次任务的原生 session 地址。检查旧目标已 end、新目标得到新 UUID，不能以 `status active` 代替目标检查。
4. 检查 ActivityKit/sessionkitd 与 chronod 的本次日志、扩展实际加载或渲染证据，并在通知中心和锁屏确认卡片可见。XPC 返回 descriptor/UUID 只证明系统接受请求；即使该步成功，扩展仍可能没有被 chronod 选中。没有卡片时保留失败状态和诊断证据，不能宣称迁移完成或静默切回旧目标。
5. 分别实测运行中更新、等待处理、终态冻结、下一根任务换卡、用户划除后的同任务行为，以及 App 在前台、退出和锁屏时的更新。检查 create/update/end 不造成异常前台启动或系统进程重启，原生点击进入准确根会话，无重复卡片。
6. 清理本次测试 Activity 与会话，核对用户原配对、历史、默认模型和网页入口保持可用；把安装、调用、实际显示和用户交互的结果分项写入更新记录。只有受影响项均有证据才结束验收。
