# iOS 系统通知、授权动作与 Live Activity

DSH Web profile 在 rootless iOS 上内置 `ios-notifier` Host 插件。它不启动 TUN、不改变网络出口，也不依赖 Shadowrocket；通知发布和 Live Activity 都只发生在手机本机。

## 与官方 DSH rc.7 的边界

本项目是官方 `dsh-v0.1.0-rc.7` 的 iOS 适配层，不要求 DSH 反向兼容本项目：

- `upstream/deepseek-harness` 子模块固定在官方 rc.7 提交，构建和验证都要求子模块工作区干净。
- 授权监听使用 rc.7 浏览器载体的官方下行 WebSocket `/api/events.mux`。普通 HTTP GET 在 rc.7 中返回 426，没有 SSE 回退。
- 用户在通知上作答后，插件按官方 `client-response` 格式 POST `/api/respond`，回填 `approval/requested` 帧原有的稳定 `rpcId`。
- 插件只消费 `approval/requested` / `approval/resolved` 公共事件，不修改 DSH 的授权服务、pending 表或客户端运行时。
- iOS 打包阶段只在生成的运行时副本中加入插件及加载项；`scripts/patch-dsh.mjs` 对 rc.7 版本和每个官方预像做精确校验，未知版本直接停止构建。

## 通知覆盖范围

默认发送以下通知：

| 情况 | 事件 | 通知内容与操作 |
| --- | --- | --- |
| 等待工具授权 | 官方 mux `approval/requested` | 会话、工具、原因，以及“拒绝”/“允许一次”按钮 |
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

通知摘要只提取 assistant 最终可见的 `text` 块，不提取 reasoning、工具参数、API key、VLESS 凭据或设置。正文受 `maxBodyChars` 限制，点击 URL 只包含 session 标识。

显式 goal 的完成或阻塞先缓存到当前 turn，等 `turn/end` 后再发送。同一 turn 只发一条结果通知；如果 turn 最终为错误、超限或中断，优先报告真实终止原因。

## 通知上的一次性授权

授权通知需要长按或下拉展开，显示两个动作：

- `拒绝`：向 rc.7 返回 `rejected`。
- `允许一次`：需要先通过设备解锁认证，再向 rc.7 返回 `allowed-once`。

每个按钮只携带独立生成的 24 字节随机令牌；session、approval id、rpcId 和结果只保存在 DSH 进程内，SpringBoard 不能用令牌自行选择其他结果。令牌只能使用一次、两小时后失效，重复、过期或未知令牌都 fail-closed。动作回调只通过权限为 `0600` 的本机 Unix socket `action.sock` 进入 DSH。

收到官方 `approval/resolved`、按钮作答成功或令牌过期时，插件都会撤回对应通知。通知按钮不能代替其他交互：`ask_user_question` 和计划确认仍需点击通知进入会话完成。

## Live Activity

根会话开始一个 turn 时，插件创建或更新一条 Live Activity，显示：

- 会话标题和当前阶段；
- 圆环中从本轮开始时间连续刷新的执行时长，圆环上的点表示根任务及已启动的 subagent 数量；
- `ASSISTANT` 区块保留最近一条有效的 assistant 可见文本；
- `TOOL` 区块独立显示最近一次工具调用、执行结果或待授权动作；
- 等待回答、计划确认或操作授权时使用醒目的等待状态。

`assistant/chunk` 的 token 流不会用“模型正在输出”覆盖正文；只有完整且非空的 `assistant/message` 才更新 `ASSISTANT` 区块。因此模型输出或工具运行期间，上一条有用信息会一直保留。

同时有多个任务时，只展示最后开始且仍在运行的根任务。该任务结束后，如果较早任务仍在运行，会自动回退展示它；全部结束后立即关闭 Live Activity。subagent 不单独抢占这张卡片。

手机当前为 iOS 16.1，Live Activity 本身不支持交互按钮，因此授权按钮放在系统授权通知上；点击 Live Activity 则打开它所对应的 DSH session。

Live Activity 请求进入独立的 launchd broker `DSHActivityD`。broker 本身不加载 ActivityKit，而是为每次 create、update 或 end 启动固定名称、带最小私有权限的短命原生 helper `DSHActivityOp`。helper 调用 iOS 16.1.1 的私有 ActivityKit input XPC 接口，并用 `custom-platter-target` 把 platter target 明确设为 `ai.deepseek.dsh`。因此不需要用户启动或首次手动打开 DSH App，也不会用前台 App 创建 Activity。若 broker、helper、私有接口或服务端不可用，操作会返回错误，不会退回前台启动 App。

不能让 SpringBoard 自己成为 ActivityKit XPC 的请求者：SessionKit 会无条件把真实请求进程加入 content source；Activity 结束时会回收该请求进程，实机上表现为 SpringBoard 被重启。由 SpringBoard 直接 `posix_spawn` helper 也不安全，因为 helper 会继承 SpringBoard 的 RunningBoard 责任链。独立 launchd broker 把这条责任链完全隔离；end 后 broker 可能保持运行，也可能被系统回收并由 launchd 自动重启，但 SpringBoard、sessionkitd 和通知 bridge 均不受影响。

## 点击行为

普通点击会先移除该条 Bulletin，再在后台调用 `uiopen`，把下面的地址交给默认浏览器：

```text
http://127.0.0.1:3080/?session=session-…
```

compatibility 入口会在 DSH module graph 启动前把目标写入 `dsh.sessions.current`，随后从地址栏移除一次性参数，最终按 rc.7 正常恢复路径打开 session。subagent 通知还携带 `parent` 与 `mode`，因此可以恢复直接父地址后选择子会话。

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
| `/var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs` | rc.7 Host 插件、任务状态与官方授权协议适配 |
| `/var/jb/usr/local/bin/dsh-notify` | 通知发布、撤回 helper |
| `/var/jb/usr/local/bin/dsh-activity` | Live Activity 调试 helper |
| `/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib` | SpringBoard Bulletin 与通知动作 bridge；不包含 ActivityKit |
| `/var/jb/usr/local/lib/dsh/ios/DSHActivityD` | launchd 常驻的 Live Activity socket broker |
| `/var/jb/usr/local/lib/dsh/ios/DSHActivityOp` | 实际调用私有 ActivityKit XPC 的短命原生 helper |
| `/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-activity.plist` | broker 的独立 launchd job |
| `/var/jb/Applications/DSH.app` | 隐藏的 Bundle/widget 容器；不需要启动 |
| `/var/mobile/Library/DSHNotifier/notify.sock` | 通知请求 socket |
| `/var/mobile/Library/DSHNotifier/action.sock` | 一次性动作回调 socket |
| `/var/mobile/Library/DSHNotifier/activity.sock` | Live Activity 更新 socket |
| `/var/mobile/Library/DSHNotifier/activity.id` | 当前 Activity UUID，用于 respring 后继续更新或结束 |

`DSH.app` 带有 `SBAppTags = hidden`，不会显示在主屏幕；它只提供 DSH Bundle 身份、黑鲸鱼图标和 ActivityKit 所需的 widget extension。创建动作由 launchd broker 调度，实际请求方是 `DSHActivityOp`；返回 descriptor 中的 platter target 是 `ai.deepseek.dsh`，所以系统仍选择该 Bundle 的 widget 渲染界面。分阶段实测确认 create 和 update 不启动容器 App；end 时 iOS 会短暂唤醒 containing App。`DSHActivityHost` 因此是一个不包含 ActivityKit、不监听 socket、不创建窗口的最小壳，完成 UIKit check-in 后立即正常退出，不需要用户操作，也不会与 broker 竞争。

`.mjs` helper 固定使用 Node 22。DSH 受管 subprocess 先启动已签名的 rootless Bash，再连接本机 socket；SpringBoard 的点击处理和动作回调都在后台执行，避免阻塞主线程。首次安装或升级原生桥后需要 respring 一次，使 ElleKit 把新版 dylib 注入 SpringBoard。

## 配置与开关

rc.7 的插件设置页可以呈现浏览器侧插件注册的设置卡片，但当前 iOS 通知插件只有 Host 侧，因此暂时没有 Web 表单。通知开关仍由 Web profile 的 Cordis patch 控制；修改 `$DSH_HOME/cordis.patch.yml` 后，DSH 配置 watcher 会热重载。

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
    actionableApprovals: true
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
```

DSH 启动后应记录成功连接官方授权 mux；通知发送成功或失败也会按 `ios-notifier` 记录：

```bash
grep 'ios-notifier' /var/root/dsh.log
```

`notify.sock` 由 SpringBoard bridge 监听，安装原生 bridge 后需要 respring。`activity.sock` 由 launchd job `ai.deepseek.dsh-activity` 监听，不依赖 SpringBoard；缺失时检查该 job 或重新安装包。`DSHActivityOp` 只在一次 Activity 操作期间短暂存在，不会拉起 App。若 `activity.id` 存在，broker 会在自身重启后恢复该 UUID；任务全部结束时会立即结束 Activity 并删除此文件。如果浏览器打开 DSH 但没有选中会话，确认 session 仍存在于 `/var/root/.dsh/sessions`。
