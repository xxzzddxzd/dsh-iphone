#!/usr/bin/env node
// iOS Safari/WKWebView reports same-origin POST JSON as TypeError: Load failed.
// Prefer an absolute panel URL and fall back to XHR when fetch throws.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: patch-dsh-cline-pass.mjs <client.js>')
  process.exit(1)
}

const OLD = `      async call(endpoint, payload) {
        if (this.ctx.get('connection') === undefined) throw new Error(this.t('panelUnavailable'))
        let response
        try {
          response = await fetch(PANEL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload: payload ?? {} }),
          })
        } catch (error) {
          throw new Error(\`\${this.t('panelUnavailable')} (\${String(error?.message ?? error)})\`)
        }
`

const NEW = `      panelUrl() {
        try {
          if (typeof location !== 'undefined' && location && location.origin) return location.origin + PANEL_PATH
        } catch { /* use the path as-is */ }
        return PANEL_PATH
      }

      postPanel(body) {
        const url = this.panelUrl()
        const xhrPost = () => new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url, true)
          xhr.setRequestHeader('content-type', 'application/json')
          xhr.withCredentials = true
          xhr.onload = () => {
            resolve({
              ok: xhr.status >= 200 && xhr.status < 300,
              status: xhr.status,
              json: async () => JSON.parse(xhr.responseText || 'null'),
            })
          }
          xhr.onerror = () => reject(new Error('Load failed'))
          xhr.send(body)
        })
        if (typeof fetch !== 'function') return xhrPost()
        return fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          credentials: 'include',
          cache: 'no-store',
        }).catch((error) => xhrPost().catch(() => { throw error }))
      }

      async call(endpoint, payload) {
        if (this.ctx.get('connection') === undefined) throw new Error(this.t('panelUnavailable'))
        let response
        try {
          response = await this.postPanel(JSON.stringify({ endpoint, payload: payload ?? {} }))
        } catch (error) {
          throw new Error(\`\${this.t('panelUnavailable')} (\${String(error?.message ?? error)})\`)
        }
`

const text = readFileSync(file, 'utf8')
if (text.includes('postPanel(body)')) {
  process.stdout.write(file + ': already patched\n')
  process.exit(0)
}
if (!text.includes(OLD)) {
  console.error(file + ': expected Cline Pass fetch client was not found')
  process.exit(1)
}
writeFileSync(file, text.replace(OLD, NEW))
process.stdout.write(file + ': patched iOS panel transport\n')
