import {DevinLocalProvider} from '../dist/providers/devin-local.js'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
import {persistThreadAttachments} from '../dist/attachment-storage.js'
import {attachmentFromUrl} from '../dist/content.js'
import {SessionArchive} from '../dist/archive.js'
import {emitClaudeSession,emitCodexSession,emitCursorSession,emitGrokSession} from '../dist/emit.js'
import {ClaudeProvider} from '../dist/providers/claude.js'
import {CodexProvider} from '../dist/providers/codex.js'
import {CursorProvider} from '../dist/providers/cursor.js'
import {GrokProvider} from '../dist/providers/grok.js'
const root=await mkdtemp(join(tmpdir(),'mako-attachment-final-'))
try {
 const source=join(root,'source.txt');await writeFile(source,'original bytes')
 const ref={harness:'test',nativeId:'test',path:join(root,'native'),bytes:1,cwd:root}
 const fromUrl=attachmentFromUrl('source.txt','text/plain',pathToFileURL(source).href)
 const urlSaved=await persistThreadAttachments({ref,entries:[{kind:'user',text:'look',attachments:[fromUrl]}]},join(root,'assets'))
 assert.equal(urlSaved.entries[0].attachments[0].source.kind,'file')
 console.log('PASS local file URL copied')
 const attachment={type:'attachment',id:'asset-1',name:'source.txt',mimeType:'text/plain',source:{kind:'file',path:source}}
 const entries=[{kind:'user',text:'look',attachments:[attachment]}]
 const archive=new SessionArchive(join(root,'archive'));archive.note(ref,async()=>({ref,entries}));await archive.flush()
 const first=await archive.read(ref.path);const savedPath=first.entries[0].attachments[0].source.path;assert.equal(await readFile(savedPath,'utf8'),'original bytes')
 await rm(source)
 const next={...ref,bytes:2};archive.note(next,async()=>({ref:next,entries:[...entries,{kind:'assistant',blocks:[{type:'text',text:'done'}]}]}));await archive.flush()
 assert.equal((await archive.read(ref.path)).entries[0].attachments[0].source.kind,'file')
 console.log('PASS retained attachment survives original deletion plus later capture')
 await archive.stop()
 const reopened = new SessionArchive(join(root,'archive'))
 await reopened.load()
 const fromDisk = await reopened.read(ref.path)
 assert.equal(fromDisk.entries[0].attachments[0].source.path, savedPath)
 assert.equal(await readFile(savedPath,'utf8'),'original bytes')
 await reopened.stop()
 console.log('PASS archive reopened from disk preserves attachments after original deletion')
 const inline={type:'attachment',name:'image.png',mimeType:'image/png',source:{kind:'inline',data:Buffer.from('test').toString('base64')}}
 const thread={ref,entries:[{kind:'user',text:'look',attachments:[inline]},{kind:'assistant',blocks:[{type:'text',text:'answer'},inline]}]}
 for (const [name,emit,Provider] of [['claude',emitClaudeSession,ClaudeProvider],['codex',emitCodexSession,CodexProvider],['cursor',emitCursorSession,CursorProvider],['grok',emitGrokSession,GrokProvider]]) {
  const home=join(root,name);const emitted=await emit(thread,{home,cwd:root});const loaded=await new Provider(home).read(emitted.path)
  assert.equal(loaded.entries.filter(e=>e.kind==='user').reduce((n,e)=>n+(e.attachments?.length??0),0),1,name+' user attachment')
  assert.equal(loaded.entries.filter(e=>e.kind==='assistant').flatMap(e=>e.blocks).filter(b=>b.type==='attachment').length,1,name+' assistant attachment')
  assert.equal(JSON.stringify(loaded.entries).includes('<mako-attachments>'),false,name+' envelope hidden')
  console.log('PASS '+name+' user and assistant attachment round trip')
 }
 const input='input-'+ 'x'.repeat(5000)+'-input-tail'
 const output='output-'+ 'y'.repeat(100000)+'-output-tail\n'
 const toolThread={ref,entries:[{kind:'user',text:'run the fixture'},{kind:'assistant',blocks:[{type:'tool',name:'fixture',input,output}]}]}
 for (const [name,emit,Provider] of [['claude',emitClaudeSession,ClaudeProvider],['codex',emitCodexSession,CodexProvider],['cursor',emitCursorSession,CursorProvider],['grok',emitGrokSession,GrokProvider]]) {
  const home=join(root,`payload-${name}`)
  const emitted=await emit(toolThread,{home,cwd:root})
  const loaded=await new Provider(home).read(emitted.path)
  const text=JSON.stringify(loaded.entries)
  for(const payload of [input,output]) {
   const digest=createHash('sha256').update(payload).digest('hex')
   const path=join(home,'.mako','native-import-artifacts',`${digest}.txt`)
   assert.equal(await readFile(path,'utf8'),payload)
   assert.ok(text.includes(path),`${name} retains an exact reference to the complete tool payload`)
  }
  assert.equal(text.includes('[truncated]'),false)
  console.log(`PASS ${name} complete large tool input/output sidecars`)
 }
 const content={type:'image',data:Buffer.from('test').toString('base64'),mimeType:'image/png'}
 const devin=join(root,'devin');await mkdir(join(devin,'acp-events'),{recursive:true});const dpath=join(devin,'acp-events','session.ndjson')
 await writeFile(dpath,JSON.stringify({notification:{sessionUpdate:'user_message_chunk',content}})+'\n')
 const d=await new DevinLocalProvider(devin).read(dpath)
 assert.equal(d.entries[0]?.attachments?.[0]?.source.data,content.data)
 const grok=join(root,'.grok','sessions','project','session');await mkdir(grok,{recursive:true});await writeFile(join(grok,'summary.json'),JSON.stringify({info:{id:'session',cwd:root},session_summary:'Image request'}));const gpath=join(grok,'updates.jsonl')
 await writeFile(gpath,JSON.stringify({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'user_message_chunk',content}}})+'\n')
 const g=await new GrokProvider(root).read(gpath)
 assert.equal(g.entries[0]?.attachments?.[0]?.source.data,content.data)
 console.log('PASS Devin and Grok native image-only prompts')

 const toolUpdates=[
  {sessionUpdate:'user_message_chunk',content:{type:'text',text:'Edit the file'}},
  {sessionUpdate:'tool_call',toolCallId:'edit',title:'Edit',status:'in_progress'},
  {sessionUpdate:'tool_call_update',toolCallId:'edit',status:'completed',content:[{type:'diff',path:'/fixture/app.ts',newText:'after'},{type:'terminal',terminalId:'terminal-proof'}]},
  {sessionUpdate:'plan',entries:[{content:'Edit the file',status:'completed',priority:'medium'}]},
 ]
 for (const [name,path,provider,wrap] of [
  ['devin',dpath,new DevinLocalProvider(devin),(update)=>({notification:update})],
  ['grok',gpath,new GrokProvider(root),(update)=>({method:'session/update',params:{sessionId:'session',update}})],
 ]) {
  await writeFile(path,toolUpdates.map(update=>JSON.stringify(wrap(update))).join('\n')+'\n')
  const loaded=await provider.read(path)
  const tools=loaded.entries.filter(entry=>entry.kind==='assistant').flatMap(entry=>entry.blocks).filter(block=>block.type==='tool')
  assert.deepEqual(tools.find(tool=>tool.details?.some(detail=>detail.type==='diff')).details,[{type:'diff',path:'/fixture/app.ts',oldText:null,newText:'after'},{type:'terminal',terminalId:'terminal-proof'}])
  assert.ok(tools.some(tool=>tool.details?.some(detail=>detail.type==='plan'&&detail.entries[0].status==='completed')))
  console.log(`PASS ${name} native ACP diff, terminal, and completed plan`)
 }

}finally{await rm(root,{recursive:true,force:true})}
