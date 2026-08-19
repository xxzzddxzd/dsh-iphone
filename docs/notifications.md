# iOS 系统通知与 session 深链接

DSH Web profile 在 rootless iOS 上内置 `ios-notifier` Host 插件。它不启动 TUN、不改变任何网络出口，也不依赖 Shadowrocket；通知发布只发生在本机 SpringBoard。

## 覆盖范围

默认发送以下通知：

- `goal/changed complete`：目标已完成。
- `goal/changed block`：目标被阻塞，并附带阻塞原因。
- `approval/asked`：工具权限正在等待确认。
- `ask_user_question`：会话正在等待回答。
- `exit_plan_mode`：计划正在等待确认。

通知正文只包含目标、阻塞原因或确认提示。通知 URL 只包含 session 标识；不会放入 API key、VLESS 凭据、设置或完整对话内容。

## 点击行为

`dsh-notify` 把请求写入仅限本机 root/mobile 使用的 Unix socket。`DSHNotifierBridge.dylib` 在 SpringBoard 内先创建 `BBAction` URL 默认动作，再通过通知控制器自己的队列发布 Bulletin。点击时桥接立即结束 BulletinBoard 响应，并在后台用 `uiopen` 把地址交给默认浏览器，避免 SpringBoard 主线程等待。地址默认形如：

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

当前 rc.6 的 Plugins Inventory 页面只读。通知开关由 Web profile 的 Cordis patch 控制；修改 `$DSH_HOME/cordis.patch.yml` 后，DSH 的配置 watcher 会热重载该行。关闭全部通知：

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
    browserBaseUrl: http://127.0.0.1:3080/
    bundleId: ai.deepseek.dsh
    completeTitle: DSH 目标已完成
    blockedTitle: DSH 目标被阻塞
    confirmTitle: DSH 等待确认
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

如果通知能显示但点击仍打开 Settings，说明运行的仍是旧 Libbulletin 事后改 action 方案；重新安装 `0.1.0~rc.6-4` 或更高版本并 respring。如果浏览器打开 DSH 但没有选中会话，确认入口是 compatibility 5，且 session 仍存在于 `/var/root/.dsh/sessions`。
