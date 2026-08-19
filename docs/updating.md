# 更新 DSH 与 Node

更新必须同时处理 Git 上游引用、npm 发布闭包和 iOS 补丁预像。仅更新其中一个会得到不可复现或无法启动的部署包。

## 更新 DSH

先查看官方提交和发布标签，不修改主仓库文件：

```bash
git -C upstream/deepseek-harness fetch --tags origin
git -C upstream/deepseek-harness log --oneline --decorate -20 origin/main
```

选择已发布提交后，以 detached HEAD 更新子模块。例如检查 rc.7 的当前基线：

```bash
./scripts/update-upstream.sh 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
git submodule status
```

对新发布版依次完成：

1. 将 `versions.env` 的 `DSH_VERSION`、Debian version、上游 commit、npm integrity 和 release cutoff 改为新值。
2. 将 `dsh-runtime/package.json` 的 DSH 版本改为完全版本，不使用 `^` 或 `latest`。
3. 用早于下一版发布时间的 cutoff 重新生成 lock。
4. 运行严格补丁器，逐项处理文件名或预像变化。
5. 重新编译 node-pty、生成软件包并运行完整验证。

生成 lock 的命令形式如下；日期应取新版本发布之后、下一版本发布之前的 UTC 时间：

```bash
DSH_RELEASE_CUTOFF=2026-08-18T00:00:00Z
npm install --prefix dsh-runtime --package-lock-only --ignore-scripts --no-audit --no-fund --before="$DSH_RELEASE_CUTOFF"
npm ci --prefix dsh-runtime --ignore-scripts --no-audit --no-fund
```

确认没有 DSH 家族版本漂移：

```bash
node tests/test-lockfile.mjs
```

新版本通常会改变 `profile-boot-*.js`、`types-*.js`、`index-*.js` 和 `vendor-*.js` 名称。应根据新发布包修改 `scripts/patch-dsh.mjs` 的目标与测试，不能简单放宽匹配或复制旧版完整文件。

## 更新 Node

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

在干净官方源包上验证补丁：

```bash
NODE_ARCHIVE_PATH=../node-v22.23.2.tar.xz ./tests/test-source-patches.sh
```

然后执行完整构建：

```bash
JOBS=8 ./scripts/build-node.sh
./scripts/package-node.sh
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
./scripts/package-dsh.sh
./scripts/verify.sh
```

## 更新 pnpm

pnpm 使用 npm registry 发布的完整 JavaScript 发行包，不使用 Corepack 在设备上即时下载。更新时修改 `versions.env` 的版本、URL、SHA-256 和 Debian revision，在 Mac 上重新运行 `fetch-pnpm.sh` 与 `package-pnpm.sh`，然后执行 `verify.sh`。至少在设备上验证版本、一个隔离 store 的 registry 安装，以及 `dsh plugin --profile web why <已安装插件>`；pnpm 能运行不代表含原生模块的任意插件已经适配 iPhoneOS。

## 提交升级

升级提交应包含子模块 gitlink、版本文件、lock、补丁、测试和文档，不包含 `build/`、`dist/`、`.cache/` 或 `node_modules/`：

```bash
git diff --submodule=log
git status --short
git add .gitmodules upstream/deepseek-harness versions.env dsh-runtime packaging patches scripts shims web tests docs README.md THIRD_PARTY_NOTICES.md
git commit -m "Update DSH iPhone runtime"
```
