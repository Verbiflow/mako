import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'

/** Import an actual native question that this packaged profile has never observed. */
export async function checkPackagedQuestionHistory({bridge,command,evaluate,waitFor,root,report,restart,source}) {
  const readyAtCapture=(await bridge('threads',[])).ready
  const captureStarted=performance.now()
  const imported=await bridge('liveCapture',[randomUUID(),source])
  const captureMs=performance.now()-captureStarted
  const readyAfterCapture=(await bridge('threads',[])).ready
  const id=imported.session.id, question=imported.control.questions.find(q=>q.native.questions.some(item=>!q.answered?.includes(item.id)))
  assert.ok(question,'Native capture must import an unanswered question')
  const snapshot=()=>bridge('liveSnapshot',[id])
  const capture=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
  const click=async selector=>{
    const point=await evaluate(`(()=>{const e=${selector};if(!e)throw Error('Import control missing');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  await restart()
  assert.equal((await snapshot()).control.questions.find(q=>q.id===question.id)?.native.itemId,question.native.itemId)
  await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Recent'&&e.getClientRects().length)")
  const selector=`[data-conversation-id="${id}"], [data-flip-key=${JSON.stringify(source)}]`
  await waitFor(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),Boolean,'imported native history row')
  await click(`document.querySelector(${JSON.stringify(selector)})`)
  await waitFor(()=>evaluate("Boolean([...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length))"),Boolean,'imported native question form')
  await capture('history-import-pending')
  const phrase=`PACKAGED_HISTORY_${randomUUID()}`
  await click("[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length)")
  await command('Input.insertText',{text:phrase})
  await capture('history-import-draft')
  await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Send answers'&&!e.disabled&&e.getClientRects().length)")
  const final=await waitFor(snapshot,s=>s?.session.status==='ready'&&[
    ...s.blocks,...(s.base?.entries??[]).filter(e=>e.kind==='assistant').flatMap(e=>e.blocks),
  ].some(b=>b.type==='text'&&b.text.includes(phrase)),'imported native answer',120000)
  assert.equal(final.session.nativeId,imported.session.nativeId)
  assert.ok(final.control.questions.find(q=>q.id===question.id).answered.includes(question.native.questions[0].id))
  await capture('history-import-completed')
  const response={kind:'answers',answers:{[question.native.questions[0].id]:[phrase]}}
  await restart()
  await bridge('livePermission',[id,question.id,response])
  const records=(await readFile(source,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const count=records.filter(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='user'&&JSON.stringify(r.payload.content).includes(phrase)).length
  assert.equal(count,1)
  report.phases.push({phase:'native-history-import',readyAtCapture,readyAfterCapture,captureMs:Math.round(captureMs),questionId:question.id,native:question.native,phrase,sameNativeSession:true,nativeAnswerInputs:count,pendingRestored:true,duplicateAfterRestart:true})
}
