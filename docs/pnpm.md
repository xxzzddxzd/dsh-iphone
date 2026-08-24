# pnpm 与 profile 插件

DSH 的 `plugin` 子命令在目标 profile 目录中执行 pnpm，成功后再把声明了 `dsh.bundle` 的依赖加入 profile 的 bundle 列表。iOS 的 `posix_spawn` 不能由 Node 直接启动 shell-script 包装器，因此 DSH iOS 补丁使用当前 Node 22 进程执行 `/var/jb/usr/local/lib/pnpm10/bin/pnpm.cjs`。pnpm 自己也包含一处 iOS-only 补丁，在执行 profile 的 `.bin` 命令时先解析 shebang，再启动真正的解释器。交互式终端中的 `/var/jb/usr/local/bin/pnpm` 和 `pnpx` 包装器始终使用 `/var/jb/usr/local/lib/nodejs22/node`，并把该 Node 目录放到子进程 PATH 首位；系统 Node 18 保持不变。

pnpm 以独立 deb 发布，版本和 registry 归档 SHA-256 锁定在 `versions.env`。构建命令：

```bash
./scripts/fetch-pnpm.sh
./scripts/package-pnpm.sh
```

设备安装后可检查版本并管理 Web profile 插件：

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/pnpm --version'
ssh -t -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root package@version'
```

profile 模板使用 `nodeLinker: hoisted` 和 `autoInstallPeers: false`。外部 bundle 的 DSH peer dependencies 从 Harness 维护的安装后备目录解析，不会在 profile 中重复安装整套 DSH。

## OpenAI Codex bundle

DSH `0.1.1-rc.2` 当前验证版本固定为 `dsh-codex@0.2.5-iphone.5`。这个 iPhone
修订适配了 rc.2 的 provider 图片预算、持久化 auth 注入、replay v2，以及
`prepareCall()` 冻结调用路径下的原生 Codex compaction。安装后先确认 pnpm 已把
bundle 写入 Web profile：

```bash
scp -P 22 dsh-codex-0.2.5-iphone.5.tgz root@10.99.6.77:/var/root/
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root /var/root/dsh-codex-0.2.5-iphone.5.tgz'
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-codex'
```

无 Codex CLI 的设备使用插件自带的设备码登录：

```bash
ssh -tt -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web exec dsh-openai-codex login --device-code'
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web exec dsh-openai-codex status'
```

浏览器完成授权后，插件把凭据以 `0600` 权限保存到 `/var/root/.dsh/.openai-codex-auth.json` 并自动刷新。该文件与 Codex CLI 的 `~/.codex/auth.json` 有独立的 refresh-token 生命周期；不要复制或共用 CLI 凭据文件。登录、状态和 Web 设置接口都不应输出 token。

pnpm 本身是 JavaScript，并已在 `ios/arm64` 上验证 registry 下载、解包、lockfile 和链接布局。这个结果不代表任意 npm 包都能在 iOS 运行：带平台限制、未提供 iPhoneOS arm64 产物的原生模块，或依赖本机编译工具链的生命周期脚本仍会失败。优先安装带预构建 JavaScript 产物且不需要安装脚本的 DSH bundle。
