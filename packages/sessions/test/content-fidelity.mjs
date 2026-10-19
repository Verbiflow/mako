import {proposedPlan} from '../dist/entries.js'
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
import {keepCopies} from './fixtures/archive-copies.mjs'
import { NativeStores } from '../dist/read-only-sqlite.js'

const nativeStores = new NativeStores(false)
const root=await mkdtemp(join(tmpdir(),'mako-attachment-final-'))
try {
 const source=join(root,'source.txt');await writeFile(source,'original bytes')
 const ref={harness:'test',nativeId:'test',path:join(root,'native'),bytes:1,cwd:root}
 const fromUrl=attachmentFromUrl('source.txt','text/plain',pathToFileURL(source).href)
 const urlSaved=await persistThreadAttachments({ref,entries:[{type:'user',text:'look',attachments:[fromUrl]}]},join(root,'assets'))
 assert.equal(urlSaved.entries[0].attachments[0].source.kind,'file')
 console.log('PASS local file URL copied')
 const attachment={type:'attachment',id:'asset-1',name:'source.txt',mimeType:'text/plain',source:{kind:'file',path:source}}
 const entries=[{type:'user',text:'look',attachments:[attachment]}]
 // A copy an earlier build kept, its attachment's bytes saved beside it as that build saved them.
 await keepCopies(join(root,'archive'),[await persistThreadAttachments({ref,entries},join(root,'archive','assets'))])
 const archive=new SessionArchive(join(root,'archive'))
 const first=await archive.read(ref.path);const savedPath=first.entries[0].attachments[0].source.path;assert.equal(await readFile(savedPath,'utf8'),'original bytes')
 await rm(source)
 assert.equal((await archive.read(ref.path)).entries[0].attachments[0].source.kind,'file')
 console.log('PASS a kept attachment survives its original\'s deletion')
 await archive.stop()
 const reopened = new SessionArchive(join(root,'archive'))
 await reopened.load()
 const fromDisk = await reopened.read(ref.path)
 assert.equal(fromDisk.entries[0].attachments[0].source.path, savedPath)
 assert.equal(await readFile(savedPath,'utf8'),'original bytes')
 await reopened.stop()
 console.log('PASS archive reopened from disk preserves attachments after original deletion')
 const inline={type:'attachment',name:'image.png',mimeType:'image/png',source:{kind:'inline',data:Buffer.from('test').toString('base64')}}
 const thread={ref,entries:[{type:'user',text:'look',attachments:[inline]},{type:'text',text:'answer'},{type:'attachment',attachment:inline}]}
 for (const [name,emit,provider] of [['claude',emitClaudeSession,(home)=>new ClaudeProvider(home)],['codex',emitCodexSession,(home)=>new CodexProvider(nativeStores,home)],['cursor',emitCursorSession,(home)=>new CursorProvider(nativeStores,home)],['grok',emitGrokSession,(home)=>new GrokProvider(home)]]) {
  const home=join(root,name);const emitted=await emit(nativeStores,thread,{home,cwd:root});const loaded=await provider(home).read(emitted.path)
  assert.equal(loaded.entries.filter(e=>e.type==='user').reduce((n,e)=>n+(e.attachments?.length??0),0),1,name+' user attachment')
  assert.equal(loaded.entries.filter(e=>e.type==='attachment').length,1,name+' assistant attachment')
  assert.equal(JSON.stringify(loaded.entries).includes('<mako-attachments>'),false,name+' envelope hidden')
  console.log('PASS '+name+' user and assistant attachment round trip')
 }
 const input='input-'+ 'x'.repeat(5000)+'-input-tail'
 const output='output-'+ 'y'.repeat(100000)+'-output-tail\n'
 const toolThread={ref,entries:[{type:'user',text:'run the fixture'},{type:'tool',id:'fixture-1',name:'fixture',status:'completed',input,output}]}
 for (const [name,emit,provider] of [['claude',emitClaudeSession,(home)=>new ClaudeProvider(home)],['codex',emitCodexSession,(home)=>new CodexProvider(nativeStores,home)],['cursor',emitCursorSession,(home)=>new CursorProvider(nativeStores,home)],['grok',emitGrokSession,(home)=>new GrokProvider(home)]]) {
  const home=join(root,`payload-${name}`)
  const emitted=await emit(nativeStores,toolThread,{home,cwd:root})
  const loaded=await provider(home).read(emitted.path)
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
 for (const [name,emit,root_] of [['claude',emitClaudeSession,'projects'],['codex',emitCodexSession,'sessions']]) {
  const store=join(root,`account-${name}`)
  const emitted=await emit(nativeStores,thread,{home:join(root,`account-home-${name}`),cwd:root,store})
  assert.ok(emitted.path.startsWith(join(store,root_)),`${name} writes into the account's own store`)
  console.log(`PASS ${name} emits into a moved config root`)
 }
 const content={type:'image',data:Buffer.from('test').toString('base64'),mimeType:'image/png'}
 const devin=join(root,'devin');await mkdir(join(devin,'acp-events'),{recursive:true});const dpath=join(devin,'acp-events','session.ndjson')
 await writeFile(dpath,JSON.stringify({notification:{sessionUpdate:'user_message_chunk',content}})+'\n')
 const d=await new DevinLocalProvider(nativeStores, devin).read(dpath)
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
  ['devin',dpath,new DevinLocalProvider(nativeStores, devin),(update)=>({notification:update})],
  ['grok',gpath,new GrokProvider(root),(update,index)=>({method:'session/update',params:{sessionId:'session',update,_meta:{eventId:`event-${index}`}}})],
 ]) {
  await writeFile(path,toolUpdates.map((update,index)=>JSON.stringify(wrap(update,index))).join('\n')+'\n')
  const loaded=await provider.read(path)
  const tools=loaded.entries.filter(entry=>entry.type==='tool')
  assert.deepEqual(tools.find(tool=>tool.details?.some(detail=>detail.type==='diff')).details,[{type:'diff',path:'/fixture/app.ts',oldText:null,newText:'after'},{type:'terminal',terminalId:'terminal-proof'}])
  assert.ok(loaded.entries.some(entry=>entry.type==='plan'&&entry.entries[0].status==='completed'))
  console.log(`PASS ${name} native ACP diff, terminal, and completed plan`)
 }

 const planCards=(thread)=>thread.entries.filter(entry=>entry.type==='proposed-plan').map(proposedPlan)
 const planFile='/home/me/.devin/plans/plan-1.md'
 const planEdit=(id,body)=>({sessionUpdate:'tool_call',toolCallId:id,title:'Updated plan',kind:'edit',content:[{type:'diff',path:planFile,newText:`---\nagent: devin\n---\n${body}`}],_meta:{'cognition.ai/isPlanFileEdit':true}})
 await writeFile(dpath,[
  {sessionUpdate:'user_message_chunk',content:{type:'text',text:'Plan it'}},
  planEdit('write_plan:1','# Plan\n\nFirst draft'),
  {sessionUpdate:'tool_call_update',toolCallId:'write_plan:1',status:'completed'},
  planEdit('write_plan:2','# Plan\n\nRevised'),
  {sessionUpdate:'tool_call',toolCallId:'exit:3',title:'Exit plan mode',kind:'switch_mode',rawInput:{plan:'Revised'},_meta:{'cognition.ai/isExitPlan':true,'cognition.ai/planFilePath':planFile}},
  {sessionUpdate:'tool_call_update',toolCallId:'exit:3',status:'completed'},
 ].map(update=>JSON.stringify({notification:update})).join('\n')+'\n')
 assert.deepEqual(planCards(await new DevinLocalProvider(nativeStores, devin).read(dpath)),[{type:'proposed-plan',id:'devin:session:write_plan:1',text:'# Plan\n\nRevised',status:'proposed'}])
 const grokTool={'x.ai/tool':{name:'exit_plan_mode'}}
 await writeFile(gpath,[
  {sessionUpdate:'user_message_chunk',content:{type:'text',text:'Plan it'}},
  {sessionUpdate:'tool_call',toolCallId:'call-1',title:'exit_plan_mode',kind:'other',rawInput:{planContent:'model copy'},_meta:grokTool},
  {sessionUpdate:'tool_call_update',toolCallId:'call-1',status:'completed',rawOutput:{type:'ExitPlanMode',PlanReady:{plan_content:'# Plan\n\nAs saved'}},_meta:grokTool},
 ].map((update,index)=>JSON.stringify({method:'session/update',params:{sessionId:'session',update,_meta:{eventId:`event-${index}`}}})).join('\n')+'\n')
 assert.deepEqual(planCards(await new GrokProvider(root).read(gpath)),[{type:'proposed-plan',id:'grok:session:call-1',text:'# Plan\n\nAs saved',status:'proposed'}])
 console.log('PASS Devin and Grok saved plans read as their live cards')

}finally{await rm(root,{recursive:true,force:true})}
