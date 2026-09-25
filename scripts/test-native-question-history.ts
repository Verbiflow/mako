import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { NativeQuestionHistory } from "../electron/contracts/live-questions.js"
import { latestPendingQuestion } from "../electron/contracts/live-questions.js"
import { codexAsyncQuestion, codexQuestionAnswer } from "../electron/providers/codex/questions.js"
import { createCodexQuestionHistory } from "../electron/providers/codex/question-history.js"

const root = await mkdtemp(join(tmpdir(), "mako-native-question-history-"))
const native = "native-question-history"
const meta = JSON.stringify({type:"session_meta",payload:{id:native}})+"\n"
const question = (item:string, turn=item) => JSON.stringify({type:"event_msg",payload:{type:"item_completed",thread_id:native,turn_id:turn,item:{type:"AgentMessage",id:item,delivery:"async",questions:[{title:item},{title:"Second"}]}}})+"\n"
const reply = (item:string) => JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:codexQuestionAnswer(codexAsyncQuestion(native,item,item,[{title:item},{title:"Second"}]),{[JSON.stringify(["request_user_input_async",item,0])]:["One"],[JSON.stringify(["request_user_input_async",item,1])]:["Two"]})}]}})+"\n"
try {
  const path=join(root,"native.jsonl"), binding={id:randomUUID(),provider:"codex",nativeId:native,path}
  const history=createCodexQuestionHistory()
  await writeFile(path,meta+question("first")+reply("first")+question("newer"))
  let source=await history(binding)
  assert.equal(source.length,2)
  assert.equal(source[0]!.answered.length,2)
  assert.equal(source[1]!.answered.length,0)
  source[1]!.answered.push("mutated-client-copy")
  assert.equal((await history(binding))[1]!.answered.length,0,"Cache cannot be mutated by a consumer")
  await appendFile(path,reply("newer"))
  assert.equal((await history(binding))[1]!.answered.length,2,"Append reads reconcile external answers")
  await appendFile(path,question("unfinished").slice(0,-1))
  await assert.rejects(history(binding),/still changing/)
  await appendFile(path,"\n")
  assert.equal((await history(binding)).length,3,"Torn source does not poison the cached prefix")
  await writeFile(path,meta+question("replacement"))
  assert.equal((await history(binding))[0]!.question.itemId,"replacement","Truncation resets the source")
  await writeFile(path+".next",meta+question("replaced-inode"))
  await rename(path+".next",path)
  assert.equal((await history(binding))[0]!.question.itemId,"replaced-inode")
  await assert.rejects(history({...binding,nativeId:"wrong-session"}))
  await writeFile(path,meta+question("same","old-turn")+reply("same")+question("same","new-turn")+reply("same"))
  source=await history(binding)
  assert.equal(source[0]!.answered.length,2)
  assert.equal(source[1]!.answered.length,0,"Reused item identity cannot retire a newer question")
  await writeFile(path,meta+question("only-prose")+JSON.stringify({type:"event_msg",payload:{type:"agent_message",message:reply("only-prose")}})+"\n")
  assert.equal((await history(binding))[0]!.answered.length,0,"Quoted answer prose is not native answer evidence")
  await appendFile(path,'{"type":"event_msg","payload":{"type":"item_completed"}}\n')
  await assert.rejects(history(binding),/invalid completed item/)
  await writeFile(path,meta+question("mixed"))
  const mixed=JSON.parse(reply("mixed"))
  mixed.payload.content.push({type:"input_image",image_url:"data:image/png;base64,fixture"})
  await appendFile(path,JSON.stringify(mixed)+"\n")
  assert.equal((await history(binding))[0]!.answered.length,2,"Native answers can include image attachments")
  await appendFile(path,'broken native record\n')
  await assert.rejects(history(binding),/unreadable record/,"Malformed non-question lines cannot certify complete evidence")
  const largeQuestion=JSON.parse(question("large-question"))
  largeQuestion.payload.item.questions[0].title="x".repeat(5*1024*1024)
  await writeFile(path,meta+JSON.stringify(largeQuestion)+"\n")
  assert.equal((await history(binding))[0]!.question.questions[0]!.question.length,5*1024*1024,"Cache budgets do not reject valid question evidence")

  // Ordinary committed input retires presentation; metadata and exact answers do not.
  const committed = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", thread_id: native, turn_id: "next-turn", item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text }] } } }) + "\n"
  await writeFile(path, meta + question("left-behind") + JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>injected context</environment_context>" }] } }) + "\n")
  assert.equal((await history(binding))[0]!.retired, undefined, "Injected context is not user continuation evidence")
  await appendFile(path, committed("Move on to the next task"))
  source = await history(binding)
  assert.equal(source[0]!.retired, true)
  assert.equal(source[0]!.answered.length, 0, "Retirement does not invent a native answer")
  await appendFile(path, question("current-a") + question("current-b") + committed(codexQuestionAnswer(codexAsyncQuestion(native, "current-b", "current-b", [{ title: "current-b" }, { title: "Second" }]), { [JSON.stringify(["request_user_input_async", "current-b", 0])]: ["One"], [JSON.stringify(["request_user_input_async", "current-b", 1])]: ["Two"] })))
  source = await history(binding)
  assert.equal(source[1]!.retired, undefined, "An exact answer preserves other questions")
  assert.equal(source[2]!.answered.length, 2)
  await appendFile(path, question("left-behind"))
  assert.equal((await history(binding))[0]!.retired, true, "Native item replay cannot undo retirement")
  assert.equal((await createCodexQuestionHistory()(binding))[0]!.retired, true, "Cold reconstruction preserves the same retirement")

  // The host consumes one capability, with no provider-name branches.
  for(const provider of ["claude","codex","cursor","grok","devin","opencode","future"]) {
    const id=randomUUID(), journals=join(root,provider)
    const first=codexAsyncQuestion(native,"first","first",[{title:"First?"}])
    const newer=codexAsyncQuestion(native,"newer","newer",[{title:"Newer?"}])
    let evidence:NativeQuestionHistory=[{question:first,answered:[]}]
    let unavailable=false, writes=0
    let gate:Promise<void>|undefined
    const driver:ProviderLiveDriver={provider,available:()=>true,canResume:true,approvalEvidence:{kind:"submission-only",reason:"Fixture"},sessionQuestions:{encodeAnswer:codexQuestionAnswer,history:async()=>{if(gate)await gate;if(unavailable)throw Error("Unavailable source");return evidence}},start:async()=>{throw Error("Unexpected launch")},prompt:async()=>{writes++},permission:async()=>{writes++},cancel:async()=>{},close(){},setMode:async()=>{}}
    const deps={root:journals,appPath:root,driver:()=>driver,emit(){},history:async()=>({ref:{harness:provider,nativeId:native,path},entries:[],start:0,total:0,hasEarlier:false,checkpoint:1})}
    let owner=new LiveConversations(deps)
    try {
      let snapshot=await owner.capture(id,path)
      const saved=snapshot.control!.questions![0]!
      assert.equal(saved.native.itemId,"first","Import discovers a question never observed live")
      assert.equal(writes,0)
      evidence=[{question:first,answered:[first.questions[0]!.id]},{question:newer,answered:[]}]
      snapshot=(await owner.refreshedSnapshot(id))!
      assert.equal(latestPendingQuestion(snapshot.control!,snapshot.requests)?.native.itemId,"newer")
      assert.equal(snapshot.control!.questions![0]!.id,saved.id,"Catch-up preserves durable identity")
      evidence.unshift({question:codexAsyncQuestion(native,"older","older",[{title:"Older?"}]),answered:[]})
      snapshot=(await owner.refreshedSnapshot(id))!
      assert.equal(latestPendingQuestion(snapshot.control!,snapshot.requests)?.native.itemId,"newer","An imported older question cannot jump ahead of the latest")
      await assert.rejects(owner.permission(id,saved.id,{kind:"answers",answers:{[first.questions[0]!.id]:["stale"]}}))
      assert.equal(writes,0,"External answer prevents resending")
      const next=snapshot.control!.questions!.find(q=>q.native.itemId==="newer")!
      unavailable=true
      await assert.rejects(owner.permission(id,next.id,{kind:"answers",answers:{[newer.questions[0]!.id]:["unsafe"]}}),/Unavailable/)
      assert.equal(writes,0)
      await owner.permission(id,next.id,{kind:"choice",optionId:null})
      unavailable=false
      owner.stop();owner=new LiveConversations(deps)
      snapshot=(await owner.refreshedSnapshot(id))!
      assert.ok(snapshot.control!.questions!.find(q=>q.id===next.id)?.dismissed,"Native reload preserves dismissal")
      assert.equal(latestPendingQuestion(snapshot.control!,snapshot.requests)?.native.itemId,"older")
      evidence = evidence.map(entry => ({ ...entry, retired: true }))
      snapshot = (await owner.refreshedSnapshot(id))!
      assert.equal(latestPendingQuestion(snapshot.control!, snapshot.requests), undefined, "Native continuation retires imported historical prompts")
      evidence = evidence.map(({ retired: _retired, ...entry }) => entry)
      owner.stop(); owner = new LiveConversations(deps)
      snapshot = (await owner.refreshedSnapshot(id))!
      assert.equal(latestPendingQuestion(snapshot.control!, snapshot.requests), undefined, "Old evidence cannot reverse persisted retirement")
      evidence=[{question:{...newer,sessionId:"wrong"},answered:[]}]
      snapshot=(await owner.refreshedSnapshot(id))!
      assert.equal(snapshot.control!.questions!.length,3,"Mismatched session cannot import evidence")
      let release!:()=>void
      gate=new Promise(resolve=>{release=resolve})
      evidence=[{question:codexAsyncQuestion(native,"late","late",[{title:"Late?"}]),answered:[]}]
      const reading=owner.refreshedSnapshot(id)
      await owner.close(id)
      release()
      await reading
      assert.equal(owner.snapshot(id)!.control!.questions!.length,3,"A source read from an older owner generation cannot publish")
    } finally {owner.stop()}
  }
  // Read a large history once; unchanged and appended reads use the cache.
  const filler=JSON.stringify({type:"response_item",payload:{type:"function_call_output",output:"x".repeat(8192)}})+"\n"
  await writeFile(path,meta+filler.repeat(5000)+question("large"))
  const timing=[]
  for(const phase of ["cold","warm","append"]) {
    if(phase==="append")await appendFile(path,reply("large"))
    const start=performance.now();source=await history(binding)
    timing.push({phase,ms:Number((performance.now()-start).toFixed(2))})
  }
  assert.equal(source[0]!.answered.length,2)
  console.log(JSON.stringify({bytes:(await readFile(path)).length,timing}))
  console.log("PASS native question history: all-six/future host contract, import, external answers, dismissal/reopen, identity, incomplete reads, source replacement and incremental cache")
} finally {await rm(root,{recursive:true,force:true})}
