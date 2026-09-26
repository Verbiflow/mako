// Diagnostic: asserts known defects. Uses synthetic fixtures and mocked transport only.
import assert from 'node:assert/strict'
import { acpStore } from '../../../src/state/acp-state.ts'
import { applyAcpSession, applyAcpUpdates } from '../../../src/state/acp-live.ts'
import { threadsStore } from '../../../src/state/thread-store.ts'
import { applyThreadEntries, viewedThread } from '../../../src/state/thread-viewing.ts'
const ref = {path:'/tmp/synthetic-session',nativeId:'synthetic-id',harness:'codex'}
const session={id:'synthetic-live',harness:'codex',nativeId:ref.nativeId,cwd:'/tmp',status:'running',modes:[],currentMode:null,configOptions:[]}
const live={kind:'live',key:session.id,draftKey:ref.path,harness:'codex',cwd:'/tmp',threadPath:ref.path,blocks:[{type:'user',text:'new prompt'},{type:'text',text:'new answer'}],queued:[],hiddenUserPrompt:null,createdAt:0,updatedAt:0,session,permission:null,sending:false,canceling:false}
acpStore.set({conversations:{[session.id]:live},activeKey:null})
threadsStore.set({viewing:viewedThread({ref,entries:[]})})
applyThreadEntries(ref.path,[{kind:'user',text:'new prompt'},{kind:'assistant',blocks:[{type:'text',text:'new answer'}]}])
assert.equal(threadsStore.get().viewing.entries.length,2)
assert.equal(acpStore.get().conversations[session.id].blocks.length,2)
console.log(JSON.stringify({test:'actual-store-native-live-convergence',savedEntries:2,liveBlocks:2,bothRemain:true}))
applyAcpSession({...session,status:'ready',lastStop:'failed',error:'synthetic provider failure'})
assert.equal(threadsStore.get().attention[ref.path].kind,'review')
console.log(JSON.stringify({test:'provider-turn-failure',actualAttention:threadsStore.get().attention[ref.path].kind,actualStatus:acpStore.get().conversations[session.id].session.status}))
acpStore.set({conversations:{},activeKey:null,bufferedUpdates:{},bufferedPermissions:{}})
applyAcpSession(session)
applyAcpUpdates(session.id,[{kind:'text',text:'ongoing answer'}])
assert.equal(Object.keys(acpStore.get().conversations).length,0)
console.log(JSON.stringify({test:'renderer-reload-live-events',restoredSessions:Object.keys(acpStore.get().conversations).length,bufferedUpdates:acpStore.get().bufferedUpdates[session.id].length}))

process.exit(0)
