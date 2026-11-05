import {afterEach, expect, it, vi} from 'vitest'
import {OpenAIImageModelAdapter, IMAGE_PROVIDER, wantsAnimatedGif, gifFrameCount} from '../src/index.ts'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64')
const imageRef={attachmentId:'image-id',mediaType:'image/png',bytes:png.length,width:1,height:1}
const gif=Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIEAgAAAAAAAAAAAAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIH//wAAAAAAAAAAAAAIBgABCAQQEAA7','base64')
const user=(text,id='user-1',extra=[])=>({role:'user',id,source:{kind:'user'},content:[{type:'text',text},...extra]})
const injected=kind=>({role:'user',id:`ctx-${kind}`,source:{kind},content:[{type:'text',text:`PRIVATE ${kind}`}]})
const options=(messages=[user('blue')],extra={})=>({provider:IMAGE_PROVIDER,model:'gpt-image-2.6-flare',sessionId:'session-1',messages,...extra})
const make=()=>{const ctx={credentials:{resolve:vi.fn(async()=>({value:'test-key'}))},attachments:{imageLimits:{maxImageBytes:20*1024*1024},readImage:vi.fn(async()=>({ref:imageRef,data:png})),saveImage:vi.fn(async()=>imageRef),saveFile:vi.fn(async input=>({attachmentId:'gif-id',name:input.name,bytes:input.data.length})),fileHostPath:vi.fn(()=>'/Users/my name (x)/attachments/a#b/generated.gif')}};return {ctx,adapter:new OpenAIImageModelAdapter(ctx)}}
const collect=async gen=>{const xs=[];for await(const x of gen)xs.push(x);return xs}
const response=()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}))
afterEach(()=>vi.unstubAllGlobals())
it('advertises two image models and disables retries',async()=>{const {adapter}=make();expect((await adapter.listModels(IMAGE_PROVIDER)).map(x=>x.id)).toEqual(['gpt-image-2.6-flare','gpt-image-2.6-sunburst']);expect(adapter.providerRetryPolicy().maxRetries).toBe(0);await expect(adapter.resolveModel(IMAGE_PROVIDER,'fake')).rejects.toThrow()})
it('only sends current real user prompt, emits a durable assistant image and ignores trailing passive context',async()=>{
 const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);const {ctx,adapter}=make()
 const history=[user('OLD USER PROMPT','old'),{role:'assistant',content:[{type:'text',text:'OLD ANSWER'}]},user('new prompt','now'),...['runtime-context','time-context','agent-instructions','session-reference','tmux-context'].map(injected)]
 const chunks=await collect(adapter.stream(options(history,{model:'gpt-image-2.6-sunburst'})));const body=JSON.parse(fetch.mock.calls[0][1].body)
 expect(body.prompt).toBe('new prompt');expect(body.model).toBe('gpt-image-2.6-sunburst');expect(JSON.stringify(body)).not.toContain('PRIVATE');expect(JSON.stringify(body)).not.toContain('OLD')
 expect(ctx.attachments.saveImage).toHaveBeenCalledOnce();expect(chunks[1]).toMatchObject({type:'block-end',block:{type:'image',attachment:imageRef}});expect(chunks.at(-1).reason.kind).toBe('stop')
})
it('uses only explicitly attached images in the current user message; prior images are never read',async()=>{
 const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);const {ctx,adapter}=make()
 const current=user('edit','new',[{type:'image',attachment:imageRef}]);await collect(adapter.stream(options([user('old','old',[{type:'image',attachment:{...imageRef,attachmentId:'old'}}]),current])))
 expect(ctx.attachments.readImage).toHaveBeenCalledTimes(1);expect(ctx.attachments.readImage.mock.calls[0][0].attachmentId).toBe('image-id');expect(fetch.mock.calls[0][0]).toContain('/images/edits');expect(fetch.mock.calls[0][1].body.getAll('image[]')).toHaveLength(1)
})
it('rejects offloaded image references and arbitrary non-image attachments before fetch',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const {ctx,adapter}=make()
 await expect(collect(adapter.stream(options([user('edit','one',[{type:'image',attachment:imageRef,offloaded:true}])])))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 await expect(collect(adapter.stream(options([user('edit','two',[{type:'file',attachment:{}}])])))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 expect(ctx.attachments.readImage).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})
it('rejects automatic continuations, unknown plugin sources, missing sessions, assistant and tool followups',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const {adapter}=make()
 for(const tail of [injected('dsh-purge'),injected('unknown-plugin'),{role:'assistant',content:[]},{role:'tool',content:[] }])
  await expect(collect(adapter.stream(options([user('blue'),tail])))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 await expect(collect(adapter.stream(options([user('blue')],{sessionId:undefined})))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 await expect(collect(adapter.stream(options([injected('runtime-context')])))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 expect(fetch).not.toHaveBeenCalled()
})
it('never calls API for auto-title, compaction, or repeated dispatch for the same user message',async()=>{
 const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);const {adapter}=make()
 const title=await collect(adapter.stream(options([user('blue')],{purpose:'session-title'})));expect(title.find(x=>x.type==='text-delta').text).toBe('图片生成')
 await expect(collect(adapter.stream(options([user('blue')],{purpose:'compaction'})))).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(fetch).not.toHaveBeenCalled()
 await collect(adapter.stream(options([user('blue')])));await expect(collect(adapter.stream(options([user('blue')])))).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(fetch).toHaveBeenCalledOnce()
 await collect(adapter.stream(options([user('blue','user-2')])));expect(fetch).toHaveBeenCalledTimes(2)
})
it('classifies network failures as terminal even if API response is unknown, without leaking internals',async()=>{
 const fetch=vi.fn(async()=>{throw Error('synthetic private key')});vi.stubGlobal('fetch',fetch);const {adapter}=make()
 try{await collect(adapter.stream(options()))}catch(error){expect(error.code).toBe('INVALID_REQUEST');expect(error.message).not.toContain('synthetic private key');expect(error.message).toContain('may have been billed')}
 expect(fetch).toHaveBeenCalledOnce()
})
it('detects explicit GIF intent without interpreting explicit negation as animation',()=>{
 expect(wantsAnimatedGif('将这张图做成 GIF')).toBe(true);expect(wantsAnimatedGif('生成动图')).toBe(true)
 expect(wantsAnimatedGif('不要 GIF，只要静态图')).toBe(false);expect(wantsAnimatedGif('不用做成GIF')).toBe(false)
 expect(wantsAnimatedGif('no gif')).toBe(false);expect(wantsAnimatedGif('不要太阳，做个GIF')).toBe(true)
})
it('requests default GIF edit frames, saves original bytes, and safely escapes its trusted attachment path',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:gif.toString('base64')}]})));vi.stubGlobal('fetch',fetch)
 const {ctx,adapter}=make();const chunks=await collect(adapter.stream(options([user('将这张图做成 GIF','gif-user',[{type:'image',attachment:imageRef}])])));const form=fetch.mock.calls[0][1].body
 expect(fetch.mock.calls[0][0]).toContain('/images/edits');expect(form.get('output_format')).toBe('gif');expect(form.get('frame_count')).toBe('16');expect(form.get('frame_duration_ms')).toBe('100')
 expect(gifFrameCount(gif)).toBe(4);expect(ctx.attachments.saveFile).toHaveBeenCalledOnce();expect(Buffer.from(ctx.attachments.saveFile.mock.calls[0][0].data)).toEqual(gif)
 expect(ctx.attachments.saveImage).not.toHaveBeenCalled();expect(chunks.find(x=>x.type==='text-delta').text).toBe('![生成的动图](</Users/my%20name%20%28x%29/attachments/a%23b/generated.gif>)')
})
it('rejects invalid GIF timing before resolving credentials, reading images or sending a paid request',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const {ctx,adapter}=make()
 for(const [i,text] of ['做成 GIF，17帧','生成 GIF，每帧19毫秒','生成 GIF，12帧和13帧'].entries()){
  await expect(collect(adapter.stream(options([user(text,`invalid-${i}`,[{type:'image',attachment:imageRef}])])))).rejects.toMatchObject({code:'INVALID_REQUEST',message:expect.stringContaining('请求未发送')})
 }
 expect(ctx.credentials.resolve).not.toHaveBeenCalled();expect(ctx.attachments.readImage).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})
it('never represents static or corrupt API output as an animated GIF',async()=>{
 const fetch=vi.fn(async()=>response());vi.stubGlobal('fetch',fetch);const {ctx,adapter}=make()
 await expect(collect(adapter.stream(options([user('生成GIF')])))).rejects.toMatchObject({code:'INVALID_REQUEST'})
 expect(ctx.attachments.saveFile).not.toHaveBeenCalled();expect(ctx.attachments.saveImage).not.toHaveBeenCalled();expect(gifFrameCount(gif.subarray(0,gif.length-3))).toBe(0)
})
