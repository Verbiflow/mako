import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

/** Real provider + production question form. No fabricated native observations. */
export async function checkAsyncQuestions({owner, reopen, id, page, wait, render, capture, events, result}) {
  const calls = () => events.filter(event => event.type === 'test-answer-prompt' || event.type === 'test-answer-steer').length
  let prior
  for (const active of [false, true]) {
    const label = active ? 'async-active' : 'async-idle-reconnect'
    const requestId = randomUUID()
    const title = `Verification phrase ${randomUUID()}`
    const prompt = active
      ? `Call request_user_input_async now with exactly one free-text question titled "${title}". Then immediately call your shell tool to run sleep 20 once, so the user can answer while you are working. After that, continue waiting for the user's answer if it has not arrived. When the answer arrives, reply with exactly the answer phrase. Do not guess it or ask using another tool. This is a disposable session test; do not modify files.`
      : `Call request_user_input_async now with exactly one free-text question titled "${title}". End your turn after asking. When the user answers in a later turn, reply with exactly that answer phrase. Do not guess the answer, call request_user_input, or use any other tools.`
    owner().submit(id, requestId, prompt)
    const asked = await wait(s => s?.control?.questions?.some(q => q.native.questions.some(q=>q.question===title)))
    const group = asked.control.questions.find(q=>q.native.questions.some(q=>q.question===title))
    assert.equal(group.native.questions.length,1)
    if (!active) {
      await wait(s=>s?.requests.some(r=>r.id===requestId&&r.status==='completed'))
      await reopen()
      assert.ok(owner().snapshot(id).control.questions.some(q=>q.id===group.id),'Pending question survives owner replacement')
      await render(owner().snapshot(id))
    } else {
      await wait(s=>s?.session.status==='running' && s.blocks.some(b=>b.type==='tool'&&JSON.stringify(b).includes('sleep 20')))
    }
    const questionId=group.native.questions[0].id
    const phrase=`ASYNC_ANSWER_${randomUUID()}`
    const response={kind:'answers',answers:{[questionId]:[phrase]}}
    if(prior) {
      const before=calls()
      await owner().permission(id,prior.id,prior.response)
      assert.equal(calls(),before,'Old answer must never replay')
      assert.ok(owner().snapshot(id).control.questions.some(q=>q.id===group.id&&!q.dismissed),'Old answer preserves the newer question')
    }
    await capture(label+'-pending')
    const point = await page.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length);if(!e)throw Error('Async question input missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
    await page.debugger.sendCommand('Input.insertText',{text:phrase})
    await capture(label+'-draft')
    const before=calls()
    const send=await page.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Send answers'&&!e.disabled&&e.getClientRects().length);if(!e)throw Error('Async send button missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...send})
    const finished=await wait(s=>s?.session.status==='ready'&&s.blocks.some(b=>b.type==='text'&&b.text.includes(phrase)))
    assert.equal(calls()-before,1,'Exactly one native answer write')
    assert.equal(finished.session.nativeId,asked.session.nativeId,'Answer continues the same native session')
    assert.ok(active ? finished.control.actions.some(a=>a.input.id===group.id&&a.state.kind==='accepted') : finished.requests.some(r=>r.id===group.id&&r.status==='completed'))
    await owner().permission(id,group.id,response)
    assert.equal(calls()-before,1,'Duplicate answer does not redispatch')
    await render(finished)
    await capture(label+'-completed')
    result.cases.push({name:label,status:'passed',native:group.native,questionId:group.id,phrase,dispatches:1,sameSession:true,staleAnswerProtected:Boolean(prior),operation:active?'steer':'prompt',pendingRestored:!active})
    prior={id:group.id,response}
  }
  await reopen()
  const count=calls()
  await owner().permission(id,prior.id,prior.response)
  assert.equal(calls(),count,'Reconnect does not replay an already answered question')
  result.asyncQuestionsPassed=true
}
