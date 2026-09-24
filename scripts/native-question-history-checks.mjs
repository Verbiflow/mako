import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'

/** Drop live question events, then recover only real native store evidence. */
export async function checkNativeQuestionHistory({owner,reopen,id,cwd,driver,mode,page,wait,render,capture,events,result}) {
  if(process.env.MAKO_NATIVE_QUESTION_SOURCE_ONLY) {
    const request=randomUUID(),title=`Imported native question ${randomUUID()}`
    owner().submit(id,request,`Call request_user_input_async once with one free-text question titled "${title}". End your turn. When the user answers, reply with exactly their answer phrase. Do not use other tools or guess the answer.`)
    await wait(s=>s?.requests.some(r=>r.id===request&&r.status==='completed'))
    const snapshot=owner().snapshot(id)
    assert.equal(snapshot.control.questions?.length??0,0)
    const binding=snapshot.control.bindings.find(b=>b.id===snapshot.control.activeBindingId)
    const evidence=await driver.sessionQuestions.history(binding)
    assert.ok(evidence.some(e=>e.question.questions.some(q=>q.question===title)&&!e.answered.length))
    result.importSource={path:binding.path,nativeId:binding.nativeId,title}
    result.cases.push({name:'prepare-unobserved-native-source',status:'passed'})
    return
  }
  const calls=()=>events.filter(e=>e.type==='test-answer-prompt'||e.type==='test-answer-steer').length
  const ask=async()=>{
    const request=randomUUID(), title=`History question ${randomUUID()}`
    owner().submit(id,request,`Call request_user_input_async once with one free-text question titled "${title}". End your turn after asking. When answered, reply with exactly the user's answer phrase. Do not use any other tools or guess the answer.`)
    await wait(s=>s?.requests.some(r=>r.id===request&&r.status==='completed'))
    assert.ok(!owner().snapshot(id).control.questions?.some(q=>q.native.questions.some(q=>q.question===title)),'Live events are withheld')
    const snapshot=await owner().refreshedSnapshot(id)
    const group=snapshot.control.questions?.find(q=>q.native.questions.some(q=>q.question===title))
    assert.ok(group,'Native history recovers an unobserved question')
    await render(snapshot)
    return group
  }
  const click=async expression=>{
    const point=await page.executeJavaScript(`(()=>{const e=${expression};if(!e)throw Error('Question control missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  const group=await ask(), phrase=`HISTORY_ANSWER_${randomUUID()}`
  await capture('history-import-pending')
  await click("[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length)")
  await page.debugger.sendCommand('Input.insertText',{text:phrase})
  await capture('history-import-draft')
  const before=calls()
  await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Send answers'&&!e.disabled&&e.getClientRects().length)")
  await wait(s=>s?.session.status==='ready'&&s.blocks.some(b=>b.type==='text'&&b.text.includes(phrase)))
  assert.equal(calls()-before,1)
  const answered=await owner().refreshedSnapshot(id)
  assert.deepEqual(answered.control.questions.find(q=>q.id===group.id).answered,[group.native.questions[0].id])
  await render(answered);await capture('history-import-completed')
  result.cases.push({name:'unobserved-native-question',status:'passed',native:group.native,dispatches:1,phrase})

  const external=await ask(), externalPhrase=`EXTERNAL_ANSWER_${randomUUID()}`
  await capture('history-external-pending')
  await reopen()
  const externalId=randomUUID()
  const text=driver.sessionQuestions.encodeAnswer(external.native,{[external.native.questions[0].id]:[externalPhrase]})
  try {
    const session=await driver.start(cwd,{conversationId:externalId,resume:external.native.sessionId,modeId:mode})
    assert.equal(session.nativeId,external.native.sessionId)
    const eventStart=events.length
    await driver.prompt(externalId,text,[],undefined,{operationId:randomUUID(),attemptId:randomUUID(),report(){}})
    const deadline=Date.now()+90000
    while(!events.slice(eventStart).some(e=>e.type==='live-session'&&e.session.id===externalId&&e.session.status==='ready')) {
      const failed=events.slice(eventStart).find(e=>e.type==='live-session'&&e.session.id===externalId&&e.session.status==='failed')
      if(failed)throw Error(failed.session.error)
      if(Date.now()>deadline)throw Error('External native answer did not finish')
      await new Promise(resolve=>setTimeout(resolve,50))
    }
  } finally {await driver.close(externalId)}
  const stale={kind:'answers',answers:{[external.native.questions[0].id]:['STALE_LOCAL_ANSWER']}}
  const writes=calls()
  await assert.rejects(owner().permission(id,external.id,stale))
  const recovered=owner().snapshot(id)
  assert.deepEqual(recovered.control.questions.find(q=>q.id===external.id).answered,[external.native.questions[0].id])
  assert.equal(calls(),writes,'Catch-up refuses a stale answer without dispatch')
  assert.equal(recovered.requests.some(r=>r.id===external.id),false,'External observation does not fabricate local answer intent')
  await render(recovered);await capture('history-external-reconciled')
  const binding=recovered.control.bindings.find(b=>b.id===recovered.control.activeBindingId)
  const records=(await readFile(binding.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const count=value=>records.filter(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='user'&&JSON.stringify(r.payload.content).includes(value)).length
  assert.equal(count(externalPhrase),1)
  assert.equal(count('STALE_LOCAL_ANSWER'),0)
  assert.ok(records.some(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='assistant'&&r.payload.content.some(c=>c.type==='output_text'&&c.text.includes(externalPhrase))),'Native assistant recalls the external answer')
  result.cases.push({name:'external-answer-during-disconnect',status:'passed',native:external.native,phrase:externalPhrase,nativeUserInputs:1,staleLocalWrites:0,source:binding.path})
}
