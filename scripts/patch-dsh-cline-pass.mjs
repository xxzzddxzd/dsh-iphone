#!/usr/bin/env node
// iOS Safari/WKWebView reports same-origin POST JSON as TypeError: Load failed.
// Upstream 0.2.13 still has the identical relative-fetch transport; the fix is
// not retired. Prefer an absolute panel URL and fall back to XHR on transport
// rejection only, retaining HTTP/business refusals without a second request.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

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
const metadata = JSON.parse(readFileSync(resolve(dirname(file), '../package.json'), 'utf8'))
if (metadata.name !== 'dsh-cline-pass' || metadata.version !== '0.2.13') {
  throw new Error('unsupported Cline Pass package; expected dsh-cline-pass@0.2.13')
}
const patchedCount = text.split(NEW).length - 1
const canonical = patchedCount === 1 ? text.replace(NEW, OLD) : text
const canonicalHash = createHash('sha256').update(canonical).digest('hex')
if (canonicalHash !== '2ad350477e95e15259e70faad425d0877723b2767462e4a468960cbb5293f882') {
  throw new Error('unknown Cline Pass client preimage')
}
if (patchedCount === 1) {
  process.stdout.write(file + ': already patched\n')
  process.exit(0)
}
if (text.split(OLD).length - 1 !== 1 || patchedCount !== 0) {
  console.error(file + ': expected Cline Pass fetch client was not found')
  process.exit(1)
}
writeFileSync(file, text.replace(OLD, NEW))
process.stdout.write(file + ': patched iOS panel transport\n')
