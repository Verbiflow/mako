// Diagnostic: asserts the known defects, not the desired behavior. No provider processes.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { reduceAcpUpdates } from '../../../src/state/acp-reducer.ts'
import { acpBlocksToMessages } from '../../../src/lib/acp-blocks.ts'
import { toExchanges } from '../../../src/lib/exchanges.ts'
import { foldTools } from '../../../src/lib/tools.ts'
import { threadToMessages } from '../../../src/lib/foreign-thread.ts'
const project = (blocks) => toExchanges(foldTools(acpBlocksToMessages(blocks, true, 'codex').messages))
let blocks = []
for (let i = 0; i < 500; i++) blocks.push({type:'user',text:`prompt ${i}`}, {type:'text',text:`answer ${i}`})
const before = project(blocks)
const next = reduceAcpUpdates(blocks, [{kind:'text',text:' token'}])
const after = project(next)
const reusedExchanges = before.slice(0,-1).filter((x,i)=>x===after[i]).length
const reusedMessages = before.slice(0,-1).filter((x,i)=>x.response[0]===after[i].response[0]).length
assert.equal(reusedExchanges,0)
assert.equal(reusedMessages,0)
console.log(JSON.stringify({test:'identity',completedExchanges:499,reusedExchanges,reusedMessages}))
for (const turns of [30,500,5000]) {
 let sample=[]
 for(let i=0;i<turns;i++) sample.push({type:'user',text:`prompt ${i}`},{type:'text',text:`answer ${i}`})
 const start=performance.now()
 for(let i=0;i<1000;i++){ sample=reduceAcpUpdates(sample,[{kind:'text',text:'x'}]); project(sample) }
 console.log(JSON.stringify({test:'projection-only',turns,updates:1000,ms:+(performance.now()-start).toFixed(1)}))
}
const toolBlocks=reduceAcpUpdates([], [{kind:'tool',id:'tool-1',title:'command',status:'in_progress'}, {kind:'tool-update',id:'tool-1',output:'first output'}])
const toolMessages=acpBlocksToMessages(toolBlocks,true,'codex').messages
assert.equal(toolBlocks[0].status,'in_progress')
assert.equal(toolMessages[0].blocks.some(b=>b.type==='toolResult'),true)
console.log(JSON.stringify({test:'partial-tool-output',nativeStatus:toolBlocks[0].status,projectedTypes:toolMessages[0].blocks.map(b=>b.type)}))
const saved=[{kind:'user',text:'new prompt'},{kind:'assistant',blocks:[{type:'text',text:'new answer'}]}]
const live=[{type:'user',text:'new prompt'},{type:'text',text:'new answer'}]
const concatenated=[...toExchanges(foldTools(threadToMessages(saved,0,'codex'))),...project(live)]
assert.equal(concatenated.length,2)
console.log(JSON.stringify({test:'native-live-convergence',expectedExchanges:1,actualExchanges:concatenated.length,prompts:concatenated.map(e=>e.prompt?.blocks[0].text)}))
