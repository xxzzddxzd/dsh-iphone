# Cline Pass 离线构建输入

精确固定官方 npm `dsh-cline-pass@0.2.13` 与 archive integrity。它没有直接生产依赖；构建时用 `--legacy-peer-deps` 只取发布包，DSH peers 由安装后的 Host 提供，不能打入手机 tarball。默认源不再是 Mac 当前运行 profile 的插件目录，因此可先构建、测试候选，再分别部署两端。

```bash
./scripts/package-dsh-cline-pass.sh
```

输出为 `dist/dsh-cline-pass-0.2.13.tgz`。构建要求 `versions.env` 也固定到 `0.2.13`，并比较发布包的全部文件；唯一允许变化的是已审计的 `lib/client.js` 运输补丁。必要时仍可用 `DSH_CLINE_PASS_SOURCE` 指向候选目录，但其所有其他文件必须逐字节匹配锁定的官方包。

上游 0.2.13 的浏览器客户端仍使用同一个相对地址 `fetch(PANEL_PATH)`，没有修复 iOS 16 的 `Load failed` 情况，因此保留绝对同源 URL、Cookie 与 XHR 回退。新客户端的完整预像 SHA-256 为 `2ad350477e95e15259e70faad425d0877723b2767462e4a468960cbb5293f882`；旧 0.2.8 hash 不再作为当前候选的支持值。未知版本、预像变化或补丁外修改均拒绝处理。HTTP 拒绝和业务错误不会触发 XHR 再次提交。

包构建包含精确输入、幂等补丁和真实补丁方法的 VM 行为测试。实机仍应检查原有账号/Key、默认模型和插件设置入口，再分别验证 Cline Pass 模型调用与 Safari 面板的读写；本脚本不会复制凭据或更改默认模型。
