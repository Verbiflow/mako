// Diagnostic: asserts known defects. Uses synthetic fixtures and mocked transport only.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CodexProvider} from '../../../packages/sessions/src/providers/codex.ts'
const home=await mkdtemp(join(tmpdir(),'mako-codex-envelope-'))
try{
 const dir=join(home,'.codex','sessions');await mkdir(dir,{recursive:true});const path=join(dir,'rollout-test.jsonl')
 const text='<recommended_plugins>\nlist\n</recommended_plugins>\n\nPlease audit this project.'
 await writeFile(path,[{type:'session_meta',payload:{id:'test',cwd:'/work'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'I will audit.'}]}}].map(JSON.stringify).join('\n')+'\n')
 const thread=await new CodexProvider(home).read(path)
 assert.ok(thread);assert.equal(thread.entries.filter(e=>e.kind==='user').length,0);assert.equal(thread.entries.filter(e=>e.kind==='assistant').length,1)
 console.log('CONFIRMED Codex read removes genuine trailing request after recommended_plugins envelope while retaining its answer')
}finally{await rm(home,{recursive:true,force:true})}
