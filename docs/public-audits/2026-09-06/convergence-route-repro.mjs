// Diagnostic: asserts known defects. Uses synthetic fixtures and mocked transport only.
import assert from 'node:assert/strict'
import { acp, acpStore, activeAcp } from '../../../src/state/acp.ts'
import { applyAcpSession, applyAcpUpdates } from '../../../src/state/acp-live.ts'
import { threadsStore } from '../../../src/state/thread-store.ts'
import { applyThreadEntries, threadViewingActions } from '../../../src/state/thread-viewing.ts'
import { acpBlocksToMessages } from '../../../src/lib/acp-blocks.ts'
import { threadToMessages } from '../../../src/lib/foreign-thread.ts'
import { toExchanges } from '../../../src/lib/exchanges.ts'
import { foldTools } from '../../../src/lib/tools.ts'
async function main(){
const ref={path:'/tmp/synthetic-native-session',nativeId:'native-id',harness:'codex',cwd:'/tmp',bytes:0}
const state={id:'codex-app-synthetic',nativeId:ref.nativeId,harness:'codex',cwd:'/tmp',status:'ready',modes:[],currentMode:null,configOptions:[]}
const calls=[]
globalThis.window={mako:{
 async pageThread(){calls.push('pageThread');return {ref,entries:[],start:0,total:0,hasEarlier:false}},
 async threadRun(){return null},
 async followThread(path){calls.push('followThread:'+path)},
 async unfollowThread(){calls.push('unfollowThread')},
 async acpStart(harness,cwd,options){calls.push('acpStart:'+options.resume);return state},
 async acpPrompt(id,text){
  calls.push('acpPrompt')
  applyAcpSession({...state,status:'running'})
  applyAcpUpdates(id,[{kind:'user',text},{kind:'text',text:'synthetic answer'}])
 },
}}
await threadViewingActions.view(ref)
assert.equal(threadsStore.get().viewing.ref.path,ref.path)
assert.equal(await acp.resumeAndSend(ref,'synthetic prompt'),true)
assert.equal(threadsStore.get().viewing.ref.path,ref.path)
assert.equal(activeAcp(acpStore.get()).threadPath,ref.path)
assert.equal(calls.includes('unfollowThread'),false)
applyThreadEntries(ref.path,[{kind:'user',text:'synthetic prompt'},{kind:'assistant',blocks:[{type:'text',text:'synthetic answer'}]}])
const viewed=threadsStore.get().viewing
const active=activeAcp(acpStore.get())
const historyExchanges=toExchanges(foldTools(threadToMessages(viewed.entries.filter(entry=>entry.kind!=='user'||entry.echo!==true),viewed.pageStart,viewed.ref.harness)))
const liveExchanges=toExchanges(foldTools(acpBlocksToMessages(active.blocks,true,active.harness).messages))
const rendered=[...historyExchanges,...liveExchanges]
assert.equal(rendered.length,2)
assert.equal(rendered[0].prompt.blocks[0].text,rendered[1].prompt.blocks[0].text)
console.log(JSON.stringify({calls,viewingPath:viewed.ref.path,liveThreadPath:active.threadPath,acpPanelSelected:Boolean(active&&viewed.ref.path===active.threadPath),renderedExchangeCount:rendered.length,prompts:rendered.map(e=>e.prompt.blocks[0].text)}))
process.exit(0)
}
main().catch(error=>{console.error(error);process.exit(1)})
