/** Image-only model route. Images API requests are never exposed as a tool. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAIImagesApiClient, MODELS } from './client.ts'
import type { ImageModel } from './client.ts'
import { imageMediaType } from './mime.ts'
import { GifParameterError, parseGifOptions } from './gif-options.ts'

export { OpenAIImagesApiClient, GENERATIONS_URL, EDITS_URL, MODELS } from './client.ts'
export const name = 'openai-images-api'
export const inject = ['credentials', 'attachments', 'llm']
export const IMAGE_PROVIDER = 'openai-images-api'
const MAX_REFERENCES = 5
const KEY_REF = 'OPENAI_IMAGE_API_KEY'
const PASSIVE_CONTEXT = new Set(['runtime-context', 'time-context', 'agent-instructions', 'session-reference', 'tmux-context'])

function modelInfo(model: string): LlmModelInfo {
  if (!MODELS.includes(model as ImageModel)) throw new Error('Unsupported OpenAI image model')
  return { provider: IMAGE_PROVIDER, id: model, name: model === MODELS[0] ? 'GPT Image 2.6 Flare' : 'GPT Image 2.6 Sunburst',
    description: 'OpenAI Images API image generation; usage billed separately', inputModalities: ['text', 'image'] }
}

function localText(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

/** Conservative explicit GIF intent; never convert a negative request to GIF. */
export function wantsAnimatedGif(prompt: string): boolean {
  if (!/(?:\bgif\b|动图)/iu.test(prompt)) return false
  return !/(?:不要|不用|无需|不需要|不生成|禁止|别|without|\bno\b|\bnot\b)[^\n，。！？,.!?]{0,8}(?:\bgif\b|动图)/iu.test(prompt)
}

/** Count actual GIF image blocks, skipping palette and compressed sub-blocks. */
export function gifFrameCount(data: Uint8Array): number {
  if (data.length < 14 || !['GIF87a', 'GIF89a'].includes(Buffer.from(data.subarray(0, 6)).toString('ascii'))) return 0
  let offset = 13 + ((data[10]! & 0x80) ? 3 * (1 << ((data[10]! & 7) + 1)) : 0)
  let count = 0
  const skipBlocks = (): boolean => {
    while (offset < data.length) { const size = data[offset++]!; if (size === 0) return true; offset += size; if (offset > data.length) return false }
    return false
  }
  while (offset < data.length) {
    const marker = data[offset++]!
    if (marker === 0x3b) return count
    if (marker === 0x21) { if (offset >= data.length) return 0; offset++; if (!skipBlocks()) return 0; continue }
    if (marker !== 0x2c || offset + 9 > data.length) return 0
    const flags = data[offset + 8]!; offset += 9
    if (flags & 0x80) offset += 3 * (1 << ((flags & 7) + 1))
    if (offset >= data.length) return 0
    offset++ // LZW minimum code size
    if (!skipBlocks()) return 0
    count++
  }
  return 0
}

/** Adapter deliberately ignores tools, system messages, and earlier user turns. */
export class OpenAIImageModelAdapter extends LlmAdapter {
  private readonly dispatched = new Set<string>()
  constructor(private readonly ctx: Context) { super() }
  override providerInfo() { return { id: IMAGE_PROVIDER, name: 'OpenAI Images API' } }
  override providerRetryPolicy() { return { mode: 'normal' as const, maxRetries: 0, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
  override async listModels(provider: string) { return provider === IMAGE_PROVIDER ? MODELS.map(modelInfo) : [] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== IMAGE_PROVIDER) throw new Error('Unsupported OpenAI image provider')
    return modelInfo(model)
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.streamOnce(options) }
    catch (error: unknown) {
      if (options.signal?.aborted) throw error
      if (error instanceof GifParameterError) throw new LlmError(error.message, 'INVALID_REQUEST')
      const message = error instanceof Error && /^OpenAI Images API request failed \(HTTP [0-9]{3}(?:; [a-zA-Z /-]+)?\)$/u.test(error.message)
        ? error.message : 'Image request was refused or did not complete'
      throw new LlmError(`${message}. If a request reached OpenAI it may have been billed; retry only if you choose.`, 'INVALID_REQUEST')
    }
  }
  private async *streamOnce(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== IMAGE_PROVIDER) throw new Error('Unsupported OpenAI image provider')
    modelInfo(options.model)
    if (options.purpose === 'session-title') { yield* localText('图片生成'); return }
    if (options.purpose === 'compaction') throw new Error('Image-only model cannot summarize conversation history')
    if (options.purpose !== undefined || !options.sessionId) throw new Error('Image generation requires an interactive session')
    const userIndex = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
    const latest = options.messages[userIndex]
    if (!latest || latest.role !== 'user' || latest.source?.kind !== 'user' || !latest.id) throw new Error('Image generation requires an identified user message')
    if (options.messages.slice(userIndex + 1).some(message => message.role === 'assistant' || message.role === 'tool'
      || (message.role === 'user' && !PASSIVE_CONTEXT.has(String(message.source?.kind))))) throw new Error('Automatic continuation cannot generate a second image')
    const prompt = latest.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (!prompt) throw new Error('Enter an image-generation instruction')
    const animated = wantsAnimatedGif(prompt)
    const animation = animated ? parseGifOptions(prompt) : undefined
    const images = latest.content.filter(block => block.type === 'image')
    if (images.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images are supported`)
    if (latest.content.some(block => block.type === 'file')) throw new Error('Only image attachments are supported')
    const signal = options.signal ?? new AbortController().signal
    const references: string[] = []
    for (const image of images) {
      if (image.offloaded) throw new Error('Reference image is unavailable; attach it again')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.attachment.mediaType)) throw new Error('Reference images must be PNG, JPEG, or WebP')
      const input = await this.ctx.attachments.readImage(image.attachment, signal)
      references.push(`data:${input.ref.mediaType};base64,${Buffer.from(input.data).toString('base64')}`)
    }
    const dispatchId = `${options.sessionId}:${latest.id}`
    if (this.dispatched.has(dispatchId)) throw new Error('This user request has already been dispatched')
    this.dispatched.add(dispatchId)
    if (this.dispatched.size > 4096) this.dispatched.delete(this.dispatched.values().next().value!)
    const client = new OpenAIImagesApiClient(this.ctx.credentials, KEY_REF, options.model as ImageModel)
    const data = await client.generate(prompt, references, signal, animation)
    if (animated) {
      if (gifFrameCount(data) < 2) throw new Error('OpenAI did not return an animated GIF')
      if (data.length > this.ctx.attachments.imageLimits.maxImageBytes) throw new Error('Animated GIF exceeds the authenticated file display limit')
      const attachment = await this.ctx.attachments.saveFile({ data, name: 'generated.gif' })
      // DSH's authenticated file renderer preserves original GIF animation.
      // Only the attachment service chooses this path; no caller path is used.
      const path = this.ctx.attachments.fileHostPath(attachment)
      if (path === undefined || !path.startsWith('/') || path.includes('\0')) throw new Error('GIF attachment path is unavailable')
      const encoded = path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
      yield* localText(`![生成的动图](<${encoded}>)`)
      return
    }
    const mediaType = imageMediaType(data)
    if (!mediaType) throw new Error('OpenAI Images API response is not a supported image')
    const ref = await this.ctx.attachments.saveImage({ data, mediaType, name: `generated.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)}` })
    yield { type: 'block-start', index: 0, blockType: 'image' }
    yield { type: 'block-end', index: 0, block: { type: 'image', attachment: ref } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx: Context): void { ctx.llm.registerAdapter([IMAGE_PROVIDER], new OpenAIImageModelAdapter(ctx)) }
