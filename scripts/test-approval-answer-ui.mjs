import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Answering a tool approval, against the production composer and transcript
 * on the live workflow fixture, for each harness that asks: a turn in its
 * asking mode waits on a call, the person allows it once or always, and the
 * fixture answers as the host's `LiveApprovals.respond` does, a batch saving
 * the answer as sending and the next as handed over, then the harness's own
 * record of the decision, then the turn going on. Nothing is drawn above the
 * composer for that, not for one frame: the card goes, and the live step
 * names the call that now runs. An answer still sending after a second says
 * so, its words arriving with their bar. A reopened conversation holding the
 * same receipts draws the same. Screenshots, dark and light, go to
 * MAKO_APPROVAL_UI_EVIDENCE when it is set.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-approval-answer-ui-"))
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-approval-answer-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const evidence = process.env.MAKO_APPROVAL_UI_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const progress = { last: "" }
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Approval answer UI verification exceeded its 240-second limit", JSON.stringify(progress))
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => { progress.last = code.slice(0, 160); return page.executeJavaScript(code) }
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`UI condition timed out: ${label}`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }
  const click = async (selector) => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const capture = async (name) => {
    if (!evidence) return
    await evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`)
    await frames()
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  if (evidence) await mkdir(evidence, { recursive: true })

  try {
    // Drawn, though behind other windows: a window never shown runs no animation frames.
    window.showInactive()
    await page.loadURL(`${process.env.MAKO_UI_TEST_URL}scripts/live-workflow.html`)
    await until("Boolean(document.querySelector('.composer-input'))")
    await evaluate(`(() => { document.head.insertAdjacentHTML('beforeend', '<style>[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    // The fixture page draws the desk's parts without its shell, which paints the theme.
    await evaluate("import('/src/state/prefs.ts').then(({bindTheme}) => { bindTheme(); return true })")
    const asking = await evaluate(`import('/src/dev/harness-fixtures.ts').then(({fixtureHarnesses}) => fixtureHarnesses.filter(entry => entry.capabilities.approvals.state !== 'absent').map(entry => entry.provider))`)
    assert.ok(asking.includes("claude") && asking.includes("codex"), `the harnesses that ask: ${asking}`)

    /**
     * A running turn whose call waits on the person, and a bridge that answers
     * as the host does. `hold` keeps the answer sending until `__handOver()`.
     * Every insertion of the notice stack is recorded with its words' and
     * bar's opacity at that moment, so a stack drawn for one frame is seen.
     */
    const ask = (harness, hold) => evaluate(`(async () => {
      const { acpStore } = await import('/src/state/acp-state.ts')
      const { threadsStore } = await import('/src/state/thread-store.ts')
      const { applyLiveSnapshot, applyLiveBatch } = await import('/src/state/live-recovery.ts')
      const { setPref } = await import('/src/state/prefs.ts')
      setPref('dismissedRecoveryRequests', {})
      const state = acpStore.get(), live = state.conversations[state.activeKey], key = state.activeKey, harness = ${JSON.stringify(harness)}
      threadsStore.set({ composerHarness: harness })
      const native = { scope: crypto.randomUUID(), sessionId: 'native-session', requestId: 'call-1' }
      const origin = { native, nativeRequestId: 'call-1', bindingId: key, epoch: 'approval-ui', generation: 1, connectionGeneration: 1, runId: 'run-1' }
      const id = crypto.randomUUID()
      const permission = { id, sessionId: key, title: 'npm test -- --run src/router', kind: 'execute', origin, options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] }
      const call = { type: 'tool', id: 'call-1', toolKind: 'execute', title: 'npm test -- --run src/router', input: '{"command":"npm test -- --run src/router"}', output: '', status: 'pending' }
      window.__snapshot = {
        session: { ...live.session, harness, status: 'running', connection: 'connected' }, epoch: 'approval-ui', revision: (live.revision ?? 0) + 1, createdAt: 1, base: null, requests: [], nativeAgents: undefined,
        blocks: [{ type: 'user', text: 'Run the router tests.' }, { type: 'text', text: 'Running the router tests.' }, call],
        permissions: [permission], control: { ...live.control, actions: [], transfers: [], approvalResponses: [] },
      }
      applyLiveSnapshot(window.__snapshot)
      window.mako.liveSnapshot = async () => window.__snapshot
      const batch = (patch) => {
        window.__snapshot = { ...window.__snapshot, ...patch, revision: window.__snapshot.revision + 1 }
        applyLiveBatch({ id: key, revision: window.__snapshot.revision, epoch: 'approval-ui', updates: [], ...patch })
      }
      const receipts = (receipt) => ({ control: { ...window.__snapshot.control, approvalResponses: [receipt] } })
      window.__answers = []
      window.__receipt = undefined
      window.mako.livePermission = async (_conversation, requestId, response) => {
        window.__answers.push({ requestId, response })
        const receipt = { id, origin, digest: 'a'.repeat(64), nativeAnswerDigest: 'b'.repeat(64), createdAt: Date.now(), state: { kind: 'dispatching' } }
        batch({ ...receipts(receipt), permissions: [permission] })
        // Each save reaches the window as its own event, as the host's batches do.
        await new Promise(resolve => { ${hold ? "window.__handOver = resolve" : "setTimeout(resolve)"} })
        window.__receipt = { ...receipt, state: { kind: 'submitted', source: 'callback' } }
        batch({ ...receipts(window.__receipt), permissions: [] })
      }
      window.__recorded = (decided) => {
        window.__receipt = { ...window.__receipt, nativeDecision: { identity: native, answerDigest: decided ?? window.__receipt.nativeAnswerDigest, observedAt: Date.now() } }
        batch(receipts(window.__receipt))
      }
      window.__goesOn = () => applyLiveSnapshot({ ...window.__snapshot, revision: window.__snapshot.revision + 1,
        blocks: [...window.__snapshot.blocks.map(block => block.id === 'call-1' ? { ...block, status: 'completed', output: 'Tests  12 passed' } : block), { type: 'text', text: 'All twelve router tests pass.' }],
        session: { ...window.__snapshot.session, status: 'ready' } })
      window.__stacks = []
      window.__watch?.disconnect()
      window.__watch = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const stack = node.matches('[data-composer-notices]') ? node : node.querySelector('[data-composer-notices]')
          if (!stack) continue
          const bar = stack.querySelector('[data-notice-place="front"]')?.parentElement
          const row = stack.querySelector('[data-notice-place="front"]')
          window.__stacks.push({ at: performance.now(), words: stack.innerText.replace(/\\s+/g, ' ').trim(), bar: bar ? getComputedStyle(bar).opacity : null, row: row ? getComputedStyle(row).opacity : null })
        }
      })
      window.__watch.observe(document.body, { childList: true, subtree: true })
      return true
    })()`)
    const cardShown = "[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Allow once' && button.getClientRects().length)"
    const liveStep = "document.querySelector('[data-live-step]')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''"
    const answer = async (label) => {
      await until(cardShown, "the approval card")
      await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).setAttribute('data-test-answer', ''); true`)
      await click("[data-test-answer]")
      await until("window.__answers.length === 1", "the answer reached the bridge")
    }
    const handedOver = () => until("window.__receipt?.state.kind === 'submitted'", "the host handed the answer over")

    for (const shade of ["dark", "light"]) {
      await theme(shade)
      for (const harness of asking) {
        for (const label of ["Allow once", "Always allow"]) {
          const shot = (moment) => (label === "Allow once" ? capture(`approval-bar-after-${harness}-${moment}-${shade}`) : undefined)
          await ask(harness, false)
          await until(`${liveStep}.startsWith('Waiting for your approval')`, `${harness}: the live step waits on the person`)
          await shot("asking")
          await answer(label)
          await handedOver()
          await frames()
          assert.equal(await evaluate(cardShown), false, `${harness}: the answered card goes`)
          assert.match(await evaluate(liveStep), /npm test -- --run src\/router/, `${harness}: the live step names the call that now runs`)
          assert.doesNotMatch(await evaluate(liveStep), /Waiting for your approval/, `${harness}: the live step stops waiting`)
          await shot("answered")
          await evaluate("window.__recorded(); true")
          await frames()
          await evaluate("window.__goesOn(); true")
          await frames()
          await shot("finished")
          assert.deepEqual(await evaluate("window.__stacks"), [], `${harness} ${label}: no bar drawn above the composer for an answer handed over at once`)
          assert.equal(await evaluate("Boolean(document.querySelector('[data-composer-notices]'))"), false)
          assert.deepEqual(await evaluate("window.__answers.map(answer => answer.response)"), [{ kind: "choice", optionId: label === "Allow once" ? "once" : "always" }])
        }
      }
    }
    console.log(`PASS: ${asking.join(", ")}: allowing a call once or always draws nothing above the composer; the live step names the call it runs`)

    // An answer still sending: nothing for the first second, then the words with their bar.
    await theme("dark")
    for (const harness of asking) {
      await ask(harness, true)
      await answer("Allow once")
      const sent = Date.now()
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      assert.deepEqual(await evaluate("window.__stacks"), [], `${harness}: an answer half a second on its way draws nothing`)
      await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Sending your answer')", `${harness}: a slow answer says so`)
      assert.ok(Date.now() - sent >= 900, `${harness}: said after the hold, not before`)
      const [arrived, ...more] = await evaluate("window.__stacks")
      assert.equal(more.length, 0)
      assert.match(arrived.words, /Sending your answer/, `${harness}: the bar arrives with its words`)
      assert.equal(arrived.row, "1", `${harness}: the words are never fainter than their bar`)
      if (harness === "claude") await capture("approval-bar-after-slow-sending-dark")
      await evaluate("window.__handOver(); true")
      await until("!document.querySelector('[data-composer-notices]')", `${harness}: the notice goes once the answer is handed over`)
    }
    console.log(`PASS: ${asking.join(", ")}: an answer still sending after a second says so, its words with their bar`)

    // Reopened: the receipts a conversation keeps draw what they drew live.
    for (const harness of asking) {
      await ask(harness, false)
      await answer("Allow once")
      await handedOver()
      await evaluate("window.__recorded(); true")
      const kept = await evaluate("window.__snapshot")
      await page.reload()
      await until("Boolean(document.querySelector('.composer-input'))")
      await evaluate(`import('/src/state/live-recovery.ts').then(({applyLiveSnapshot}) => { applyLiveSnapshot(${JSON.stringify({ ...kept, revision: kept.revision + 1 })}); return true })`)
      await frames()
      assert.equal(await evaluate("Boolean(document.querySelector('[data-composer-notices]'))"), false, `${harness}: reopened, the answered approval draws nothing above the composer`)
      assert.equal(await evaluate(cardShown), false, `${harness}: reopened, the answered card stays gone`)
      assert.match(await evaluate(liveStep), /npm test -- --run src\/router/, `${harness}: reopened, the live step names the running call`)
    }
    console.log(`PASS: ${asking.join(", ")}: a reopened conversation draws the answered approval as it was drawn live`)
    clearTimeout(watchdog)
    app.exit(0)
  } catch (error) {
    clearTimeout(watchdog)
    throw error
  }
}
