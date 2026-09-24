import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { codexAsyncQuestion, codexQuestionAnswer, codexAnsweredQuestions } from "../electron/providers/codex/questions.js"
import { pendingQuestion } from "../electron/contracts/live-questions.js"
import { parseNotification } from "../electron/codex-app-parse.js"

const root = mkdtempSync(join(tmpdir(), "mako-session-questions-"))
const native = codexAsyncQuestion("native", "turn-1", "item-1", [{ title: "Which?", options: ["One", "Two"] }])
const decoded = parseNotification("item/completed", {threadId:"native",turnId:"turn-1",item:{type:"agentMessage",id:"item-1",text:"Which?",delivery:"async",questions:[{title:"Which?",options:null}]}})
assert.ok(decoded?.method === "item/completed" && decoded.item.type === "agentMessage" && decoded.item.questions?.length === 1)
assert.equal(codexAnsweredQuestions("native", "ordinary prose").length, 0)
assert.deepEqual(codexAnsweredQuestions("native",codexQuestionAnswer(native,{[native.questions[0]!.id]:["Two"]})),[{sessionId:"native",itemId:"item-1",questionIds:[native.questions[0]!.id]}])
try {
  for (const provider of ["claude","codex","cursor","grok","devin","opencode","future"]) {
    const id = randomUUID(), path = join(root,provider+".native"), journals = join(root,provider)
    writeFileSync(path,"native")
    let state: LiveSessionState = {id,harness:provider,cwd:root,nativeId:"native",nativePath:path,status:"ready",connection:"connected",modes:[],currentMode:null,configOptions:[]}
    let prompts=0, steers=0
    let throwSteer=false, refuseSteer=false
    const driver: ProviderLiveDriver = {
      provider, approvalEvidence:{kind:"submission-only",reason:"Fixture"}, canResume:true, available:()=>true,
      sessionQuestions:{encodeAnswer:codexQuestionAnswer}, steering:"step",
      start:async()=>{state={...state,status:"ready",connection:"connected"};return state},
      prompt:async(_id,text,_attachments,_settings,dispatch)=>{
        prompts++
        const saved = new LiveJournal(journals,id)
        try { assert.ok(saved.read()?.requests.some(r=>r.text===text&&r.status==='dispatching'),"Answer intent precedes provider write") } finally {saved.close()}
        state={...state,status:"running",nativeRunId:randomUUID()}
        owner.observe({type:"live-session",session:state})
        dispatch.report({kind:"accepted",source:"native-response",referenceId:state.nativeRunId})
      },
      steer:async()=>{steers++;if(throwSteer)throw Error("Lost reply");return refuseSteer ? {kind:"not-accepted",reason:"Turn ended"} : {kind:"accepted"}},
      permission:async()=>{throw Error("Session question must never use approval callbacks")},
      close(){},cancel:async()=>{},setMode:async()=>{},
    }
    const deps={root:journals,appPath:root,driver:()=>driver,history:async()=>null,emit:()=>{},checkpoint:async()=>"same",resumeVerdict:async()=>({kind:"resumable" as const,record:"same" as const})}
    let owner = new LiveConversations(deps)
    try {
      await owner.start(provider,root,{conversationId:id})
      for(let i=0;i<100&&owner.snapshot(id)?.session.connection!=="connected";i++)await delay(5)
      const ask=(turnId:string,itemId:string)=>{
        owner.observe({type:"live-question",id,question:codexAsyncQuestion("native",turnId,itemId,[{title:"Which?",options:["One","Two"]}])})
        return owner.snapshot(id)!.control!.questions!.at(-1)!
      }
      const first=ask("turn-1","item-1")
      assert.equal(ask("turn-1","item-1").id,first.id,"Replay preserves occurrence identity")
      state={...state,status:"running"};owner.observe({type:"live-session",session:state})
      state={...state,status:"ready"};owner.observe({type:"live-session",session:state})
      assert.equal(owner.snapshot(id)!.control!.questions!.length,1,"Turn end preserves unanswered questions")
      const response={kind:"answers" as const,answers:{[native.questions[0]!.id]:["Two"]}}
      await assert.rejects(owner.permission(id,first.id,{kind:"answers",answers:{wrong:["Two"]}}),/Complete/)
      const disk=mock.method(LiveJournal.prototype,"commit",()=>{throw Error("disk full")})
      await assert.rejects(owner.permission(id,first.id,response),/disk full/)
      disk.mock.restore()
      assert.equal(prompts,0)
      await Promise.all([owner.permission(id,first.id,response),owner.permission(id,first.id,response)])
      for(let i=0;i<100&&!prompts;i++)await delay(5)
      assert.equal(prompts,1,"Concurrent clients send one answer")
      await assert.rejects(owner.permission(id,first.id,{kind:"answers",answers:{[native.questions[0]!.id]:["One"]}}),/different/)
      const second=ask("turn-2","item-2")
      const secondResponse={kind:"answers" as const,answers:{[second.native.questions[0]!.id]:["Two"]}}
      await owner.permission(id,first.id,response)
      assert.equal(prompts,1)
      throwSteer=true
      await owner.permission(id,second.id,secondResponse)
      assert.equal(steers,1)
      assert.equal(owner.snapshot(id)!.control!.actions!.at(-1)!.state.kind,"uncertain")
      await owner.permission(id,second.id,secondResponse)
      assert.equal(steers,1,"Lost steering reply is never resent")
      const third=ask("turn-3","item-3")
      owner.observe({type:"live-question-answered",id,answer:{sessionId:"native",itemId:"item-1",questionIds:[native.questions[0]!.id]}})
      assert.ok(pendingQuestion(third,owner.snapshot(id)!.control!,owner.snapshot(id)!.requests),"Old native evidence preserves newer question")
      await owner.permission(id,third.id,{kind:"choice",optionId:null})
      assert.ok(ask("turn-3","item-3").dismissed,"Native replay cannot undo dismissal")
      const reused=ask("turn-reused","item-1")
      owner.observe({type:"live-question-answered",id,answer:{sessionId:"native",itemId:"item-1",questionIds:[native.questions[0]!.id]}})
      assert.equal(owner.snapshot(id)!.control!.questions!.find(q=>q.id===reused.id)?.answered,undefined,"Ambiguous item reuse cannot settle a newer turn")
      const multi=codexAsyncQuestion("native","turn-multi","item-multi",[{title:"First?"},{title:"Second?"}])
      owner.observe({type:"live-question",id,question:multi})
      const multiGroup=owner.snapshot(id)!.control!.questions!.at(-1)!
      owner.observe({type:"live-question-answered",id,answer:{sessionId:"native",itemId:"item-multi",questionIds:[multi.questions[0]!.id]}})
      let current=owner.snapshot(id)!
      assert.ok(pendingQuestion(current.control!.questions!.find(q=>q.id===multiGroup.id)!,current.control!,current.requests),"Partial native answers preserve remaining questions")
      owner.observe({type:"live-question-answered",id,answer:{sessionId:"native",itemId:"item-multi",questionIds:[multi.questions[1]!.id]}})
      current=owner.snapshot(id)!
      assert.equal(pendingQuestion(current.control!.questions!.find(q=>q.id===multiGroup.id)!,current.control!,current.requests),false)
      await owner.acknowledgeAction(id,second.id)
      throwSteer=false;refuseSteer=true
      const refused=ask("turn-refused","item-refused")
      const refusedResponse={kind:"answers" as const,answers:{[refused.native.questions[0]!.id]:["Two"]}}
      await owner.permission(id,refused.id,refusedResponse)
      assert.equal(steers,2)
      assert.equal(owner.snapshot(id)!.requests.find(request=>request.id===refused.id)?.status,"queued","Proven refused steering keeps a durable queued answer")
      state={...state,status:"ready"};owner.observe({type:"live-session",session:state})
      for(let i=0;i<100&&prompts<2;i++)await delay(5)
      assert.equal(prompts,2,"Refused steering continues once as a new turn")
      await owner.permission(id,refused.id,refusedResponse)
      assert.equal(prompts,2);assert.equal(steers,2)
      const pending=ask("turn-4","item-4")
      owner.stop();owner=new LiveConversations(deps)
      const restored=owner.snapshot(id)!
      assert.ok(restored.control!.questions!.some(q=>q.id===pending.id))
      assert.ok(restored.control!.questions!.find(q=>q.id===third.id)?.dismissed)
      await owner.permission(id,first.id,response)
      await owner.permission(id,second.id,secondResponse)
      assert.equal(prompts,2);assert.equal(steers,2)
    } finally {owner.stop()}
  }
  console.log("Session questions: all-six + future fixtures preserve lifetime, durable one-write answers, lost-reply fences, stale evidence and dismissal/reopen")
} finally {rmSync(root,{recursive:true,force:true})}
