import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

/** Real native question history and the production form, with live question events withheld. */
export async function checkNativeQuestionRetirement({owner,reopen,id,cwd,driver,mode,page,wait,render,capture,events,result}) {
  const answers=()=>events.filter(e=>e.type==='test-answer-prompt'||e.type==='test-answer-steer').length
  const visible=()=>page.executeJavaScript("Boolean([...document.querySelectorAll('fieldset')].find(e=>e.getClientRects().length))")
  const ask=async label=>{
    const request=randomUUID(),title=`Retirement ${label} ${randomUUID()}`
    owner().submit(id,request,`Call request_user_input_async once with one free-text question titled "${title}". End your turn after asking. Do not use other tools or guess the answer.`)
    await wait(s=>s?.requests.some(r=>r.id===request&&r.status==='completed'))
    const snapshot=await owner().refreshedSnapshot(id)
    const question=snapshot.control.questions.find(q=>q.native.questions.some(item=>item.question===title))
    assert.ok(question&&!question.retired)
    await render(snapshot)
    assert.equal(await visible(),true,'A current unanswered question is visible')
    return question
  }
  const original=owner().snapshot(id).session.nativeId
  const first=await ask('local-follow-up')
  await capture('retirement-current-question')
  const input=randomUUID()
  owner().submit(id,input,'Move on from that question. Reply exactly MOVED_ON. Do not ask a question or use tools.')
  await wait(s=>s?.requests.some(r=>r.id===input&&r.status==='completed'))
  let snapshot=await owner().refreshedSnapshot(id)
  assert.equal(snapshot.control.questions.find(q=>q.id===first.id).retired,true)
  assert.equal(snapshot.control.questions.find(q=>q.id===first.id).answered?.length??0,0)
  await render(snapshot);assert.equal(await visible(),false)
  await capture('retirement-after-follow-up')
  await reopen()
  snapshot=await owner().refreshedSnapshot(id)
  assert.equal(snapshot.session.nativeId,original)
  assert.equal(snapshot.control.questions.find(q=>q.id===first.id).retired,true)
  await render(snapshot);assert.equal(await visible(),false)
  await capture('retirement-after-reopen')
  const before=answers()
  await assert.rejects(owner().permission(id,first.id,{kind:'answers',answers:{[first.native.questions[0].id]:['STALE_ANSWER']}}),/no longer available/)
  assert.equal(answers(),before)
  result.cases.push({name:'ordinary-input-retires-question',status:'passed',native:first.native,sameNativeSession:true,answerDispatches:0,retainedAfterReopen:true})

  const external=await ask('external-follow-up')
  await reopen()
  const externalId=randomUUID()
  try {
    const session=await driver.start(cwd,{conversationId:externalId,resume:original,modeId:mode})
    assert.equal(session.nativeId,original)
    const start=events.length
    await driver.prompt(externalId,'Move on from the pending question. Reply exactly EXTERNAL_MOVED_ON. Do not ask another question or use tools.',[],undefined,{operationId:randomUUID(),attemptId:randomUUID(),report(){}})
    const deadline=Date.now()+90000
    while(!events.slice(start).some(e=>e.type==='live-session'&&e.session.id===externalId&&e.session.status==='ready')) {
      const failure=events.slice(start).find(e=>e.type==='live-session'&&e.session.id===externalId&&e.session.status==='failed')
      if(failure)throw Error(failure.session.error)
      if(Date.now()>deadline)throw Error('External continuation did not complete')
      await new Promise(resolve=>setTimeout(resolve,50))
    }
  } finally {await driver.close(externalId)}
  snapshot=await owner().refreshedSnapshot(id)
  assert.equal(snapshot.control.questions.find(q=>q.id===external.id).retired,true,'Native history retires a question after another client moves on')
  await render(snapshot);assert.equal(await visible(),false)
  await capture('retirement-external-history')
  await assert.rejects(owner().permission(id,external.id,{kind:'answers',answers:{[external.native.questions[0].id]:['STALE_EXTERNAL_ANSWER']}}),/no longer available/)
  assert.equal(answers(),before)
  const binding=snapshot.control.bindings.find(b=>b.id===snapshot.control.activeBindingId)
  const evidence=await driver.sessionQuestions.history(binding)
  assert.ok(evidence.find(entry=>entry.question.itemId===external.native.itemId)?.retired)
  result.cases.push({name:'external-input-native-history-retirement',status:'passed',native:external.native,answerDispatches:0,sameNativeSession:true})
}
