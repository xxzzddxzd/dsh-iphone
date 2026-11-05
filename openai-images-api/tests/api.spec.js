import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIImagesApiClient, GENERATIONS_URL, EDITS_URL, imagegenTool, apply } from '../src/index.ts'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal
const result = () => new Response(JSON.stringify({data: [{b64_json: png.toString('base64')}]}), {status:200})
afterEach(() => vi.unstubAllGlobals())
describe('standalone OpenAI Images API', () => {
 it('uses the fixed endpoint and resolves the credential on every generation', async () => {
  const resolve=vi.fn().mockResolvedValueOnce({value:'test-key-one'}).mockResolvedValueOnce({value:'test-key-two'})
  const fetch=vi.fn().mockImplementation(async()=>result());vi.stubGlobal('fetch',fetch)
  const client=new OpenAIImagesApiClient({resolve}, 'OPENAI_IMAGE_API_KEY', 'gpt-image-2.6-flare')
  expect(Buffer.from(await client.generate('blue', [], signal))).toEqual(png)
  await client.generate('red', [], signal)
  expect(fetch.mock.calls[0][0]).toBe(GENERATIONS_URL)
  expect(fetch.mock.calls[0][1].redirect).toBe('error')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({model:'gpt-image-2.6-flare',prompt:'blue'})
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer test-key-two')
  expect(resolve).toHaveBeenCalledTimes(2)
 })
 it('uses multipart image[] references and selected Sunburst model', async()=>{
  const fetch=vi.fn().mockImplementation(async()=>result());vi.stubGlobal('fetch',fetch)
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'test-key'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-sunburst')
  await client.generate('edit',[`data:image/png;base64,${png.toString('base64')}`],signal)
  const [url,options]=fetch.mock.calls[0];expect(url).toBe(EDITS_URL);expect(options.body.get('model')).toBe('gpt-image-2.6-sunburst');expect(options.body.get('image[]').type).toBe('image/png');expect(options.headers['content-type']).toBeUndefined()
 })
 it('rejects unknown models, missing keys, malformed response and redacts upstream error bodies',async()=>{
  expect(()=>new OpenAIImagesApiClient({},'OPENAI_IMAGE_API_KEY','made-up')).toThrow()
  await expect(new OpenAIImagesApiClient({resolve:async()=>undefined},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare').generate('x',[],signal)).rejects.toThrow('not configured')
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'test-secret'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('test-secret',{status:401})).mockResolvedValueOnce(new Response('{"data":[{"b64_json":"!!"}]}')))
  await expect(client.generate('x',[],signal)).rejects.toThrow('HTTP 401')
  await expect(client.generate('x',[],signal)).rejects.toThrow('malformed')
 })
 it('registers a distinct tool and saves inline and workspace attachments', async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>result()))
  const target={displayPath:'/workspace/result.png'}
  const ctx={credentials:{resolve:async()=>({value:'test-key'})},llm:{resolveModelInfo:async()=>({inputModalities:['image']})},attachments:{saveImage:async()=>({attachmentId:'a',mediaType:'image/png',bytes:png.length,width:1,height:1}),imageLimits:{maxImageBytes:10000,maxMessageImageBytes:10000}},fs:{resolve:async()=>target,fileUrl:()=> 'sftp://host/workspace/result.png',writeBytes:vi.fn().mockResolvedValue({operation:'create',version:'v1',bytes:png.length})},waterfall:async()=>({kind:'createIfAbsent'}),emit:vi.fn(),get:()=>undefined,tools:{register:vi.fn()}}
  const config={model:'gpt-image-2.6-flare'}; apply(ctx,config);expect(ctx.tools.register.mock.calls[0][0].name).toBe('openai_imagegen')
  const tool=imagegenTool(ctx,config);const value=await tool.execute({prompt:'test',output_path:'result.png'},{signal,agent:{options:{provider:'test',model:'test'},session:{requestHeader:()=>undefined,header:{cwd:'/workspace'}}}})
  expect(value.image.attachmentId).toBe('a');expect(value.file.operation).toBe('create');expect(ctx.fs.writeBytes).toHaveBeenCalledOnce();expect(tool.output.render({},value)[1].type).toBe('image')
 })
})

describe('integration safety', () => {
 const fakeCtx = () => {
  const ref={displayPath:'/workspace/input.png'}; const output={displayPath:'/workspace/out.png'}
  const ctx={credentials:{resolve:vi.fn(async()=>({value:'private-test-key'}))},llm:{resolveModelInfo:async()=>({inputModalities:['image']})},attachments:{saveImage:vi.fn(async()=>({attachmentId:'a',mediaType:'image/png',bytes:png.length,width:1,height:1})),validateImage:vi.fn(),imageLimits:{maxImageBytes:10000,maxMessageImageBytes:10000}},fs:{resolve:vi.fn(async path=>path==='input.png'?ref:output),stat:vi.fn(async()=>({type:'file',version:'input-v1'})),readBytes:vi.fn(async()=>png),fileUrl:()=> 'sftp://host/workspace/out.png',writeBytes:vi.fn(async()=>({operation:'create',version:'out-v1',bytes:png.length}))},waterfall:vi.fn(async()=>({kind:'createIfAbsent'})),emit:vi.fn(),get:()=>undefined}
  const exec={signal,agent:{options:{provider:'p',model:'m'},session:{requestHeader:()=>undefined,header:{cwd:'/workspace'}}}};return {ctx,exec}
 }
 it('passes AbortSignal, refuses redirects, and never echoes malformed upstream body containing secrets',async()=>{
  const controller=new AbortController();const fetch=vi.fn(async(_url,opts)=>{expect(opts.signal.aborted).toBe(false);return new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('cancelled'))) )});vi.stubGlobal('fetch',fetch)
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'private-test-key'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
  const pending=client.generate('x',[],controller.signal);await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());controller.abort();await expect(pending).rejects.toThrow();expect(fetch.mock.calls[0][1].redirect).toBe('error')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('private-test-key not JSON')))
  await expect(client.generate('x',[],signal)).rejects.toThrow('invalid JSON')
 })
 it('resolves and validates reference images, then submits multipart edit with write intent',async()=>{
  const {ctx,exec}=fakeCtx();const fetch=vi.fn(async()=>result());vi.stubGlobal('fetch',fetch)
  const tool=imagegenTool(ctx,{model:'gpt-image-2.6-flare'});const value=await tool.execute({prompt:'edit',referenced_image_paths:['input.png'],output_path:'out.png'},exec)
  expect(ctx.fs.resolve).toHaveBeenCalledWith('input.png',{cwd:'/workspace',signal});expect(ctx.fs.readBytes).toHaveBeenCalled();expect(ctx.attachments.validateImage).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toBe(EDITS_URL);expect(fetch.mock.calls[0][1].body.getAll('image[]')).toHaveLength(1)
  expect(ctx.waterfall).toHaveBeenCalledWith('fs/write-intent',expect.anything(),exec,expect.any(Function));expect(ctx.fs.writeBytes.mock.calls[0][2]).toEqual({kind:'createIfAbsent'});expect(value.file.path).toBe('/workspace/out.png')
 })
 it('does not write around a denied write intent; preserves attachment and reports failure',async()=>{
  const {ctx,exec}=fakeCtx();ctx.waterfall=vi.fn(async()=>{throw new Error('write denied')});vi.stubGlobal('fetch',vi.fn(async()=>result()))
  const value=await imagegenTool(ctx,{model:'gpt-image-2.6-flare'}).execute({prompt:'generate',output_path:'out.png'},exec)
  expect(ctx.fs.writeBytes).not.toHaveBeenCalled();expect(value.file).toBeUndefined();expect(value.writeError).toContain('write denied');expect(value.image.attachmentId).toBe('a')
 })
 it('rejects oversized responses before consuming them and blocks unsupported input types',async()=>{
  const client=new OpenAIImagesApiClient({resolve:async()=>({value:'private-test-key'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
  const fetch=vi.fn(async()=>new Response('{}',{headers:{'content-length':String(33*1024*1024)}}));vi.stubGlobal('fetch',fetch)
  await expect(client.generate('x',[],signal)).rejects.toThrow('size limit')
  await expect(client.generate('x',['data:image/gif;base64,YQ=='],signal)).rejects.toThrow('PNG, JPEG, or WebP');expect(fetch).toHaveBeenCalledTimes(1)
 })
})

it('never exposes malformed keys or credential and network error internals',async()=>{
 const fakeKey='sk-project-FAKE-SECRET\nDO-NOT-PRINT'
 const noNetwork=vi.fn();vi.stubGlobal('fetch',noNetwork)
 const invalid=new OpenAIImagesApiClient({resolve:async()=>({value:fakeKey})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
 let message='';try{await invalid.generate('x',[],signal)}catch(e){message=e.message};expect(message).toBe('OpenAI API key contains invalid characters');expect(message).not.toContain(fakeKey);expect(noNetwork).not.toHaveBeenCalled()
 const brokenStore=new OpenAIImagesApiClient({resolve:async()=>{throw new Error(fakeKey)}},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
 try{await brokenStore.generate('x',[],signal)}catch(e){message=e.message};expect(message).toBe('OpenAI API credential service failed');expect(message).not.toContain(fakeKey)
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error(fakeKey)}))
 const brokenNetwork=new OpenAIImagesApiClient({resolve:async()=>({value:'test-valid-key'})},'OPENAI_IMAGE_API_KEY','gpt-image-2.6-flare')
 try{await brokenNetwork.generate('x',[],signal)}catch(e){message=e.message};expect(message).toBe('OpenAI Images API network request failed');expect(message).not.toContain(fakeKey)
})

it('permits the explicitly selected model per tool call without changing the default',async()=>{
 const fetch=vi.fn(async()=>result());vi.stubGlobal('fetch',fetch)
 const ctx={credentials:{resolve:async()=>({value:'test-key'})},llm:{resolveModelInfo:async()=>({inputModalities:['image']})},attachments:{saveImage:async()=>({attachmentId:'a',mediaType:'image/png',bytes:png.length,width:1,height:1})},fs:{resolve:async()=>{throw new Error('no write')}},get:()=>undefined}
 const exec={signal,agent:{options:{provider:'p',model:'m'},session:{requestHeader:()=>undefined,header:{cwd:'/tmp'}}}}
 const tool=imagegenTool(ctx,{model:'gpt-image-2.6-flare'});await tool.execute({prompt:'x',model:'gpt-image-2.6-sunburst'},exec);await tool.execute({prompt:'y'},exec)
 expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('gpt-image-2.6-sunburst');expect(JSON.parse(fetch.mock.calls[1][1].body).model).toBe('gpt-image-2.6-flare')
})
