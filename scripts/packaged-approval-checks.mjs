import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real installed host and renderer; every allowed command targets this fixture. */
export async function checkPackagedApprovals({ bridge, command, evaluate, waitFor, answer, conversationId, workspace, root, report }) {
  const initial = await bridge('liveSnapshot', [conversationId])
  const access = process.env.MAKO_PACKAGE_APPROVAL_ACCESS ?? 'ask'
  const mode = initial.session.modes.find(item => item.access === access)
  assert.ok(mode, `This runtime does not advertise the requested access tier: ${access}`)
  // Explicitly select the native preset; this is an approval test, not an inherited-default test.
  await bridge('liveSetMode', [conversationId, mode.id])
  await command('Page.bringToFront')
  const selector = `[data-conversation-id="${conversationId}"]`
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), Boolean, 'native conversation rail row')
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  async function capture(name) {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(root, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  async function click(label) {
    const point = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.getClientRects().length);if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    assert.ok(point, `Native approval button missing: ${label}`)
    for (const type of ['mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  const cases = []
  report.phases.push({ phase: 'native-approvals', mode, cases })
  async function checkQuestion() {
    const requestId = randomUUID()
    await bridge('livePrompt', [conversationId, requestId, 'Use your native structured question tool to ask exactly one question: "What is the verification phrase?" Allow a free-text answer. Wait for the answer, then reply with exactly that phrase. Do not ask in plain text, guess the phrase, run commands, read files, or call other tools.', []])
    const pending = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request && ['failed','completed','interrupted'].includes(request.status) && !snapshot.permissions.length) throw Error('Native runtime ended without a structured question')
      return snapshot?.permissions.length > 0
    }, 'native structured question', 120_000)
    const permission = pending.permissions[0]
    assert.equal(permission.questions?.length, 1, 'Expected exactly one native question')
    const question = permission.questions[0]
    assert.ok(!question.options.length || question.allowOther, 'Native question must accept a free-text phrase')
    // Created after the question: only its submitted answer reveals this value.
    const phrase = `ANSWER_${randomUUID()}`
    const input = await waitFor(() => evaluate(`(()=>{const e=[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), Boolean, 'native question input')
    await capture('question-pending')
    for (const type of ['mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...input})
    await command('Input.insertText',{text:phrase})
    await capture('question-answer-draft')
    await click('Send answers')
    const finished = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request?.status==='failed') throw Error(request.error??'Native question failed')
      return request?.status==='completed' && !snapshot.permissions.length
    }, 'native question continuation', 120_000)
    assert.ok(answer(finished,requestId).includes(phrase), 'Native continuation must return the phrase supplied only through this question')
    const receipts = finished.control?.approvalResponses?.filter(item=>item.id===permission.id) ?? []
    assert.equal(receipts.length,1,'Exactly one answer receipt must survive')
    report.phases.push({phase:'native-question',requestId,approvalId:permission.id,phrase,receipt:receipts[0],continuationContainsAnswer:true})
    await capture('question-completed')
  }
  for (const decision of ['deny', 'allow', 'cancel']) {
    const nonce = randomUUID(), requestId = randomUUID(), path = join(workspace, `${decision}.txt`)
    const record = { decision, requestId, nonce, approvals: 0 }
    cases.push(record)
    await bridge('livePrompt', [conversationId, requestId, `Use your shell tool exactly once to execute: printf '%s' '${nonce}' >> '${path}'. This is a disposable approval fixture. Do not run other commands or edit other files. Request permission. If denied, stop without retrying.`, []])
    const pending = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      if (snapshot?.session.status === 'failed') throw Error(snapshot.session.error)
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request && ['failed','completed','interrupted'].includes(request.status) && !snapshot.permissions.length) throw Error('Native operation ended without the expected approval')
      return snapshot?.permissions.length > 0
    }, 'native approval', 120_000)
    const permission = pending.permissions[0]
    assert.ok(permission.title.includes(nonce) && permission.title.includes(path), 'Refuse approval outside this exact disposable command')
    record.approvalId = permission.id
    record.approvals++
    await waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(nonce)})`), Boolean, 'approval visible in installed UI')
    await capture(`${decision}-pending`)
    if (decision === 'cancel') await bridge('liveCancel', [conversationId])
    else {
      const option = decision === 'allow'
        ? permission.options.find(item=>item.kind==='allow_once')
        : permission.options.find(item=>item.kind==='reject_once') ?? permission.options.find(item=>item.kind==='reject_always')
      assert.ok(option, 'Native approval option missing')
      record.nativeChoice = { id: option.optionId, name: option.name, kind: option.kind }
      await click(option.name)
    }
    const finished = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      if (snapshot?.session.status==='failed') throw Error(snapshot.session.error)
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request?.status==='failed') throw Error(request.error??'Native operation failed')
      return request && ['completed','interrupted','canceled'].includes(request.status) && !snapshot.permissions.length
    }, 'native approval completion', 120_000)
    const contents = await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
    assert.equal(contents, decision==='allow'?nonce:null, 'Native execution count differs from the selected decision')
    const receipt = finished.control?.approvalResponses?.find(item=>item.id===permission.id)
    if (decision==='cancel') assert.equal(receipt,undefined,'Stop must not fabricate an approval answer')
    else assert.ok(receipt,'Installed host lost its approval receipt')
    record.receipt = receipt
    record.status = finished.requests.find(item=>item.id===requestId).status
    record.fileMatches = contents===nonce
    await capture(`${decision}-completed`)
    if (decision==='allow' && process.env.MAKO_PACKAGE_APPROVAL_QUESTIONS) await checkQuestion()
  }
  return { nativeId: initial.session.nativeId, receipts: (await bridge('liveSnapshot',[conversationId])).control.approvalResponses }
}
