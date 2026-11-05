import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIImagesApiClient, GENERATIONS_URL, EDITS_URL } from '../src/index.ts'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal
const response = () => new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}))
afterEach(()=>vi.unstubAllGlobals())
describe('OpenAI Images API boundary',()=>{
 it('uses a fixed endpoint, no redirects, app attribution and a fresh credential per request',async()=>{
  const resolve=vi.fn().mockResolvedValueOnce({value:'test-key-one'}).mockResolvedValueOnce({value:'test-key-two'})
  const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch)
  const client=new OpenAIImagesApiClient({resolve},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
  expect(Buffer.from(await client.generate('blue',[],signal))).toEqual(png);await client.generate('red',[],signal)
  expect(fetch.mock.calls[0][0]).toBe(GENERATIONS_URL);expect(fetch.mock.calls[0][1].redirect).toBe('error')
  expect(fetch.mock.calls[0][1].headers['user-agent']).toContain('deepseek-harness/')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({model:'gpt-image-2.6-flare',prompt:'blue'})
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer test-key-two');expect(resolve).toHaveBeenCalledTimes(2)
 })
 it('sends explicit PNG references to the edit endpoint using selected Sunburst',async()=>{
  const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch)
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'test-key'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-sunburst')
  await client.generate('edit',[`data:image/png;base64,${png.toString('base64')}`],signal)
  const [url,options]=fetch.mock.calls[0];expect(url).toBe(EDITS_URL);expect(options.body.get('model')).toBe('gpt-image-2.6-sunburst');expect(options.body.get('image[]').type).toBe('image/png')
 })
 it('rejects unknown models, missing and malformed keys without leaking secrets',async()=>{
  expect(()=>new OpenAIImagesApiClient({},'OPENAI_IMAGE_API_KEY','invalid')).toThrow()
  await expect(new OpenAIImagesApiClient({resolve:async()=>undefined},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare').generate('x',[],signal)).rejects.toThrow('not configured')
  const secret='sk-fake-secret\nDO-NOT-PRINT';const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
  await expect(new OpenAIImagesApiClient({resolve:async()=>({value:secret})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare').generate('x',[],signal)).rejects.toThrow('invalid characters');expect(fetch).not.toHaveBeenCalled()
  await expect(new OpenAIImagesApiClient({resolve:async()=>{throw Error(secret)}},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare').generate('x',[],signal)).rejects.toThrow('credential service failed')
 })
 it('redacts network errors and upstream bodies, caps response size and honors cancellation',async()=>{
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'test-secret'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
  vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(Error('test-secret')).mockResolvedValueOnce(new Response('test-secret',{status:401})).mockResolvedValueOnce(new Response('{}',{headers:{'content-length':String(33*1024*1024)}})))
  await expect(client.generate('x',[],signal)).rejects.toThrow('network request failed');await expect(client.generate('x',[],signal)).rejects.toThrow('HTTP 401');await expect(client.generate('x',[],signal)).rejects.toThrow('size limit')
  const controller=new AbortController();vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>new Promise((_r,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('abort'))))))
  const pending=client.generate('x',[],controller.signal);await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());controller.abort();await expect(pending).rejects.toThrow()
 })
})
