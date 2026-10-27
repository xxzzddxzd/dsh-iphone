# iPhone 原生客户端接入

复用 MIT 项目 [Whaleness](https://github.com/Clarklevis1995/dsh-mobile)，固定源码 commit `9bf3955c8add4ebffaed5699d59e75ddc86733ad`。DSH 仍由本机 launchd 独立运行，App 只通过 `ws://127.0.0.1:3080/ws/mobile` 访问同一后台；网页和现有数据保持独立可用。

## 安装与升级

`app-release.json` 固定未修改的 `1.7.11 / build 32` 发布 IPA、SHA-256、主 App/Widget 身份和 iOS `16.1`。校验器同时检查 Info.plist 与 Mach-O `LC_BUILD_VERSION`，不以修改 plist 代替真正的系统兼容。

```bash
DEVICE_HOST=10.99.1.139 ./scripts/install-native-app.sh
```

安装器使用手机现有的 TrollStoreLite，给 App 建立正常的数据容器和 Keychain 身份；不套用旧 WK 壳的 platform/no-sandbox entitlement，不删除 App 数据。相同版本/build 已安装时跳过，较新版本拒绝降级。发布包尚未包含本项目的本机生命周期和自动配对改动，初次配对需在 App 中扫码或粘贴真实的一次性配对串。

自定义适配版的准确版本/build 由 `source-patch.json` 锁定（当前 `1.7.11 / build 37`）。编译后为该 IPA 生成准确 SHA-256 manifest，保留相同 bundle ID。manifest 的 `capabilities` 包含 `loopback-pairing-v1`、`backend-managed-lifecycle-v1`、`composer-return-send-v1`、`root-live-activity-widget-v1`、`loopback-on-demand-history-v1`，再显式指定两个本地产物：

```bash
NATIVE_APP_IPA=/path/to/Whaleness-iphone-build37.ipa \
NATIVE_APP_MANIFEST=/path/to/verified-build37.json \
DEVICE_HOST=10.99.1.139 ./scripts/install-native-app.sh
```

固定系统路径只用于已经验证的这台 rootless iPhone。安装脚本不会启动/重启 DSH，也不自动启动 App。

## 配对与会话跳转

适配版接受 `dshmobile://pair?payload=...`。它只接收来自本机 `ws://127.0.0.1:3080/ws/mobile`、有效期不超过十分钟的真实版本 2 配对串；所有候选地址都必须指向同一严格本机端点。App 仍调用原 `hosts.pair`，由真实握手结果写入 Keychain。脚本不构造 token，也不导入其他客户端的凭据。

在手机执行安装器传入的脚本：

```bash
python3 /var/root/dsh-native-client/scripts/open-native-app.py \
  --pairing-payload /var/root/private-fresh-pairing.txt
```

配对文件必须为 `0600`，内容仅为网关真实返回的 Base64URL 串。脚本不打印配对 URL。未修改的发布版没有此入口，manifest 不声明能力时脚本拒绝调用。

配对完成后，原生 App 的非敏感 UserDefaults 内 `gateway.profiles.v1` 保存服务器 `gatewayId` 与客户端 `profile.id` 的关联；两者不能混用。本地 ID 来自 Swift `UUID().uuidString`，必须保留大小写，否则 App 的严格字符串比较会拒绝深链。

```bash
python3 /var/root/dsh-native-client/ios/native/native_client.py export-mapping
python3 /var/root/dsh-native-client/scripts/open-native-app.py \
  --refresh-mapping --gateway-id SERVER_UUID --session SESSION_ID
```

映射默认原子写入 `/var/root/.dsh/native-client/gateway-map.json`，权限 `0600`。仅导出 loopback 的身份和端点，不读取 Keychain。会话跳转要求所选服务器对应 App 当前激活的主机；原版 session 深链不支持切换主机，未激活时明确失败，通知桥应回退到网页。

## 最小源码适配

```bash
python3 ios/native/apply_source.py /path/to/whaleness
```

脚本校验 commit、补丁 SHA-256 和目标文件预像，可幂等应用。`whaleness-iphone.patch` 的范围：

- 仅 loopback 连接跳过定位/静音音频长期保活；有限后台额度、断线重连和远端主机行为保留。
- loopback 主机不在空闲时预取其他冷会话的历史，用户选择会话后按需读取，减少与本机 DSH 共享的 CPU/内存开销；远端预取策略保留。
- loopback 的系统通知、Live Activity 由本项目独立 root 后台权威链负责，App 不再重复创建。只清理属于该本机 profile 的旧 App 卡片，保留其他主机。
- 新增严格本机配对深链；不记录一次性能力、URL 或 token。
- 主 App 和 Widget 的版本/build 从同一个 source manifest 读取。保留上游聊天竖屏、文档预览旋转策略，先做实机验收。
- App 进入后台取消订阅超时定时器，回到前台为仍待确认的订阅重新给予完整等待窗口；确认、断线或重置时取消旧计时，避免锁屏期间误报。
- 文字键盘回车显示“发送”，复用按钮原有提交回调及门禁；中文候选确认不发送，粘贴多行保留，硬件 Shift+Return 显式换行。
- 测试覆盖本机与远端保活差异、配对的过期/远程端点拒绝，以及本机卡片清理不影响远端待显示状态。

完整构建仍使用上游 KMP + SwiftUI/UIKit 工程，需要 Xcode、Metal 工具链、JDK 17、Gradle 与 Android SDK（shared 的配置阶段需要）。切换或更新 Xcode 后，先用 `xcodebuild -showComponent MetalToolchain -json` 和 `xcrun metal --version` 检查当前选中 Xcode 的组件；旧 Xcode 的已挂载组件不一定满足新版本，需要时用 `xcodebuild -downloadComponent MetalToolchain` 安装匹配版本。构建器会在 KMP 或清理旧输出前执行 Metal 可用性检查。未完成全包编译和实机测试前，不把源码解析或发布包元数据校验称作 App 验收通过。

固定检出并构建：

```bash
git clone https://github.com/Clarklevis1995/dsh-mobile.git /path/to/whaleness
git -C /path/to/whaleness checkout 9bf3955c8add4ebffaed5699d59e75ddc86733ad
NATIVE_APP_SOURCE=/path/to/whaleness \
NATIVE_JAVA_HOME=/path/to/jdk17 \
NATIVE_ANDROID_SDK=/path/to/android-sdk \
./scripts/build-native-app.sh
```

构建器先检查精确 commit 并幂等应用本项目补丁，再独立构建 arm64 Release KMP framework。Xcode archive 在 `build/native-app/project` 的私有工程副本进行，其中上游无条件 Gradle 阶段替换成已有 framework 检查，避免重复启动 Gradle。Xcode archive 关闭签名；打包前用 `ldid` 将 `AgentLiveActivityWidget.entitlements` 中三项明确身份嵌入 Widget，最终仍由 TrollStoreLite 安装器签名。主 App 不在构建器中签名，保留安装器既有正常容器和 Keychain 身份。只有明确已完成本次 KMP 构建时，才可用 `NATIVE_SKIP_KMP_BUILD=1` 复用该 framework。

构建同时输出独立的 `DSHWidgetSetup` 和 `DSHWidgetSetup.entitlements`，与生成的 manifest 放在同一目录。manifest 记录 `helperSHA256` 和 `helperEntitlementsSHA256`；安装器在任何 SSH 写入前验证这两个输入。该短命 helper 只接受硬编码的原生 Widget 目标，签名后降为 mobile 用户，精确请求扩展描述符缓存，再只读验证两类 Live Activity 的 App/Widget 归属。缓存版本的主 App/Widget 两个 build 段必须分别匹配当前 LaunchServices 注册值与磁盘 Info；旧任一段或未知版本格式都拒绝，不能用旧描述符残留报成功。安装器还将 helper 返回的两个 build 与准确 manifest 比较。其四项权限只在 helper 中，不写入主 App 或 Widget。已经安装准确版本时也执行此步骤。未声明 Root Widget 能力的上游 build 32 不需要 helper。

已实测 iOS 16.1 的 chronod 可能继续持有升级前的 LaunchServices 代理，单扩展缓存和局部重新注册均无法更新此残留。只有“注册/磁盘一致、两类描述符及归属有效，但缓存 build 确实较旧”时，helper 返回专用退出码 2；安装器才允许一次 renderer 重载。它从内核进程路径和 UID 同时确认唯一的 mobile `chronod`，发送一次 TERM，然后重试 helper；不重启 SpringBoard、Node 或主 App，也不修改 chronod 数据库。普通错误、未知/较新缓存或第二次失败均直接撤销本工具生成的支持记录并退出。只有最终版本与归属验证全部通过才发布支持记录。

单独修改 helper 时，可运行 `./scripts/build-native-widget-setup.sh` 更新已有 `build/native-app` 中的 helper 和 manifest；它核对现有 IPA 的 SHA，不重建或修改 IPA。

输出 IPA 文件名由锁定版本/build 生成，当前为 `build/native-app/Whaleness-iphone-1.7.11-build37.ipa`，配套 `build/native-app/native-app-manifest.json`。manifest 记录实际 SHA-256、源码 commit、补丁 SHA 和适配能力，打包后再次验证主 App 与 Widget：

```bash
NATIVE_APP_IPA="$PWD/build/native-app/Whaleness-iphone-1.7.11-build37.ipa" \
NATIVE_APP_MANIFEST="$PWD/build/native-app/native-app-manifest.json" \
DEVICE_HOST=10.99.1.139 ./scripts/install-native-app.sh
```

## 本地检查

```bash
python3 -B tests/test-native-app.py
node tests/test-native-widget-setup.mjs
bash -n scripts/install-native-app.sh
python3 -B ios/native/native_client.py verify-ipa /path/to/pinned-release.ipa
```

## 本机 Root 活动栏由原生 App 的 Widget 承载

build 35 开始在现有 `AgentLiveActivityWidget.appex` 中额外注册稳定的 `DSHRootActivityWidget`。它使用独立的 `DSHActivityAttributes`，保持本项目 Root broker 的原状态字段、进度、Goal/工具展示与鲸鱼资源；远端连接原有的 `AgentActivityAttributes` / `AgentLiveActivityWidget` 不变。两类状态不互相翻译，也不让 App 在 loopback 模式重新创建同一张活动卡。

活动的后台创建、更新与结束仍由原 launchd broker/短命 worker 负责。后端必须显式以已安装的 `com.clark.dshmobile.dev` 为 platter target，并核验实际返回身份；不把旧 `ai.deepseek.dsh` 的已创建活动 UUID 直接复用为新目标。Native 卡的点击由原有严格 `launchURL` 进入已配对会话。缺少有效 App/Widget 或原生映射时，后端应明确采用旧独立 Widget 回退，不静默声称已由 App 承载。

build 35 的实机记录表明：TrollStoreLite 只给主 App 补默认身份，未签名 Widget 只有 trust entitlement；PluginKit 虽登记，chronod 没有取得该扩展描述符，create 成功也没有显示卡片。build 36 在打包前为 Widget 单独嵌入 `TROLLTROLL` team 下的精确 application-identifier 和自身 container-required，不加 platform、no-sandbox、Keychain 或调试权限。实机还需要 `CHSToolServiceConnection` 以扩展 bundle ID 精确缓存描述符；普通 containing App 缓存回调成功不能代替这一步。安装后核验实际签名身份、两类 `CHSSessionPlatterDescriptor` 与实际显示，不能仅检查签名存在。iOS 16.1 的普通 `CHSConnection.descriptors:` 不返回 Live Activity，helper 因而只读 chronod 的 type 1 归档并安全解码，`activityAttributesType` 内部为二进制 plist。

此设计不依赖 App 保活、APNs 或 iOS 16.2 的 `ActivityContent` API。归档成功只证明资源/Swift 类型与 Widget 注册可编译；还必须实测新 target 的 create/update/end、App 终止及锁屏后更新、用户清除行为、活动结束是否异常唤醒 containing App，以及旧目标退场不留下重复卡。
