/** Independent OpenAI Images API tool. Attachment and workspace integration adapted from dsh-codex (Apache-2.0): https://github.com/Yan-Zero/dsh-codex */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { writeWorkspaceBytes } from './binary-fs.ts'
import { assertImageCapable } from './image-capability.ts'
import { imageMediaType } from './mime.ts'
import { MODELS, OpenAIImagesApiClient } from './client.ts'
import type { ImageModel } from './client.ts'
export { OpenAIImagesApiClient, GENERATIONS_URL, EDITS_URL, MODELS } from './client.ts'
export const name = 'openai-images-api'
export const inject = ['credentials', 'tools', 'fs', 'attachments', 'llm']
export interface Config { model?: ImageModel }
export const Config: z<Config> = z.object({
 model: z.union(MODELS).default('gpt-image-2.6-flare'),
})
const MAX_REFERENCE_IMAGES = 5
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason }
function defaultOutputPath(extension: 'png' | 'jpg' | 'webp' | 'gif'): string { return `generated-${randomUUID()}.${extension}` }
interface ImagegenArgs {
  model?: ImageModel
  prompt: string
  referenced_image_paths?: string[]
  num_last_images_to_include?: number
  output_path?: string
}

interface ImagegenValue {
  prompt: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
  file?: {
    path: string
    operation: 'create' | 'update'
  }
  writeError?: string
}

function fileExtension(mediaType: ImageMediaType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function attachmentRef(value: ImagegenValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId),
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
  }
}

function contentOf(value: ImagegenValue): ContentBlock[] {
  const file = value.file === undefined
    ? value.writeError === undefined ? '' : `\n<output_error>${value.writeError}</output_error>`
    : `\n<output_path operation="${value.file.operation}">${value.file.path}</output_path>`
  return [
    {
      type: 'text',
      text: `<image>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>${file}`,
    },
    { type: 'image', attachment: attachmentRef(value.image) },
  ]
}

function collectImageRefs(content: readonly ContentBlock[], output: ImageAttachmentRef[]): void {
  for (const block of content) {
    if (block.type === 'image') output.push(block.attachment)
  }
}

function recentImageRefs(messages: readonly Message[], count: number): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const message of messages) collectImageRefs(message.content, refs)
  return refs.slice(-count)
}

async function conversationImages(ctx: Context, exec: ToolExecution, count: number): Promise<string[]> {
  const session = exec.agent?.session
  if (session === undefined) throw new Error('conversation image references are unavailable outside an agent session')
  const refs = recentImageRefs(session.deriveMessages(), count)
  if (refs.length !== count) {
    throw new Error(`requested the last ${count} conversation images, but only ${refs.length} were available`)
  }
  return Promise.all(refs.map(async ref => {
    const stored = await ctx.attachments.readImage(ref, exec.signal)
    return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  }))
}

async function workspaceImages(ctx: Context, exec: ToolExecution, paths: readonly string[]): Promise<string[]> {
  const cwd = exec.agent?.session.header.cwd
  const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
  const images: string[] = []
  for (const path of paths) {
    if (path.trim().length === 0) throw new Error('referenced_image_paths must not contain an empty path')
    const target = await ctx.fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) throw new Error(`referenced image does not exist: ${path}`)
    if (info.type !== 'file') throw new Error(`referenced image is not a regular file: ${path}`)
    const data = await ctx.fs.readBytes(target, exec.signal, maxBytes)
    const mediaType = imageMediaType(data)
    if (mediaType === undefined) throw new Error(`referenced image is not PNG, JPEG, WebP, or GIF: ${path}`)
    await ctx.attachments.validateImage({ data, mediaType, name: basename(target.displayPath) })
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    images.push(`data:${mediaType};base64,${Buffer.from(data).toString('base64')}`)
  }
  return images
}

function parseArgs(args: ImagegenArgs): Required<Pick<ImagegenArgs, 'prompt'>> & Omit<ImagegenArgs, 'prompt'> {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error('imagegen prompt must not be empty')
  if (args.model !== undefined && !MODELS.includes(args.model)) throw new Error('unsupported OpenAI image model')
  const paths = args.referenced_image_paths ?? []
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`referenced_image_paths must contain at most ${MAX_REFERENCE_IMAGES} paths`)
  }
  const count = args.num_last_images_to_include
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_REFERENCE_IMAGES)) {
    throw new Error(`num_last_images_to_include must be an integer between 1 and ${MAX_REFERENCE_IMAGES}`)
  }
  if (paths.length > 0 && count !== undefined) {
    throw new Error('provide only one of referenced_image_paths or num_last_images_to_include')
  }
  if (args.output_path !== undefined && args.output_path.trim().length === 0) {
    throw new Error('output_path must not be empty')
  }
  return {
    prompt,
    ...args.model === undefined ? {} : { model: args.model },
    ...paths.length === 0 ? {} : { referenced_image_paths: paths },
    ...count === undefined ? {} : { num_last_images_to_include: count },
    ...args.output_path === undefined ? {} : { output_path: args.output_path },
  }
}

/** Build the plugin-owned Codex image generation and editing tool. */
export function imagegenTool(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: 'openai_imagegen',
    description: 'Generate or edit an image using the separate usage-billed OpenAI API, not a Codex subscription. Use only when the user requests OpenAI API image generation or editing. Provide at most five PNG/JPEG/WebP references using paths or recent conversation images. Returns an attachment and saves the image in the workspace.',
    parameters: {
      model: { type: 'string', enum: MODELS, description: 'Use Sunburst only when the user explicitly requests it; omit to use the configured default.' },
      prompt: { type: 'string', required: true, description: 'Complete generation or edit instruction. For multiple references, name each input by its Image N order.' },
      referenced_image_paths: { type: 'array', items: { type: 'string' }, description: 'Local or active-workspace image paths in Image 1..N order; up to five for OpenAI.' },
      num_last_images_to_include: { type: 'integer', description: 'Use recent conversation images in chronological order; 1–5.' },
      output_path: { type: 'string', description: 'Optional active-workspace path for the generated image. Omit it to use a unique generated-<timestamp>-<id> name with the detected image extension. Existing files remain subject to filesystem write-intent policy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          file: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              operation: { type: 'string', required: true, enum: ['create', 'update'] },
            },
          },
          writeError: { type: 'string' },
        },
      },
      render: (_args, value) => contentOf(value),
    },
    isConcurrencySafe: args => args.output_path === undefined,
    async execute(rawArgs, exec) {
      const args = parseArgs(rawArgs)
      await assertImageCapable(ctx, exec, 'generate an image')
      const images = args.referenced_image_paths !== undefined
        ? await workspaceImages(ctx, exec, args.referenced_image_paths)
        : args.num_last_images_to_include !== undefined
          ? await conversationImages(ctx, exec, args.num_last_images_to_include)
          : []
      const client = new OpenAIImagesApiClient(ctx.credentials, 'OPENAI_IMAGE_API_KEY', args.model ?? config.model ?? 'gpt-image-2.6-flare')
      const data = await client.generate(args.prompt, images, exec.signal)
      const mediaType = imageMediaType(data)
      if (mediaType === undefined) throw new Error('OpenAI image response was not PNG, JPEG, or WebP')
      const extension = fileExtension(mediaType)
      const ref = await ctx.attachments.saveImage({ data, mediaType, name: `generated.${extension}` })
      const value: ImagegenValue = {
        prompt: args.prompt,
        image: {
          attachmentId: ref.attachmentId,
          mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      const outputPath = args.output_path ?? defaultOutputPath(extension)
      try {
        const cwd = exec.agent?.session.header.cwd
        const target = await ctx.fs.resolve(outputPath, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
        const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        const outcome = await writeWorkspaceBytes(ctx, exec, target, data, intent)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        value.file = { path: target.displayPath, operation: outcome.operation }
      } catch (error: unknown) {
        throwIfAborted(exec.signal)
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
        value.writeError = `generated image was not written to ${JSON.stringify(outputPath)}: ${detail}`
      }

      return value
    },
    presentCall: args => ({
      card: 'generic',
      title: args.output_path === undefined ? 'Generate image' : `Generate image ${args.output_path}`,
      kind: args.output_path === undefined ? 'execute' : 'edit',
      ...(args.output_path === undefined ? {} : { locations: [{ path: args.output_path }] }),
    }),
    presentResult: (args, result) => ({
      card: 'generic',
      title: args.output_path === undefined ? 'Generated image' : `Generated image ${args.output_path}`,
      content: result.content,
    }),
  })
}

export function apply(ctx: Context, config: Config): void { ctx.tools.register(imagegenTool(ctx, config)) }
