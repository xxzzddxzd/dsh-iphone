/** Independent OpenAI Images API settings. Secrets are written only to DSH's credential service. */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

const KEY_REF = 'OPENAI_IMAGE_API_KEY'

interface CredentialState {
  configured: boolean
  writable: boolean
  source?: string
}

// The Remote assembly contributes this namespace at runtime. Keep the tiny
// wire face local because the Host controller's generated types are not a
// direct dependency of this standalone browser bundle.
type RemoteResult<T> = { ok: true; value: T } | { ok: false }
interface CredentialRemote {
  describe: (refs: string[]) => Promise<RemoteResult<Record<string, CredentialState>>>
  set: (ref: string, value: string) => Promise<RemoteResult<void>>
  unset: (ref: string) => Promise<RemoteResult<void>>
}

interface PageFace {
  describe: () => Promise<CredentialState>
  save: (value: string) => Promise<void>
  remove: () => Promise<void>
  subscribe: (listener: () => void) => () => void
}

function OpenAIImagesSettings({ describe, save, remove, subscribe }: PageFace) {
  const [credential, setCredential] = useState<CredentialState>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let mounted = true
    let generation = 0
    const refresh = (): void => {
      const request = ++generation
      void describe().then(value => {
        if (mounted && request === generation) { setCredential(value); setError(undefined) }
      }, () => {
        if (mounted && request === generation) { setCredential(undefined); setError('无法读取密钥配置状态。') }
      })
    }
    const unsubscribe = subscribe(refresh)
    refresh()
    return () => { mounted = false; generation++; unsubscribe() }
  }, [describe, subscribe])

  const submit = async (): Promise<void> => {
    if (busy || !credential?.writable || draft.trim().length === 0) return
    const value = draft.trim()
    setDraft('')
    setBusy(true)
    setError(undefined)
    try {
      await save(value)
      setCredential(await describe())
    } catch {
      setError('保存失败，请检查凭据服务后重新输入。')
    } finally { setBusy(false) }
  }

  const clear = async (): Promise<void> => {
    if (busy || !credential?.writable || !credential.configured) return
    setBusy(true)
    setDraft('')
    setError(undefined)
    try {
      await remove()
      setCredential(await describe())
    } catch {
      setError('移除失败，请检查凭据服务。')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <h3>OpenAI 图片模型</h3>
      <p>使用独立 OpenAI API 生成和编辑图片。API 按用量计费，与 ChatGPT／Codex 订阅分开。</p>
      <p>在对话的模型列表中选择图片模型，然后输入生图或编辑需求。</p>
      <ul aria-label="OpenAI 图片模型">
        <li>GPT Image 2.6 Flare</li>
        <li>GPT Image 2.6 Sunburst</li>
      </ul>
      <div>
        <strong>API Key</strong>
        <p>{credential === undefined ? '正在读取配置状态…' : credential.configured ? '已配置' : '未配置'}
          {credential?.source === undefined ? '' : `（来源：${credential.source}）`}</p>
        {credential !== undefined && !credential.writable ? <p>当前凭据来源不可通过此页面修改。</p> : null}
        <label htmlFor="openai-images-api-key">输入新的 API Key</label>
        <input
          id="openai-images-api-key"
          type="password"
          autoComplete="off"
          value={draft}
          onChange={event => { setDraft(event.currentTarget.value) }}
          disabled={busy || credential?.writable !== true}
          style={{ display: 'block', width: '100%', margin: '8px 0' }}
        />
        <p>密钥只写入 DSH 凭据存储，不会在此页面显示或读回。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => { void submit() }} disabled={busy || credential?.writable !== true || draft.trim().length === 0}>保存密钥</button>
          <button type="button" onClick={() => { void clear() }} disabled={busy || credential?.writable !== true || !credential.configured}>移除已保存密钥</button>
        </div>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </div>
    </div>
  )
}

export const name = 'dsh-openai-images-api-client'
export const inject = ['slots', 'remote', 'remote.credentials']

export function apply(ctx: Context): void {
  const credentials = (ctx.remote as unknown as { credentials: CredentialRemote }).credentials
  const face: PageFace = {
    async describe() {
      const response = await credentials.describe([KEY_REF])
      if (!response.ok || response.value[KEY_REF] === undefined) throw new Error('credential state unavailable')
      return response.value[KEY_REF]
    },
    async save(value) {
      const response = await credentials.set(KEY_REF, value)
      if (!response.ok) throw new Error('credential save failed')
    },
    async remove() {
      const response = await credentials.unset(KEY_REF)
      if (!response.ok) throw new Error('credential removal failed')
    },
    subscribe(listener) {
      return ctx.remote.$on('credentials/reference-updated', (ref: string) => { if (ref === KEY_REF) listener() })
    },
  }
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'openai-images-api',
    order: 20,
    inject: () => face,
  }, OpenAIImagesSettings))
}
