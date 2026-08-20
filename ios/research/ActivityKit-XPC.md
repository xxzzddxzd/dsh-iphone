# ActivityKit 私有 XPC 研究记录（iOS 16.1.1）

这份记录只适用于 iPhone14,3、iOS 16.1.1（20B101）。私有类、plist 编码和 entitlement 都可能随系统版本改变；生产代码必须 fail-closed，不能在失败时退回前台启动 App。

## Input 服务

- 服务：`com.apple.activitykit.input`
- 私有 client：`_TtC11ActivityKit19ActivityInputClient`
- client 的 `connection` ivar 是 `BSServiceConnection`
- `remoteTarget` 实现协议 `ACActivityInputXPCServer`

协议只有三个操作：

```objc
- requestActivityWithRequest:error:
- updateActivityWithIdentifier:payload:
- endActivityWithIdentifier:payload:options:
```

目标 Bundle 的关键编码是：

```text
platterTarget.widget.containingProcess =
  { processIdentifier = { _0 = "ai.deepseek.dsh" } }
```

create 请求还需要 `attributesData`、`attributesType`、`initialContentStateData`、`contentSourceRequests`、presentation options，以及 `isEphemeral` / `isUnbounded`。update payload 是包含 JSON `contentState` 和 `NSDate` `timestamp` 的 binary plist。iOS 16.1.1 的立即结束选项是：

```text
{ uiDismissalPolicy = { date = NSDate.distantPast } }
```

把选项猜成 `{ immediate = {} }` 会触发 sessionkitd 的 Swift 解码崩溃，不能使用。

## 权限与请求者身份

显式指定另一个 platter target 的最小实测权限是：

```text
platform-application
com.apple.private.security.no-sandbox
com.apple.private.sessionkit.sessionRequest
com.apple.private.sessionkit.custom-platter-target
```

`contentSourceRequests` 可以增加 content source，但不能替换真实 XPC 请求者。添加 process source 还要求 `com.apple.private.sessionkit.permitMultipleProcessInputs`；即使有该权限，返回 descriptor 仍同时包含显式 source、真实请求进程和 sync source。

因此不能直接让 SpringBoard 调 ActivityKit：服务会把 SpringBoard 自动加入 content source。实机上 create 和 update 都成功，但 Activity 结束后 SpringBoard 被 SessionKit 生命周期回收并由 launchd 重启。即使 end 是另一个带 `activityEnder` / `sessionFinisher` 权限的进程发出，创建该 Activity 的 SpringBoard 仍会重启。这不是普通 crash；没有对应 SpringBoard crash report。

## 安全的跨进程模型

固定可执行文件身份的无界面 helper 可以显式把 platter target 设为 DSH，并在退出后由后续同名进程继续操作同一个 Activity。2026-08-19 的三进程实测：

1. 进程 A create，descriptor target 为 `ai.deepseek.dsh`，随后正常退出。
2. 进程 B 使用返回 UUID update，随后正常退出。
3. 独立查询进程仍看到该 UUID；进程 C end 后查询为 0 个 Activity。
4. 全程 SpringBoard PID 24418、sessionkitd PID 23620 未变化；end 后连续观察 15 秒也未重启。

SessionKit descriptor 对无 Bundle 的命令行进程显示的是被系统截到 15 字节的进程名，而不是 `ldid -I` 设置的完整 identifier。因此生产 helper 使用不超过 15 字节且保持不变的文件名 `DSHActivityOp`，同时仍固定签名 identifier 为 `ai.deepseek.dsh.activity-worker`。

仅把 XPC 调用移到 SpringBoard `posix_spawn` 的 helper 仍不安全。实机 create 和 update 成功，但 end 后 SpringBoard 从 PID 25149 变为 25299；helper 继承的 RunningBoard/进程责任链仍指向 SpringBoard。

把同一个 broker 作为独立 launchd job 运行后，create、update、end 均成功。早期完整 Host 原型结束时 broker 从 PID 26144 变为 26299，而 SpringBoard PID 26094、sessionkitd PID 24744 保持不变。关闭 DSH Web、排除插件回退后做分阶段监测：create 和 update 不启动 `DSHActivityHost`；end 后约 0.2 秒系统会极短暂唤醒 containing App。生产 App 主程序因此改为不含 ActivityKit 和 socket server 的无界面空壳，check-in 后立即正常退出。最终空壳版本再次实测时 Host 只存活约 0.11 秒，broker PID 30380 保持不变；因此 broker 是否被 SessionKit 回收不是稳定契约，launchd 的作用是为可能发生的回收提供自动恢复。

## 生产边界

- SpringBoard bridge 只处理 Bulletin 通知和动作，不包含 ActivityKit、Activity socket 或 helper 调度代码。
- 独立 launchd broker `DSHActivityD` 监听 socket、验证输入、保存 Activity UUID，并用 `posix_spawn` 调度 helper。
- `DSHActivityOp` 是唯一加载 ActivityKit、连接私有 input XPC 的进程。
- DSH App 只作为已注册的 platter target 和 widget extension 容器，不需要启动一次，也不需要前台或 TUN。
- SpringBoard bridge 和 broker 二进制中都不应出现 ActivityKit framework 路径或私有 client 符号。
- helper 缺失、超时、返回错误或 XPC 拒绝时向调用方返回 `ERR`，不启动 App。
- [Apple 的 ActivityKit 文档](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)规定静态属性与动态状态合计不得超过 4 KB；helper 在发 XPC 前再次检查实际 JSON 字节数。

## 用户清除后的生命周期

用户在锁屏或通知中心左滑清除 Live Activity 后，系统会撤掉它的展示，但原创建者仍能查询到对应 descriptor，input 服务对旧 UUID 的 update 也继续返回成功；这些 update 不会让卡片重新出现。因此不能用 descriptor 是否存在来判断用户是否清除过卡片。

broker 同时持久化当前 root turn 的 `sessionID` 与 `startedAtMilliseconds`。同一任务的后续 update 继续使用原 UUID，尊重用户对这次任务的清除操作；收到不同任务身份时，即使上一任务没有送达 terminal 状态，也会先结束旧 UUID，再为新任务创建 Activity。这样不会在用户刚清除后立刻反复弹回，同时保证后续任务仍能显示。
