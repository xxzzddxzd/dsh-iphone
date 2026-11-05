import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Images from '../src/index.ts'
class MemoryCredentials extends CredentialProvider { async resolve() {return {value:'test-key',source:'memory'}} }
it('registers independently alongside a preexisting imagegen tool in a real Host composition', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'images-api-host-')); const ctx=new Context()
 try {
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime,{mode:'native'});await ctx.plugin(LocalFileSystem,{cwd:dir});await ctx.plugin(LocalAttachmentStore,{dshHome:dir});await ctx.plugin(LlmRuntime);await ctx.plugin(MemoryCredentials)
  ctx.tools.register(defineTool({name:'imagegen',description:'existing subscription tool',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>({})}))
  await ctx.plugin(Images,{model:'gpt-image-2.6-flare'});expect(ctx.tools.get('imagegen')).toBeDefined();expect(ctx.tools.get('openai_imagegen')).toBeDefined()
 } finally {await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true})}
})
