import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'

export async function checkPackagedExternalQuestion({app,bridge,command,evaluate,waitFor,conversationId,root,report,restart}) {
  const snapshot=()=>bridge('liveSnapshot',[conversationId])
  const capture=async name=>{const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
  const click=async expression=>{
    const point=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('External-question UI control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  const select=async()=>{
    await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Recent'&&e.getClientRects().length)")
    await waitFor(()=>evaluate(`Boolean(document.querySelector('[data-conversation-id="${conversationId}"]'))`),Boolean,'external question conversation')
    await click(`document.querySelector('[data-conversation-id="${conversationId}"]')`)
  }
  const title=`External answer ${randomUUID()}`,request=randomUUID()
  await bridge('livePrompt',[conversationId,request,`Call request_user_input_async once with one free-text question titled "${title}". End your turn after asking. When answered, reply with exactly the user's answer phrase. Do not guess or use other tools.`,[]])
  const asked=await waitFor(snapshot,s=>s?.requests.some(r=>r.id===request&&r.status==='completed')&&s.control.questions?.some(q=>q.native.questions.some(item=>item.question===title)),'external native question',120000)
  const group=asked.control.questions.find(q=>q.native.questions.some(item=>item.question===title))
  await select()
  await waitFor(()=>evaluate("[...document.querySelectorAll('fieldset')].some(e=>e.getClientRects().length)"),Boolean,'pending external form')
  await capture('external-pending')
  await bridge('liveClose',[conversationId])
  const phrase=`EXTERNAL_${randomUUID()}`,input=join(root,'external-input.json'),launcher=join(root,'external-launcher')
  await mkdir(launcher)
  await writeFile(join(launcher,'package.json'),JSON.stringify({main:resolve('scripts/external-native-question-answer.mjs')}))
  await writeFile(input,JSON.stringify({app,root,cwd:asked.session.cwd,question:group.native,answers:{[group.native.questions[0].id]:[phrase]}}))
  const env={...process.env,MAKO_EXTERNAL_QUESTION_INPUT:input};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(resolve('node_modules/.bin/electron'),[launcher],{env,stdio:['ignore','pipe','pipe']})
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output+=data})
  const timer=setTimeout(()=>child.kill('SIGTERM'),150000)
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer))
  await writeFile(join(root,'external-controller.log'),output)
  assert.equal(code,0,output)
  assert.equal(JSON.parse(await readFile(join(root,'external-controller.json'),'utf8')).completed,true)
  await restart();await select()
  await assert.rejects(bridge('livePermission',[conversationId,group.id,{kind:'answers',answers:{[group.native.questions[0].id]:['STALE_EXTERNAL_ANSWER']}}]))
  const recovered=await snapshot(),question=recovered.control.questions.find(q=>q.id===group.id)
  assert.deepEqual(question.answered,[group.native.questions[0].id])
  assert.equal(recovered.requests.some(r=>r.id===group.id),false)
  await waitFor(()=>evaluate("![...document.querySelectorAll('fieldset')].some(e=>e.getClientRects().length)"),Boolean,'reconciled external form')
  await capture('external-reconciled')
  const binding=recovered.control.bindings.find(b=>b.id===group.bindingId)
  const records=(await readFile(binding.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const inputs=value=>records.filter(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='user'&&JSON.stringify(r.payload.content).includes(value))
  assert.equal(inputs(phrase).length,1)
  assert.equal(inputs('STALE_EXTERNAL_ANSWER').length,0)
  assert.ok(records.some(r=>r.type==='response_item'&&r.payload.type==='message'&&r.payload.role==='assistant'&&JSON.stringify(r.payload.content).includes(phrase)))
  report.phases.push({phase:'external-answer-reconciliation',native:group.native,nativeAnswerInputs:1,staleLocalInputs:0,localAnswerReceipt:false,sameNativeSession:true})
}
