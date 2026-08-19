# iOS 系统通知与 session 深链接

DSH Web profile 在 rootless iOS 上内置 `ios-notifier` Host 插件。它不启动 TUN、不改变任何网络出口，也不依赖 Shadowrocket；通知发布只发生在本机 SpringBoard。

## 覆盖范围

默认发送以下通知：

| 情况 | 事件 | 通知内容 |
| --- | --- | --- |
| 普通回复完成 | 根会话 `turn/end completed` | 会话标题、完成状态、最后一条 assistant 可见文本摘要 |
| 显式目标完成 | `goal/changed complete` | 会话标题和目标内容 |
| 显式目标阻塞 | `goal/changed block` | 会话标题、目标和阻塞原因 |
| 本轮阻塞 | 根会话 `turn/end blocked` | 会话标题、阻塞状态和最后可见说明 |
| 等待工具授权 | `approval/asked` | 会话标题、工具名和授权原因 |
| 等待用户回答 | `ask_user_question` | 会话标题和第一个问题 |
| 等待计划确认 | `exit_plan_mode` | 会话标题和计划摘要 |
| 运行失败 | `turn/end error` | 会话标题、错误代码和错误消息 |
| 输出超限 | `turn/end max-tokens` | 会话标题、截断说明和最后可见内容 |
| 异常中断 | `turn/end interrupted` | 会话标题和恢复时发现的中断说明 |
| 系统钩子停止 | `turn/end aborted` + `hook` | 会话标题和停止原因 |

用户主动取消、父代取消子代理、正常服务关闭不发通知。根会话的终止状态才发通用通知，避免多个 subagent 完成时刷屏；subagent 内真正需要用户处理的授权、问题、计划和显式 goal 通知仍保留。

通知中的回复摘要只提取 assistant 最终可见的 `text` 块，不提取 reasoning、工具参数、API key、VLESS 凭据或设置。正文受 `maxBodyChars` 限制。通知 URL 只包含 session 标识。

显式 goal 的完成或阻塞先缓存到当前 turn，等 `turn/end` 后再发送。同一 turn 只发一条结果通知；如果 turn 最终为错误、超限或中断，优先报告真实终止原因。

## 点击行为

`dsh-notify` 把请求写入仅限本机 root/mobile 使用的 Unix socket。`DSHNotifierBridge.dylib` 在 SpringBoard 内先创建 `BBAction` URL 默认动作，再通过通知控制器自己的队列发布可清除 Bulletin。点击时桥接用 `observer:removeBulletin:` 撤回该条通知，立即结束 BulletinBoard 响应，并在后台用 `uiopen` 把地址交给默认浏览器。这样既不会进入会卡住约十秒的原始 action 路径，也不会让已点击通知留在通知中心。地址默认形如：

```text
http://127.0.0.1:3080/?session=session-…
```

系统把 HTTP(S) 地址交给 iOS 默认浏览器。compatibility 5 入口在 DSH module graph 启动前把选择写入 `dsh.sessions.current`，再从地址栏移除一次性参数；DSH 随后按正常恢复路径打开该 session。subagent 通知还携带 `parent` 与 `mode`，因此可以恢复直接父地址后选择子会话。

此地址只适用于 iPhone 本机，因为 DSH 服务监听 `127.0.0.1:3080`。Mac 通过 SSH 转发访问的 `3082` 与通知点击无关。

## 安装依赖

DSH deb 声明以下额外依赖：

```text
net.limneos.libbulletin
ellekit
uikittools
```

安装包把插件放在 `/var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs`，把 helper 模块放在 `/var/jb/usr/local/lib/dsh/ios/dsh-notify.mjs`，并提供 `/var/jb/usr/local/bin/dsh-notify` 软链接。SpringBoard 桥安装在 `/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib`，同时包含 arm64 与 arm64e slice；请求 socket 是 `/var/mobile/Library/DSHNotifier/notify.sock`。

`/var/jb/Applications/DSH.app` 是一个不显示在主屏幕、也不处理点击的图标宿主。安装脚本用 `uicache` 注册它，通知的 `ai.deepseek.dsh` section 因而显示 DSH 官方黑鲸鱼图标；实际点击仍由桥接打开浏览器。

`.mjs` 入口固定使用 Node 22；helper 由 DSH 的受管 subprocess 先启动已签名的 rootless Bash，再连接本机 socket。Node 从 DSH 进程直接启动脚本在该设备上会被 `posix_spawn` 拒绝。点击动作由桥接截获后在后台调用 `uiopen`，交给默认浏览器处理，避免阻塞 SpringBoard 主线程。首次安装或升级桥之后需要 respring 一次，使 ElleKit 把新版 dylib 注入 SpringBoard。

## 配置与开关

rc.7 的插件设置页可以呈现由浏览器侧插件注册的设置卡片，但当前 iOS 通知插件只有 Host 侧，因此不会自动获得 Web 表单。通知开关仍由 Web profile 的 Cordis patch 控制；修改 `$DSH_HOME/cordis.patch.yml` 后，DSH 的配置 watcher 会热重载该行。关闭全部通知：

```yaml
- id: ios-notifier
  disabled: true
```

保留插件但选择通知种类：

```yaml
- id: ios-notifier
  config:
    enabled: true
    notifyComplete: true
    notifyBlocked: true
    notifyConfirm: false
    notifyFailure: true
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

patch 会替换整份 `config`，但以上各字段都有 schema 默认值，因此可以只写需要改变的字段。`soundId` 可设为 iOS system sound 的安全整数；省略时不主动指定声音。

## 单独测试

先确认 DSH 页面在手机本机可访问，再发送一条带 session 的测试通知：

```bash
/var/jb/usr/local/bin/dsh-notify \
  --url 'http://127.0.0.1:3080/?session=session-…' \
  'DSH 点击测试' \
  '点击后应打开对应会话'
```

helper 收到桥的 `OK queued` 回执后会输出 `notification sent`。Host 插件的发送成功或失败写入 `/var/root/dsh.log`，可按 `ios-notifier` 过滤：

```bash
grep 'ios-notifier' /var/root/dsh.log
```

如果 helper 报 `ENOENT` 或 `ECONNREFUSED`，确认 socket 存在；不存在时 respring，并检查最新 SpringBoard crash log：

```bash
ls -l /var/mobile/Library/DSHNotifier/notify.sock
```

如果通知能显示但点击仍打开 Settings，说明运行的仍是旧 Libbulletin 事后改 action 方案；重新安装当前 DSH 包并 respring。如果浏览器打开 DSH 但没有选中会话，确认入口是 compatibility 5，且 session 仍存在于 `/var/root/.dsh/sessions`。
