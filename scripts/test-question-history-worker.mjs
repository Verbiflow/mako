import assert from 'node:assert/strict'
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {readCodexQuestionHistory} from '../dist-electron/providers/codex/question-reader.js'

const root=await mkdtemp(join(tmpdir(),'mako-question-worker-')),path=join(root,'session.jsonl')
const nativeId=randomUUID(),binding={id:randomUUID(),provider:'codex',path,nativeId}
const meta=JSON.stringify({type:'session_meta',payload:{id:nativeId}})+'\n'
const filler=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(8192)}})+'\n'
const question=JSON.stringify({type:'event_msg',payload:{type:'item_completed',thread_id:nativeId,turn_id:'turn',item:{type:'AgentMessage',id:'question',delivery:'async',questions:[{title:'Which?'}]}}})+'\n'
try{
 await writeFile(path,meta+filler.repeat(5000)+question)
 let ticks=0,maxLag=0,last=performance.now()
 const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last);last=now;ticks++},2)
 const start=performance.now()
 const first=readCodexQuestionHistory(binding),second=readCodexQuestionHistory(binding)
 assert.equal(first,second,'Concurrent native reads coalesce')
 const evidence=await first
 clearInterval(timer)
 assert.equal(evidence.length,1)
 assert.ok(ticks>5,'Large evidence parsing leaves the host event loop responsive')
 const warmStart=performance.now()
 assert.deepEqual(await readCodexQuestionHistory(binding),evidence)
 console.log(JSON.stringify({coldMs:performance.now()-start,warmMs:performance.now()-warmStart,ticks,maxLagMs:maxLag}))
 await appendFile(path,'broken\n')
 await assert.rejects(readCodexQuestionHistory(binding),/unreadable/)
 await writeFile(path,meta+question)
 assert.equal((await readCodexQuestionHistory(binding)).length,1,'Read failures do not poison the worker')
 console.log('PASS question history worker: native reader isolation, concurrency, cache, failure and recovery')
}finally{await rm(root,{recursive:true,force:true})}
