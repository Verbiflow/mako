import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'

/** Ask natively, move on through the actual composer, then restart the packaged app. */
export async function checkPackagedQuestionRetirement({bridge,command,evaluate,waitFor,conversationId,root,report,restart}) {
  const snapshot=()=>bridge('liveSnapshot',[conversationId])
  const capture=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
  const click=async selector=>{
    const point=await evaluate(`(()=>{const e=${selector};if(!e)throw Error('Question retirement control missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  const select=async()=>{
    await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Recent'&&e.getClientRects().length)")
    const selector=`[data-conversation-id="${conversationId}"]`
    await waitFor(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),Boolean,'retirement conversation row')
    await click(`document.querySelector(${JSON.stringify(selector)})`)
  }
  const request=randomUUID(),title=`Packaged retirement ${randomUUID()}`
  await bridge('livePrompt',[conversationId,request,`Call request_user_input_async once with one free-text question titled "${title}". End your turn after asking. Do not use other tools or guess the answer.`,[]])
  const pending=await waitFor(snapshot,s=>s?.requests.some(r=>r.id===request&&r.status==='completed')&&s.control?.questions?.some(q=>q.native.questions.some(item=>item.question===title)),'native question',120000)
  const question=pending.control.questions.find(q=>q.native.questions.some(item=>item.question===title))
  await select()
  await waitFor(()=>evaluate("Boolean([...document.querySelectorAll('fieldset')].find(e=>e.getClientRects().length))"),Boolean,'current native question form')
  await capture('retirement-pending')
  const text='Move on from that question. Reply exactly MOVED_ON_IN_PACKAGED_UI. Do not ask questions or use tools.'
  await click("document.querySelector('.composer-input')")
  await command('Input.insertText',{text})
  await capture('retirement-follow-up-draft')
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  const completed=await waitFor(snapshot,s=>s?.requests.some(r=>r.text===text&&r.status==='completed'),'ordinary composer follow-up',120000)
  assert.equal(completed.control.questions.find(q=>q.id===question.id).retired,true)
  await waitFor(()=>evaluate("![...document.querySelectorAll('fieldset')].some(e=>e.getClientRects().length)"),Boolean,'old form removed')
  await capture('retirement-completed')
  await restart();await select()
  const reopened=await snapshot()
  assert.equal(reopened.session.nativeId,pending.session.nativeId)
  assert.equal(reopened.control.questions.find(q=>q.id===question.id).retired,true)
  assert.equal(reopened.control.questions.find(q=>q.id===question.id).answered?.length??0,0)
  assert.equal(await evaluate("[...document.querySelectorAll('fieldset')].some(e=>e.getClientRects().length)"),false)
  await capture('retirement-restarted')
  await assert.rejects(bridge('livePermission',[conversationId,question.id,{kind:'answers',answers:{[question.native.questions[0].id]:['STALE_PACKAGED_ANSWER']}}]))
  assert.equal((await snapshot()).requests.some(r=>r.id===question.id),false)
  report.phases.push({phase:'native-question-retirement',native:question.native,composerFollowUp:true,retiredAfterRestart:true,staleAnswerDispatched:false,sameNativeSession:true})
}
