import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'

/** The packaged application, actual native questions, trusted UI input and full process restart. */
export async function checkPackagedAsyncQuestions({bridge,command,evaluate,waitFor,conversationId,root,report,restart}) {
  const snapshot=()=>bridge('liveSnapshot',[conversationId])
  const capture=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
  const click=async selector=>{
    const point=await evaluate(`(()=>{const e=${selector};if(!e)throw Error('Question control missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  const select=async()=>{
    const selector=`[data-conversation-id="${conversationId}"]`
    await waitFor(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),Boolean,'async conversation rail row')
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const original=(await snapshot()).session.nativeId
  let prior
  for(const active of [false,true]) {
    const requestId=randomUUID(),title=`Packaged async question ${randomUUID()}`,label=active?'async-active':'async-restart'
    const prompt=active
      ? `Call request_user_input_async with one free-text question titled "${title}". Immediately run sleep 20 using your shell, giving the user time to answer while you work. Afterward, reply with the exact answer phrase from the user. Wait for the answer if needed; do not guess or ask with another tool. Do not modify files.`
      : `Call request_user_input_async with one free-text question titled "${title}". End your turn after the question. When the user answers in a later turn, reply with exactly their answer phrase. Do not use another tool or guess the answer.`
    await bridge('livePrompt',[conversationId,requestId,prompt,[]])
    const pending=await waitFor(snapshot,s=>s?.control?.questions?.some(q=>q.native.questions.some(q=>q.question===title)),'native async question',120000)
    const question=pending.control.questions.find(q=>q.native.questions.some(q=>q.question===title))
    if(!active) {
      await waitFor(snapshot,s=>s?.requests.some(r=>r.id===requestId&&r.status==='completed'),'async turn finished',120000)
      await restart()
      assert.ok((await snapshot()).control.questions.some(q=>q.id===question.id),'Pending question lost across app restart')
    } else await waitFor(snapshot,s=>s?.session.status==='running'&&s.blocks.some(b=>b.type==='tool'&&JSON.stringify(b).includes('sleep 20')),'native active work',120000)
    await select()
    if(prior)await bridge('livePermission',[conversationId,prior.id,prior.response])
    const phrase=`PACKAGE_ASYNC_${randomUUID()}`,response={kind:'answers',answers:{[question.native.questions[0].id]:[phrase]}}
    await waitFor(()=>evaluate("Boolean([...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length))"),Boolean,'async answer form')
    await capture(label+'-pending')
    await click("[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length)")
    await command('Input.insertText',{text:phrase})
    await capture(label+'-draft')
    await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Send answers'&&!e.disabled&&e.getClientRects().length)")
    const final=await waitFor(snapshot,s=>s?.session.status==='ready'&&s.blocks.some(b=>b.type==='text'&&b.text.includes(phrase)),'native async answer',120000)
    assert.equal(final.session.nativeId,original)
    await bridge('livePermission',[conversationId,question.id,response])
    const after=await snapshot()
    assert.equal(active?after.control.actions.filter(a=>a.input.id===question.id).length:after.requests.filter(r=>r.id===question.id).length,1)
    const source=final.session.nativePath??final.control.bindings.find(b=>b.id===question.bindingId)?.path
    assert.ok(source,'Native source required for independent answer count')
    const records=(await readFile(source,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line))
    const nativeAnswers=records.filter(record=>record.type==='event_msg'&&record.payload?.type==='user_message'&&record.payload.message?.includes(phrase))
    assert.equal(nativeAnswers.length,1,'Native store must contain one answer input, not only a local receipt')
    await capture(label+'-completed')
    report.phases.push({phase:label,questionId:question.id,native:question.native,phrase,sameNativeSession:true,nativeAnswerInputs:nativeAnswers.length,operation:active?'steer':'prompt',pendingRestored:!active,staleAnswerProtected:Boolean(prior)})
    prior={id:question.id,response}
  }
  await restart()
  await bridge('livePermission',[conversationId,prior.id,prior.response])
  report.phases.push({phase:'async-answer-repeat-after-restart',passed:true})
}
