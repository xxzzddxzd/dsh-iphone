# Node.js 的 iOS 修正

> [!WARNING]
> 这里的 Node 运行时依赖 rootless 越狱、`ldid` 和私有/JIT entitlement。它不是通用 iOS SDK，也不能在普通签名或 App Store 沙箱中运行。

本项目从官方 `node-v22.23.2.tar.xz` 构建，不保存修改后的 Node 源码。源包 SHA-256 为：

```text
bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb
```

`scripts/fetch-node.sh` 校验该值并应用 [`patches/node-v22.23.2-ios.patch`](../patches/node-v22.23.2-ios.patch)。补丁只支持 22.23.2；预像变化时构建会终止。

## 修正范围

| 文件 | 修正 | 原因 |
| --- | --- | --- |
| `configure.py` | 注册 `dest_os=ios` | 让 GYP 使用独立 iOS flavor |
| `common.gypi`、`common_node.gypi` | iPhoneOS SDK、arm64、C++20、framework 与链接参数 | 生成 iPhoneOS 目标而非 macOS 目标 |
| `tools/gyp/.../make.py` | 让 make generator 复用 Apple/Xcode 设置 | 保留 SDK、架构与 framework 参数 |
| `node.gypi` | 链接 CoreFoundation/Security，跳过无关 OpenSSL CLI | 缩小目标并满足 Darwin 依赖 |
| `deps/cares/.../ares_config.h` | iOS 上禁用不存在的 `sys/random.h` | 修复 c-ares 编译 |
| `src/crypto/crypto_context.cc` | 避开 macOS 专属 Keychain API | iOS 使用 OpenSSL 系统证书路径 |
| `deps/v8/src/common/code-memory-access*` | 为具体 JIT 区域执行 RW/RX 切换 | iOS 16 没有可用的 macOS pthread JIT 写保护接口 |

## 构建 Node

正常联网构建：

```bash
./scripts/fetch-node.sh
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
```

已有官方源包时可跳过下载，但仍会验证 SHA-256：

```bash
NODE_ARCHIVE_PATH=../node-v22.23.2.tar.xz ./scripts/fetch-node.sh
JOBS=8 ./scripts/build-node.sh
```

构建使用 `--without-node-snapshot`、`--without-node-code-cache` 和 `--openssl-no-asm`，降低交叉构建时的 host/target 耦合。`--v8-options=--jitless` 提供保守默认值；DSH 专用启动器在已签 entitlement 的设备进程中用 `--no-jitless` 开启执行路径，并同时关闭当前 iOS 组合中不稳定的优化层和 wasm trap handler。

## V8 内存权限

iOS 16.1.1 上 `MAP_JIT` 和 `pthread_jit_write_protect_np` 不能作为这套越狱命令行进程的可靠实现。补丁记录每个 V8 写作用域涉及的地址区间：

1. 进入最外层写作用域时，对页对齐后的区间设置 `ReadWrite`。
2. 嵌套作用域由递归锁和深度计数串行化。
3. 离开最外层作用域时，将记录的区间恢复为 `ReadExecute`。

这仍依赖软件包中的 [`entitlements.xml`](../packaging/node/entitlements.xml)，并由设备端 `postinst` 使用 `ldid` 签入。不要把这些 entitlement 当作安全隔离机制。

可选的执行内存探针用于确认设备行为：

```bash
./scripts/build-jit-probe.sh
scp -P 22 build/ios-jit-probe.ios-arm64 root@10.99.6.77:/var/root/ios-jit-probe
ssh -p 22 root@10.99.6.77 'ldid -S/var/jb/usr/local/lib/nodejs22/entitlements.xml /var/root/ios-jit-probe; chmod 755 /var/root/ios-jit-probe; /var/root/ios-jit-probe'
```

成功结果包含 `executed generated code: result=42`。

## 安装边界

Node 22 使用独立路径和包 ID：

```text
Package: com.xxzzddxzd.nodejs22
/var/jb/usr/local/lib/nodejs22/node
/var/jb/usr/local/bin/node22
```

它不声明替换旧 `node`，也不修改用户 shell 配置，因此 Node 18 可以继续保留。设备端检查命令：

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/node22 --version'
```
