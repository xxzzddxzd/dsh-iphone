import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.tsx'

describe('OpenAI Images settings contribution', () => {
  it('uses the DSH credential service and exposes no key read operation', async () => {
    const operations = {
      describe: vi.fn().mockResolvedValue({ ok: true, value: { OPENAI_IMAGE_API_KEY: { configured: true, writable: true } } }),
      set: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      unset: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    }
    let injected: (() => { describe: () => Promise<unknown>; save: (value: string) => Promise<void>; remove: () => Promise<void> }) | undefined
    const ctx = {
      remote: { credentials: operations, $on: vi.fn(() => () => undefined) },
      slots: {
        inject: (_slot: string, install: () => void) => install(),
        register: (definition: { inject: typeof injected }) => { injected = definition.inject },
      },
    } as unknown as Context
    apply(ctx)
    expect(inject).toContain('remote.credentials')
    expect(injected).toBeDefined()
    const face = injected!()
    expect(await face.describe()).toEqual({ configured: true, writable: true })
    await face.save('test-key-only')
    await face.remove()
    expect(operations.describe).toHaveBeenCalledWith(['OPENAI_IMAGE_API_KEY'])
    expect(operations.set).toHaveBeenCalledWith('OPENAI_IMAGE_API_KEY', 'test-key-only')
    expect(operations.unset).toHaveBeenCalledWith('OPENAI_IMAGE_API_KEY')
    expect(Object.keys(face).sort()).toEqual(['describe', 'remove', 'save', 'subscribe'])
  })

  it('surfaces a generic error on refused writes', async () => {
    let injected: (() => { save: (value: string) => Promise<void> }) | undefined
    const ctx = {
      remote: { credentials: { set: vi.fn().mockResolvedValue({ ok: false, error: { message: 'sensitive error' } }) } },
      slots: {
        inject: (_slot: string, install: () => void) => install(),
        register: (definition: { inject: typeof injected }) => { injected = definition.inject },
      },
    } as unknown as Context
    apply(ctx)
    await expect(injected!().save('test-key-only')).rejects.toThrow('credential save failed')
  })
})
