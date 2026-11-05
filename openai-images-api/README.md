# OpenAI Images API for DSH

An independent, usage-billed tool, `openai_imagegen`, does not use a Codex subscription and does not register a chat provider. Ask the assistant explicitly to use the OpenAI API image tool. API charges apply separately from ChatGPT/Codex.

Configure a rotated OpenAI API key in **Settings → OpenAI 生图**. It is stored using DSH credentials as `OPENAI_IMAGE_API_KEY`, never returned to the page and re-resolved for each operation. The plugin uses a fixed OpenAI origin with redirects disabled. The old key shared in a chat should be revoked.

The default is `gpt-image-2.6-flare`; explicitly ask in the conversation for `gpt-image-2.6-sunburst` to select it for one request. The settings page manages the API key only; it does not provide a model selector. The tool description asks the assistant to use this billed route only when requested, but that instruction does not technically prevent an unintended call. Generation and editing support PNG/JPEG/WebP reference files or recent conversation images, validate attachments, and return a durable inline attachment; writing to a workspace respects filesystem intent and sandbox policy. The current chat model must support image input. API errors return a sanitized HTTP status. It does not use GIF output, image-only chat model selection, or Codex OAuth.

Build the plugin with `pnpm install --frozen-lockfile` and `pnpm run check`, then add it as a local bundle to the intended DSH profile. On this Mac it is linked into the Web profile; the iPhone has not been updated. Existing subscription and xAI image tools continue under their own names.

Parts of the attachment and binary workspace code are adapted from dsh-codex (Apache-2.0), https://github.com/Yan-Zero/dsh-codex. See LICENSE.
