# OpenAI Images API models for DSH

This standalone DSH plugin registers two image-only models: `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`. Select one in the conversation model list and enter an image prompt. Their names and the write-only API key control are in **Settings → Models**. API requests are billed separately from ChatGPT and Codex subscriptions.

The plugin does not register an image-generation tool. Other conversation models cannot invoke this API through the plugin. It forwards only the current human user's prompt and images explicitly attached to that message. To edit an earlier image, attach it again. Normal image results appear as durable DSH image attachments. When the prompt explicitly requests an animated GIF, the API is asked for four frames and the original animated bytes are stored as a durable file and displayed through DSH's authenticated file route. No still image is substituted if GIF generation fails. GIF display has been designed for Mac's local filesystem; iPhone and remote workspace operation are not validated.

The credential is the DSH credentials reference `OPENAI_IMAGE_API_KEY`. Its value is never returned by the settings page or included in plugin configuration. The client sends requests only to fixed OpenAI HTTPS endpoints, refuses redirects, redacts error details and has a bounded timeout.

Automatic title requests and other noninteractive calls do not generate images. The adapter disables DSH's automatic request retry, rejects automatic follow-ups and holds an in-process user-message guard to reduce duplicate billing; the guard is not persistent across process restarts. An upstream timeout can occur after a charge, so a failed request should be retried only deliberately. The current GIF is surfaced as a Markdown file path; the present attachment store does not garbage-collect files, but a future GC must account for that reference.

Install dependencies with `pnpm install --frozen-lockfile` and validate with `pnpm run check`. The plugin is linked into the Mac Web profile; iPhone has not been updated. Parts of the attachment code were adapted from dsh-codex under Apache-2.0; see LICENSE.
