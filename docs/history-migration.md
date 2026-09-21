# 0.1.5 历史会话恢复

0.1.5 使用 session format v3。官方冻结的旧版迁移器不接受自定义的
`web/openai-codex-search-llm-request`，即使事件带有 `ignorable`。
旧版 `subagent/descriptor` v2 也会被 v0 迁移入口拒绝。这两种情况会导致
历史加载失败，并让模型选择器停留在“正在加载模型”。

仓库提供一次性恢复工具，Mac 和 iPhone 使用相同代码，不修改官方核心：

```sh
# iPhone：先校验，再发布新一代日志
bash scripts/migrate-device-history.sh
bash scripts/migrate-device-history.sh --apply

# Mac
python3 scripts/migrate-provider-history.py \
  "$(npm root -g)/@deepseek-ai/dsh" "$HOME/.dsh/sessions"
python3 scripts/migrate-provider-history.py \
  "$(npm root -g)/@deepseek-ai/dsh" "$HOME/.dsh/sessions" --apply
```

`deploy.sh` 在启动服务后自动执行恢复。正在使用的会话会因官方 `session.lock`
被占用而跳过并报错，工具不会强行修改。已存在新版日志的目录直接跳过。

搜索事件先校验插件拥有的精确字段结构，再通过仅在内存中存在的已知诊断事件
参与官方 v0 → v1 → v2 → v3 序号迁移，随后恢复原始事件类型、时间和完整请求
数据。输出标记 `ignorable: true`，不依赖插件也能读取其日志。不会发送搜索请求，
不会删除记录，也不会把临时诊断事件写到磁盘。

子代理 descriptor v2 → v3 依据官方提交 `f76a225a7d`：唯一的结构变化是新增可选
`agentReasoningEffort`，旧字段语义不变。工具只提升已知旧结构的版本，然后交给
官方校验器验证；未知字段或其他未知事件仍然拒绝。

发布前执行当前格式的完整往返校验。持有官方文件锁后，以排他硬链接提交
`session.v3.jsonl`，不覆盖任何已有版本。原始 `session.jsonl` 始终保留，写入前后
核对 SHA-256。输出只包含会话 ID、计数和校验值，不打印对话内容或凭据。
