/** OpenAI Images API: separate from the subscription OAuth backend. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

export const MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const
export type ImageModel = typeof MODELS[number]
export const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations'
export const EDITS_URL = 'https://api.openai.com/v1/images/edits'
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
export class OpenAIImagesApiClient {
  constructor(private readonly credentials: CredentialProvider, private readonly apiKeyRef: string, private readonly model: ImageModel) {
    credentialRef(apiKeyRef)
    if (!MODELS.includes(model)) throw new Error('Unsupported image model')
  }
  async generate(prompt: string, images: string[], signal: AbortSignal, animated = false): Promise<Uint8Array> {
    let key: string | undefined
    try { key = (await this.credentials.resolve(credentialRef(this.apiKeyRef)))?.value } catch { throw new Error('OpenAI API credential service failed') }
    if (!key) throw new Error(`OpenAI API key is not configured (${this.apiKeyRef})`)
    if (key.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(key)) throw new Error('OpenAI API key contains invalid characters')
    let body: string | FormData
    const headers: Record<string, string> = { ...attributionHeaders(), Authorization: `Bearer ${key}` }
    if (images.length === 0) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify({ model: this.model, prompt, quality: 'auto', size: 'auto', n: 1,
        ...animated ? { output_format: 'gif', frame_count: 4, frame_duration_ms: 200 } : {} })
    } else {
      const form = new FormData()
      form.set('model', this.model); form.set('prompt', prompt); form.set('quality', 'auto'); form.set('size', 'auto'); form.set('n', '1')
      if (animated) { form.set('output_format', 'gif'); form.set('frame_count', '4'); form.set('frame_duration_ms', '200') }
      for (const [index, image] of images.entries()) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image)
        if (!match?.[1] || !match[2]) throw new Error('OpenAI image edit requires PNG, JPEG, or WebP references')
        form.append('image[]', new Blob([Uint8Array.from(Buffer.from(match[2], 'base64'))], { type: match[1] }), `reference-${index}.${match[1].slice(6)}`)
      }
      body = form
    }
    // No caller-supplied origin and no redirect following, so the key stays with OpenAI.
    let response: Response
    const timeout = AbortSignal.timeout(120_000)
    const requestSignal = AbortSignal.any([signal, timeout])
    try { response = await fetch(images.length ? EDITS_URL : GENERATIONS_URL, { method: 'POST', headers, body, redirect: 'error', signal: requestSignal }) } catch {
      if (signal.aborted) throw signal.reason
      if (timeout.aborted) throw new Error('OpenAI Images API request timed out')
      throw new Error('OpenAI Images API network request failed')
    }
    if (!response.ok) {
      const detail = response.status === 429 ? '; rate limit or available API quota reached' : response.status === 401 ? '; check API key' : response.status === 403 ? '; check project permissions' : ''
      throw new Error(`OpenAI Images API request failed (HTTP ${response.status}${detail})`)
    }
    const length = Number(response.headers.get('content-length'))
    if (length > MAX_RESPONSE_BYTES) throw new Error('OpenAI Images API response exceeds size limit')
    if (!response.body) throw new Error('OpenAI Images API response is empty')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0
    try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > MAX_RESPONSE_BYTES) throw new Error('OpenAI Images API response exceeds size limit'); chunks.push(part.value) } } catch {
      if (signal.aborted) throw signal.reason
      if (timeout.aborted) throw new Error('OpenAI Images API request timed out')
      throw new Error('OpenAI Images API response could not be read or exceeded its size limit')
    } finally { await reader.cancel().catch(() => undefined) }
    let result: unknown
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new Error('OpenAI Images API returned invalid JSON') }
    const b64 = (result as {data?: {b64_json?: unknown}[]})?.data?.[0]?.b64_json
    if (typeof b64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(b64) || !b64) throw new Error('OpenAI Images API returned malformed image data')
    return Buffer.from(b64, 'base64')
  }
}
