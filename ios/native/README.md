# iPhone 原生客户端接入

复用 MIT 项目 [Whaleness](https://github.com/Clarklevis1995/dsh-mobile)，固定源码 commit `9bf3955c8add4ebffaed5699d59e75ddc86733ad`。DSH 仍由本机 launchd 独立运行，App 只通过 `ws://127.0.0.1:3080/ws/mobile` 访问同一后台；网页和现有数据保持独立可用。

## 安装与升级

`app-release.json` 固定未修改的 `1.7.11 / build 32` 发布 IPA、SHA-256、主 App/Widget 身份和 iOS `16.1`。校验器同时检查 Info.plist 与 Mach-O `LC_BUILD_VERSION`，不以修改 plist 代替真正的系统兼容。

```bash
DEVICE_HOST=10.99.1.139 ./scripts/install-native-app.sh
```

安装器使用手机现有的 TrollStoreLite，给 App 建立正常的数据容器和 Keychain 身份；不套用旧 WK 壳的 platform/no-sandbox entitlement，不删除 App 数据。相同版本/build 已安装时跳过，较新版本拒绝降级。发布包尚未包含本项目的本机生命周期和自动配对改动，初次配对需在 App 中扫码或粘贴真实的一次性配对串。

自定义适配版的准确版本/build 由 `source-patch.json` 锁定（当前 `1.7.11 / build 34`）。编译后为该 IPA 生成准确 SHA-256 manifest，保留相同 bundle ID。manifest 的 `capabilities` 包含 `loopback-pairing-v1`、`backend-managed-lifecycle-v1`、`composer-return-send-v1`，再显式指定两个本地产物：

```bash
NATIVE_APP_IPA=/path/to/Whaleness-iphone-build34.ipa \
NATIVE_APP_MANIFEST=/path/to/verified-build34.json \
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
- loopback 的系统通知、Live Activity 由本项目独立 root 后台权威链负责，App 不再重复创建。只清理属于该本机 profile 的旧 App 卡片，保留其他主机。
- 新增严格本机配对深链；不记录一次性能力、URL 或 token。
- 主 App 和 Widget 的版本/build 从同一个 source manifest 读取。保留上游聊天竖屏、文档预览旋转策略，先做实机验收。
- 文字键盘回车显示“发送”，复用按钮原有提交回调及门禁；中文候选确认不发送，粘贴多行保留，硬件 Shift+Return 显式换行。
- 测试覆盖本机与远端保活差异、配对的过期/远程端点拒绝，以及本机卡片清理不影响远端待显示状态。

完整构建仍使用上游 KMP + SwiftUI/UIKit 工程，需要 Xcode、Metal 工具链、JDK 17、Gradle 与 Android SDK（shared 的配置阶段需要）。未完成全包编译和实机测试前，不把源码解析或发布包元数据校验称作 App 验收通过。

固定检出并构建：

```bash
git clone https://github.com/Clarklevis1995/dsh-mobile.git /path/to/whaleness
git -C /path/to/whaleness checkout 9bf3955c8add4ebffaed5699d59e75ddc86733ad
NATIVE_APP_SOURCE=/path/to/whaleness \
NATIVE_JAVA_HOME=/path/to/jdk17 \
NATIVE_ANDROID_SDK=/path/to/android-sdk \
./scripts/build-native-app.sh
```

构建器先检查精确 commit 并幂等应用本项目补丁，再独立构建 arm64 Release KMP framework。Xcode archive 在 `build/native-app/project` 的私有工程副本进行，其中上游无条件 Gradle 阶段替换成已有 framework 检查，避免重复启动 Gradle。所有签名关闭，最终由 TrollStoreLite 安装器处理。只有明确已完成本次 KMP 构建时，才可用 `NATIVE_SKIP_KMP_BUILD=1` 复用该 framework。

输出 IPA 文件名由锁定版本/build 生成，当前为 `build/native-app/Whaleness-iphone-1.7.11-build34.ipa`，配套 `build/native-app/native-app-manifest.json`。manifest 记录实际 SHA-256、源码 commit、补丁 SHA 和适配能力，打包后再次验证主 App 与 Widget：

```bash
NATIVE_APP_IPA="$PWD/build/native-app/Whaleness-iphone-1.7.11-build34.ipa" \
NATIVE_APP_MANIFEST="$PWD/build/native-app/native-app-manifest.json" \
DEVICE_HOST=10.99.1.139 ./scripts/install-native-app.sh
```

## 本地检查

```bash
python3 -B tests/test-native-app.py
bash -n scripts/install-native-app.sh
python3 -B ios/native/native_client.py verify-ipa /path/to/pinned-release.ipa
```
