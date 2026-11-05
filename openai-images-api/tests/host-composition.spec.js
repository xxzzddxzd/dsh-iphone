import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {CredentialProvider} from '@deepseek-ai/dsh-credentials'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import {LlmRuntime, BlockAssembler} from '@deepseek-ai/dsh-llm'
import ToolRuntime,{defineTool} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Images from '../src/index.ts'
class MemoryCredentials extends CredentialProvider{async resolve(){return {value:'test-key',source:'memory'}}}
it('registers isolated model route but does not expose the paid API as a global tool',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'images-api-host-'));const ctx=new Context()
 try{
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(LocalAttachmentStore,{dshHome:dir});await ctx.plugin(LlmRuntime);await ctx.plugin(MemoryCredentials)
  ctx.tools.register(defineTool({name:'imagegen',description:'existing subscription tool',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>({})}))
  await ctx.plugin(Images);expect(ctx.tools.get('imagegen')).toBeDefined();expect(ctx.tools.get('openai_imagegen')).toBeUndefined()
  const models=await ctx.llm.listModels(Images.IMAGE_PROVIDER);expect(models.map(x=>x.id)).toEqual(['gpt-image-2.6-flare','gpt-image-2.6-sunburst'])
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}))))
  const assembler=new BlockAssembler();const chunks=[]
  for await(const chunk of ctx.llm.stream({provider:Images.IMAGE_PROVIDER,model:'gpt-image-2.6-flare',sessionId:'host-session',messages:[{role:'user',id:'real-user-id',source:{kind:'user'},content:[{type:'text',text:'blue'}]}]})) { chunks.push(chunk);assembler.push(chunk) }
  expect(chunks.at(-1)).toMatchObject({type:'finish',reason:{kind:'stop'}})
  const image=assembler.blocks().find(block=>block.type==='image');expect(image?.attachment.mediaType).toBe('image/png')
  expect((await ctx.attachments.readImage(image.attachment)).data.length).toBeGreaterThan(0)
  const gif=Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIEAgAAAAAAAAAAAAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAAh+QQBFAABACwAAAAAAgACAIH//wAAAAAAAAAAAAAIBgABCAQQEAA7','base64')
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:gif.toString('base64')}]}))))
  const gifAssembler=new BlockAssembler()
  for await(const chunk of ctx.llm.stream({provider:Images.IMAGE_PROVIDER,model:'gpt-image-2.6-flare',sessionId:'host-session',messages:[{role:'user',id:'gif-user-id',source:{kind:'user'},content:[{type:'text',text:'生成 GIF'}]}]})) gifAssembler.push(chunk)
  const text=gifAssembler.blocks().find(block=>block.type==='text')?.text;const encoded=text?.match(/^!\[生成的动图\]\(<(.*)>\)$/)?.[1]
  expect(encoded).toBeDefined();expect(await readFile(decodeURIComponent(encoded))).toEqual(gif)
 }finally{vi.unstubAllGlobals();await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true})}
})
