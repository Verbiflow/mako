import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real installed host and renderer; every allowed command targets this fixture. */
export async function checkPackagedApprovals({ bridge, command, evaluate, waitFor, answer, conversationId, workspace, root, report }) {
  const initial = await bridge('liveSnapshot', [conversationId])
  const access = process.env.MAKO_PACKAGE_APPROVAL_ACCESS ?? 'ask'
  const mode = initial.session.modes.find(item => item.access === access)
  assert.ok(mode, `This runtime does not advertise the requested access tier: ${access}`)
  await command('Page.bringToFront')
  const selector = `[data-conversation-id="${conversationId}"]`
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), Boolean, 'native conversation rail row')
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  if (process.env.MAKO_PACKAGE_CHECK_INHERITED_ACCESS) {
    assert.equal(initial.session.currentMode, process.env.MAKO_PACKAGE_CHECK_INHERITED_ACCESS, 'Inherited native access was reported incorrectly')
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(e=>e.textContent.includes('Full access')&&e.getClientRects().length))`), Boolean, 'inherited native Full access visible')
    await capture('inherited-access')
    report.phases.push({phase:'inherited-access',mode:initial.session.currentMode})
  }
  // Then explicitly select the native policy for the approval cases.
  await bridge('liveSetMode', [conversationId, mode.id])
  async function capture(name) {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(root, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  async function click(label) {
    const point = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.getClientRects().length);if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    assert.ok(point, `Native approval button missing: ${label}`)
    for (const type of ['mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  async function captureConfirmation(label) {
    const point = await evaluate(`(()=>{const r=document.querySelector('button[aria-label="Conversation actions"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
    await waitFor(() => evaluate("document.body.textContent.includes('Agent recorded your answer')"), Boolean, 'native answer confirmation visible')
    await new Promise(resolve => setTimeout(resolve, 300))
    await capture(label+'-native-confirmation')
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  }
  const cases = []
  report.phases.push({ phase: 'native-approvals', mode, cases })
  async function checkQuestion(prior) {
    const requestId = randomUUID()
    const label = prior ? 'question-after-restart' : 'question'
    const choices = process.env.MAKO_PACKAGE_QUESTION_CHOICES ? Array.from({length:4},()=>`CHOICE_${randomUUID()}`) : null
    const duplicateTitles = Boolean(process.env.MAKO_PACKAGE_QUESTION_DUPLICATE_TITLES)
    const prompt = choices
      ? `Use your native structured question tool to ask exactly one question with these four exact choices: ${choices.join(', ')}. ${duplicateTitles ? 'Use each exact choice as its label, and give every option the same description: Select this choice. ' : ''}Wait for the selection, then reply with only the selected value. Do not ask in plain text, guess, use other tools, or pick an answer yourself.`
      : 'Use your native structured question tool to ask exactly one question: "What is the verification phrase?" Allow a free-text answer. Wait for the answer, then reply with exactly that phrase. Do not ask in plain text, guess the phrase, run commands, read files, or call other tools.'
    const tool = process.env.MAKO_PACKAGE_QUESTION_TOOL
    await bridge('livePrompt', [conversationId, requestId, `Question occurrence: ${requestId}. ${tool ? `Call the native ${tool} tool specifically. ` : ''}${prompt}`, []])
    const pending = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request && ['failed','completed','interrupted'].includes(request.status) && !snapshot.permissions.length) throw Error('Native runtime ended without a structured question')
      return snapshot?.permissions.length > 0
    }, 'native structured question', 120_000)
    const permission = pending.permissions[0]
    assert.equal(permission.questions?.length, 1, 'Expected exactly one native question')
    const question = permission.questions[0]
    assert.ok(choices || !question.options.length || question.allowOther, 'Native question must accept a free-text phrase')
    // Choose after the question arrives. For free text, the answer value is also new.
    if (choices) assert.ok(question.options.length===choices.length && question.options.every(o=>choices.includes(o.value??o.label)), 'Native choices differ from the requested values')
    if (duplicateTitles) {
      assert.equal(new Set(question.options.map(o=>o.label)).size, question.options.length, 'Different native choices must be distinguishable in the UI')
      assert.ok(question.options.every(o=>o.label.includes(o.value??o.label)), 'Duplicate native descriptions must not hide the choice value')
    }
    const selected = choices ? question.options[randomInt(question.options.length)] : null
    const phrase = selected ? selected.value ?? selected.label : `ANSWER_${randomUUID()}`
    report.phases.push({phase:label+'-selection',requestId,approvalId:permission.id,questionId:question.id,phrase,options:question.options})
    if (prior) {
      await bridge('livePermission',[conversationId,prior.approvalId,{kind:'answers',answers:{[prior.questionId]:[prior.phrase]}}])
      const snapshot = await bridge('liveSnapshot',[conversationId])
      assert.ok(snapshot.permissions.some(p=>p.id===permission.id),'An old answer cleared the newer question')
      assert.equal(snapshot.control.approvalResponses.find(r=>r.id===prior.approvalId)?.digest,prior.receipt.digest,'An old answer changed its retained receipt')
    }
    const selector = selected
      ? `([...document.querySelectorAll('fieldset button')].find(e=>e.textContent.trim()===${JSON.stringify(selected.label)}&&e.getClientRects().length))`
      : `([...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length))`
    const input = await waitFor(() => evaluate(`(()=>{const e=${selector};if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), Boolean, 'native question control')
    await capture(label+'-pending')
    for (const type of ['mousePressed','mouseReleased']) await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...input})
    if (!selected) await command('Input.insertText',{text:phrase})
    await capture(label+'-answer-draft')
    await click('Send answers')
    const finished = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request?.status==='failed') throw Error(request.error??'Native question failed')
      return request?.status==='completed' && !snapshot.permissions.length
    }, 'native question continuation', 120_000)
    assert.ok(answer(finished,requestId).includes(phrase), 'Native continuation must return the phrase supplied only through this question')
    const receipts = finished.control?.approvalResponses?.filter(item=>item.id===permission.id) ?? []
    assert.equal(receipts.length,1,'Exactly one answer receipt must survive')
    if (process.env.MAKO_PACKAGE_QUESTION_DECISIONS) {
      assert.ok(receipts[0].origin.native, 'The question must retain its native occurrence')
      assert.equal(receipts[0].nativeDecision?.answerDigest, receipts[0].nativeAnswerDigest ?? receipts[0].digest, 'The native runtime must confirm this exact encoded answer')
      await captureConfirmation(label)
    }
    const evidence = {phase:label,requestId,approvalId:permission.id,questionId:question.id,phrase,receipt:receipts[0],continuationContainsAnswer:true,priorAnswerDidNotClearQuestion:prior?true:undefined}
    report.phases.push(evidence)
    await capture(label+'-completed')
    return evidence
  }
  let questionEvidence
  const decisions = process.env.MAKO_PACKAGE_FILE_APPROVALS ? ['decline', 'deny', 'allow', 'cancel', 'session'] : ['deny', 'allow', 'cancel']
  for (const decision of decisions) {
    const fileApproval = decision === 'decline' || decision === 'session'
    const allowed = decision === 'allow' || decision === 'session'
    const nonce = randomUUID(), requestId = randomUUID(), path = join(workspace, `${decision}.txt`)
    const record = { decision, requestId, nonce, approvals: 0 }
    cases.push(record)
    const prompt = fileApproval
      ? `Use apply_patch exactly once to create ${path} with a single line ${nonce}. Request native approval. This is a disposable approval fixture. If denied stop without retrying. Do not use any other tools or edit any other files.`
      : `Use your shell tool exactly once to execute: printf '%s' '${nonce}' >> '${path}'. This is a disposable approval fixture. Do not run other commands or edit other files. Request permission. If denied, stop without retrying.`
    await bridge('livePrompt', [conversationId, requestId, prompt, []])
    const pending = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      if (snapshot?.session.status === 'failed') throw Error(snapshot.session.error)
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request && ['failed','completed','interrupted'].includes(request.status) && !snapshot.permissions.length) throw Error('Native operation ended without the expected approval')
      return snapshot?.permissions.length > 0
    }, 'native approval', 120_000)
    const permission = pending.permissions[0]
    if (fileApproval) {
      assert.equal(permission.kind, 'edit')
      const tool = pending.blocks.find(block => block.type === 'tool' && block.id.endsWith(':'+permission.native?.requestId))
      assert.ok(tool?.input, 'Native file approval must expose its exact tool paths')
      assert.deepEqual(JSON.parse(tool.input).paths, [path], 'Refuse approval outside the exact disposable file')
    } else assert.ok(permission.title.includes(nonce) && permission.title.includes(path), 'Refuse approval outside this exact disposable command')
    record.approvalId = permission.id
    record.approvals++
    await waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(nonce)})`), Boolean, 'approval visible in installed UI')
    await capture(`${decision}-pending`)
    if (decision === 'cancel') await bridge('liveCancel', [conversationId])
    else {
      const option = allowed
        ? permission.options.find(item=>item.kind===(decision === 'session' ? 'allow_always' : 'allow_once'))
        : permission.options.find(item=>item.kind==='reject_once') ?? permission.options.find(item=>item.kind==='reject_always')
      assert.ok(option, 'Native approval option missing')
      record.nativeChoice = { id: option.optionId, name: option.name, kind: option.kind }
      await click(option.name)
    }
    const finished = await waitFor(() => bridge('liveSnapshot', [conversationId]), snapshot => {
      if (snapshot?.session.status==='failed' && decision!=='cancel') throw Error(snapshot.session.error)
      const request = snapshot?.requests.find(item=>item.id===requestId)
      if (request?.status==='failed' && decision!=='cancel') throw Error(request.error??'Native operation failed')
      return request && ['completed','interrupted','canceled', ...(decision==='cancel'?['failed']:[])].includes(request.status) && !snapshot.permissions.length
    }, 'native approval completion', 120_000)
    const contents = await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error})
    assert.equal(contents, allowed ? nonce + (fileApproval ? '\n' : '') : null, 'Native execution count differs from the selected decision')
    let receipt = finished.control?.approvalResponses?.find(item=>item.id===permission.id)
    if (decision==='cancel') assert.equal(receipt,undefined,'Stop must not fabricate an approval answer')
    else assert.ok(receipt,'Installed host lost its approval receipt')
    if (decision!=='cancel' && process.env.MAKO_PACKAGE_PERMISSION_DECISIONS) {
      const observed = await waitFor(() => bridge('liveSnapshot',[conversationId]),
        snapshot => Boolean(snapshot?.control?.approvalResponses?.find(item=>item.id===permission.id)?.nativeDecision),
        'exact native tool-permission decision')
      receipt = observed.control.approvalResponses.find(item=>item.id===permission.id)
      assert.deepEqual(receipt.nativeDecision.identity, receipt.origin.native)
      assert.equal(receipt.nativeDecision.answerDigest, receipt.nativeAnswerDigest ?? receipt.digest)
      await captureConfirmation(decision)
    }
    record.receipt = receipt
    record.status = finished.requests.find(item=>item.id===requestId).status
    record.fileMatches = contents===nonce + (fileApproval ? '\n' : '')
    await capture(`${decision}-completed`)
    if (decision==='cancel') {
      // Stop may close the native transport to discard queued SDK input. The
      // acceptance contract is continuation in the same session, not the same process.
      assert.ok(finished.session.connection === 'connected' ||
        (finished.session.connection === 'disconnected' && finished.session.status === 'ready'))
      const followup = randomUUID(), expected = cases.find(item=>item.decision==='allow').nonce
      await bridge('livePrompt',[conversationId,followup,'Reply only with the nonce from the command you were allowed to execute earlier. Do not use tools or modify files.',[]])
      const continued = await waitFor(() => bridge('liveSnapshot',[conversationId]), snapshot => {
        const request = snapshot?.requests.find(item=>item.id===followup)
        if (request?.status==='failed') throw Error(request.error??'Continuation after cancellation failed')
        return request?.status==='completed'
      },'same-session continuation after cancellation',120_000)
      assert.equal(continued.session.nativeId, finished.session.nativeId)
      assert.equal(continued.permissions.length, 0)
      assert.ok(answer(continued,followup).includes(expected),'Cancellation lost the existing native context')
      assert.equal(await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error}),null)
      record.continuation = { requestId: followup, priorConnection: finished.session.connection, sameSession: true, rememberedPriorAllowedNonce: true, cancelledFileAbsent: true }
      await capture('cancel-continued')
    }
    if (decision==='allow' && process.env.MAKO_PACKAGE_APPROVAL_QUESTIONS) questionEvidence = await checkQuestion()
  }
  return { nativeId: initial.session.nativeId, receipts: (await bridge('liveSnapshot',[conversationId])).control.approvalResponses, checkQuestionAfterRestart: questionEvidence ? () => checkQuestion(questionEvidence) : undefined }
}
