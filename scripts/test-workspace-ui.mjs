import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = testScratch("mako-workspace-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates(), {
      name: "mako-update-test",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/__mako-test-update" || request.method !== "POST") return next()
          server.environments.client.hot.send({ type: "update", updates: [{ type: "js-update", path: "/src/dev/live-workflow-check.tsx", acceptedPath: "/src/dev/live-workflow-check.tsx", timestamp: Date.now() }] })
          server.environments.client.hot.send({ type: "full-reload", path: "*" })
          response.end("notified")
        })
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-workspace-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    // The window draws macOS's overlay scrollers, as the interface is made for (`index.css`, "No drawn scrollbars"),
    // whatever the Mac running it shows: a CI Mac always shows scrollbars, each 15 px of its list's width, so the rail's
    // rows moved 15 px left as its list first overflowed, a moment after the desk came up.
    const scrollers = process.platform === "darwin" ? ["-AppleShowScrollBars", process.env.MAKO_UI_TEST_SCROLLBARS ?? "WhenScrolling"] : []
    const child = spawn(resolve("node_modules/.bin/electron"), [root, ...scrollers], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

/** How long a press waits for its target to stand still with nothing over it, before it lands where the target is. */
const PRESSABLE_MS = 1_000
/** Waited between measuring a target and pressing it, for a person checking what a slow runner does to a press. */
const BETWEEN_MEASURE_AND_PRESS_MS = Number(process.env.MAKO_UI_TEST_PRESS_AFTER_MS ?? 0)

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const watchdog = setTimeout(() => {
    console.error("Workspace UI verification exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  page.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const capture = async (name) => {
    await evaluate(`Promise.all([...document.querySelectorAll('[data-slot="popover-content"]')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {})))`)
    await evaluate("Promise.all([...document.images].map(image => image.decode().catch(() => {}))).then(() => true)")
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        // Where CI keeps evidence (the job uploads it on failure), and what the composer and focus were, in the log.
        if (process.env.MAKO_TEST_EVIDENCE) {
          await mkdir(join(process.env.MAKO_TEST_EVIDENCE, "workspace-ui"), { recursive: true })
          await writeFile(join(process.env.MAKO_TEST_EVIDENCE, "workspace-ui", "failure.png"), (await page.capturePage()).toPNG())
        }
        const seen = await evaluate(`JSON.stringify({ composer: document.querySelector('.composer-input')?.value, focus: document.activeElement ? document.activeElement.tagName + ' ' + [...document.activeElement.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ').slice(0, 240) : null, focused: document.hasFocus() })`).catch(() => "unreadable")
        throw new Error(`UI condition timed out: ${code}; the page had ${seen}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  // The press lands on whatever is drawn at the point; `exposed` says what covers the target rather than press it.
  // A target drawn at its point when measured, and no longer under the press when it lands, fails here, by how far it
  // moved and what took the press. The rail's New button moved 15 px so, its press opened the menu beside it, and all
  // the failure said was that the project never changed (suites 3, 2026-11-20 and 21).
  const click = async (selector, { exposed = false } = {}) => {
    const point = await evaluate(`(async () => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) throw new Error('Missing click target')
      const read = () => {
        const r = node.getBoundingClientRect()
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
        return { x, y, top: document.elementFromPoint(x, y) }
      }
      // Pressed once it has stood still for two frames with nothing over it: a menu still opening moves its items, and
      // one still closing keeps the page's presses to itself. Two, since what is laid out at a placeholder's size
      // (content-visibility) stands there through its first frame and takes its own size in the second: the queue's
      // rows did, and "Jump to latest" above them was measured 31 px from where the press then found it.
      const deadline = performance.now() + ${PRESSABLE_MS}
      let at = read()
      for (let still = 0; still < 2 && performance.now() <= deadline; ) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const next = read()
        still = next.x === at.x && next.y === at.y && next.top && node.contains(next.top) ? still + 1 : 0
        at = next
      }
      const { x, y, top } = at
      const drawn = Boolean(top) && node.contains(top)
      if (${exposed} && top && !drawn) throw new Error(${JSON.stringify(selector)} + ' covered by ' + top.tagName + ' ' + [...top.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ').slice(0, 200))
      window.__pressMoved = undefined
      window.addEventListener('pointerdown', (event) => {
        if (!drawn || !node.isConnected || node.contains(event.target)) return
        const now = node.getBoundingClientRect()
        const dx = Math.round(now.x + now.width / 2) - x, dy = Math.round(now.y + now.height / 2) - y
        const landed = event.target.closest('button,a,[role]') ?? event.target
        window.__pressMoved = 'moved ' + dx + ',' + dy + ' px between being measured and pressed, and the press landed on ' + landed.tagName + ' ' + [...landed.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ').slice(0, 200)
      }, { capture: true, once: true })
      return { x, y }
    })()`)
    if (BETWEEN_MEASURE_AND_PRESS_MS) await new Promise((resolve) => setTimeout(resolve, BETWEEN_MEASURE_AND_PRESS_MS))
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
    const moved = await evaluate("window.__pressMoved").catch(() => undefined)
    if (moved) throw new Error(`${selector} ${moved}`)
  }
  // Orbs paint in a worker and pause while the page is hidden, as this test
  // window is; the main-thread orb draws the same motion and can be read back.
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Page.enable")
  await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: "delete HTMLCanvasElement.prototype.transferControlToOffscreen",
  })
  await window.loadURL(`${base}scripts/live-workflow.html`)
  console.log("UI fixture loaded")
  await until(`Boolean(document.querySelector('.composer-input'))`)
  await evaluate(`(async () => {
    const {store} = await import('/src/state/session.ts');
    const {acpStore} = await import('/src/state/acp-state.ts');
    const {threadsStore} = await import('/src/state/threads.ts');
    const session = store.get(), live = acpStore.get(), threads = threadsStore.get();
    window.restoreDraftTarget = () => { store.set(session); threadsStore.set(threads); acpStore.set(live); };
    acpStore.set({activeKey:null}); threadsStore.set({viewing:null,opening:null}); store.set({meta:null,phase:'booting'});
  })()`)
  await until(`document.querySelector('.composer-input').readOnly`)
  assert.equal(await evaluate(`document.querySelector('.composer-input').placeholder`), "Opening workspace…")
  await evaluate(`document.querySelector('.composer-input').focus()`)
  await type("This must not become a root-workspace draft")
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), "")
  assert.equal(await evaluate(`import('/src/state/drafts.ts').then(({draftText,projectDraftKey}) => draftText(projectDraftKey('')))`), "")
  await capture("composer-starting.png")
  await evaluate(`window.restoreDraftTarget()`)
  await until(`!document.querySelector('.composer-input').readOnly`)
  console.log("Startup composer refuses input until its draft target is known")
  await evaluate("document.fonts.ready.then(() => true)")
  const geometry = await evaluate(`(() => { const input = document.querySelector('.composer-input'); const send = document.querySelector('button[aria-label="Send"]'); return {height: input.getBoundingClientRect().height, width: send.getBoundingClientRect().width, radius: getComputedStyle(send).borderRadius}; })()`)
  // One line tall at rest (#367's calm composer: `min-h-12`, where it had been 80 px).
  assert.ok(geometry.height >= 48 && geometry.height < 80, `the empty composer is one line tall, not ${geometry.height} px`)
  assert.equal(geometry.width, 32)
  assert.equal(geometry.radius, "0px")
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-input')).fontSize`), '16px')
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Context and spend"]'))`), false)
  await click('button[aria-label="Add to message"]')
  await until(`document.querySelector('[data-slot="popover-content"][aria-label="Add to message"]')?.textContent.includes('Manage MCP tools')`)
  assert.ok(await evaluate(`document.querySelector('[aria-label="Attach a screenshot"]') !== null`))
  await capture('composer-add-menu.png')
  await click('[aria-label="Attach a screenshot"]')
  // The picker lists what the host's driver finds: nothing on a CI runner, a Mac's own windows where someone works.
  await until(`document.body.textContent.includes('No visible windows to capture') || document.querySelector('button[aria-label^="Capture "]') !== null`)
  await capture('screenshot-picker.png')
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await until(`document.querySelector('[data-add="reference"]') !== null`)
  await click('[data-add="reference"]')
  await until(`document.querySelector('.composer-input').value === '@' && document.activeElement === document.querySelector('.composer-input')`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:''}}))`)
  await click('button[aria-label="Add to message"]')
  await click('[data-add="skill"]')
  // Skills and commands open on `/` since 2026-10-13 (470ea75a4), where they were `$`.
  await until(`document.querySelector('.composer-input').value === '/' && document.activeElement === document.querySelector('.composer-input')`)
  await until(`document.querySelector('[data-mention-menu="/"]') !== null`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:''}})); window.addEventListener('mako:settings', event => {window.settingsSection = event.detail}, {once:true})`)
  // Replacing the draft from outside closes a menu opened for the old text.
  await until(`document.querySelector('[data-mention-menu]') === null`)
  await click('button[aria-label="Add to message"]')
  await click('[data-add="mcp"]')
  await until(`window.settingsSection === 'mcp'`)
  await click(".composer-input")
  await type("Keep this unfinished paragraph")
  await until(`document.querySelector('.composer-input').value === 'Keep this unfinished paragraph'`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail: {text: 'Review [Screenshot.png]', attachments: [{id:'image', index:1, name:'Screenshot.png', reference:'[Screenshot.png]', kind:'image', mimeType:'image/png', size:42, stagedPath:'/retained/image.png', preview:${JSON.stringify(`${base}icons/app-icon.png`)}}]}}))`)
  await until(`document.querySelectorAll('[aria-label="Remove Screenshot.png"]').length === 1 && document.querySelector('[aria-label="Preview Screenshot.png"] canvas[data-ready]')?.width > 0`)
  // The attachment's place in the draft is a context chip with nothing to press in the field (since 2026-10-13; it was
  // an inline token, `data-attachment-reference`, that nothing draws now).
  assert.equal(await evaluate(`(() => { const chip = document.querySelector('[data-context-chip]'); return chip ? chip.querySelector('button') : 'no chip' })()`), null)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail: {text:'Review [Screenshot.png] [Second.png]', attachments:[{id:'second', index:2, name:'Second.png', reference:'[Second.png]', kind:'image', mimeType:'image/png', size:42, stagedPath:'/retained/second.png', preview:${JSON.stringify(`${base}icons/app-icon.png`)}}]}}))`)
  await until(`document.querySelectorAll('[aria-label="Attachments"] canvas[data-ready]').length === 2`)
  assert.equal(await evaluate(`(() => { const images = [...document.querySelectorAll('[aria-label="Attachments"] canvas')].map(image => image.getBoundingClientRect()); return images[0].top === images[1].top && images[1].left > images[0].right; })()`), true)
  console.log("Composer input and both previews verified")
  await capture("composer-preview.png")
  await click('[aria-label="Remove Second.png"]')
  await until(`document.querySelectorAll('[aria-label="Attachments"] canvas[data-ready]').length === 1`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'Review [Screenshot.png]'}}))`)
  await click(".composer-input")
  await evaluate(`(() => { const input = document.querySelector('.composer-input'); input.setSelectionRange(input.value.length, input.value.length); })()`)
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  await until(`!document.querySelector('[aria-label="Remove Screenshot.png"]')`)
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), "Review ")
  await click('nav[aria-label="Previous prompts"] button')
  // The navigator's list stays open while the pointer rests on it or its button holds focus, and at this window's size it covers the prompt's actions.
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 })
  await evaluate(`document.activeElement?.blur()`)
  await evaluate(`(async () => { const {getMako} = await import('/src/lib/bridge.ts'); getMako().copy = async text => {window.copiedText = text}; document.querySelector('[aria-label="Copy question"]').scrollIntoView({block:'center'}); })()`)
  await click('[aria-label="Copy question"]', { exposed: true })
  await until(`window.copiedText === 'Keep the reply in the same Claude conversation.'`)
  await evaluate(`document.querySelector('[aria-label="Copy answer"]').scrollIntoView({block:'center'})`)
  await click('[aria-label="Copy answer"]', { exposed: true })
  await until(`window.copiedText?.startsWith('The provider session ID now owns continuation.')`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:Array.from({length:100}, (_, i) => 'Draft line ' + i).join('\\n')}}))`)
  await until(`document.querySelector('.composer-input').value.split('\\n').length === 100`)
  const collapsedHeight = await evaluate(`document.querySelector('[data-composer]').getBoundingClientRect().height`)
  assert.ok(collapsedHeight <= await evaluate("innerHeight * 0.55 + 1"))
  await click('[aria-label="Expand draft"]')
  await until(`document.querySelector('[aria-label="Collapse draft"]') !== null`)
  assert.ok(await evaluate(`document.querySelector('[data-composer]').getBoundingClientRect().height`) > collapsedHeight)
  await capture("expanded-draft.png")
  await click('[aria-label="Collapse draft"]')
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'Review '}}))`)
  await until(`document.querySelector('.composer-input').value === 'Review ' && Boolean(document.querySelector('nav[aria-label="Previous prompts"]'))`)
  await evaluate(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
  await click('nav[aria-label="Previous prompts"] button')
  await until(`document.querySelector('nav .overlay-panel button') !== null`)
  assert.equal(await evaluate(`document.querySelectorAll('nav .overlay-panel button').length`), 4)
  await click('nav .overlay-panel button')
  await until(`document.querySelector('.scroll-fade-scroller').scrollTop < 30`)
  window.setSize(760, 900)
  await until(`document.querySelector('main').getBoundingClientRect().width < 620`)
  assert.equal(await evaluate(`Boolean(document.querySelector('nav[aria-label="Previous prompts"]'))`), true)
  await capture("navigator-narrow.png")
  window.setSize(1280, 900)
  await evaluate(`window.testSentinel = 'unchanged'`)
  const updateResponse = await fetch(`${base}__mako-test-update`, { method: "POST" })
  assert.equal(await updateResponse.text(), "notified")
  await until(`document.body.textContent.includes('changes ready')`)
  assert.equal(await evaluate("window.testSentinel"), "unchanged")
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), "Review ")
  await click('[data-fixture="running"]')
  await click('[data-transcript-jump] > button')
  // A running turn's motion, scrolled out of view and under reduced motion, is test:animations-ui's (gated in suites):
  // this view draws no orb for a running turn now, so the checks of one that stood here are gone.
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[aria-label="Queued messages"]')).borderRadius`), "0px")
  // The queue lines up with the composer's box (`.composer-box`), not the column around it, which #367 gave a margin.
  assert.ok(await evaluate(`Math.abs(document.querySelector('[aria-label="Queued messages"]').getBoundingClientRect().width - document.querySelector('.composer-box').getBoundingClientRect().width) < 2`))
  assert.equal(await evaluate(`document.querySelectorAll('[data-agent-activity]').length`), 1)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-agent-activity] [data-size="64"]'))`), false)
  await capture("working.png")
  await click('[data-transcript-jump] > button')
  await click('[data-fixture="responding"]')
  await until(`document.querySelectorAll('[data-agent-activity]').length === 0`)
  await capture('responding-clean.png')
  await evaluate(`(async () => { const {acpStore, activeLiveAcp} = await import('/src/state/acp.ts'); const {applyLiveBatch} = await import('/src/state/live-recovery.ts'); const live = activeLiveAcp(acpStore.get()); applyLiveBatch({id: live.key, revision: live.revision + 1, updates: [], session: {...live.session, status: 'ready'}, requests: live.requests.map(request => ({...request, status: 'completed'}))}); })()`)
  await evaluate(`(async () => { const {acpStore,activeLiveAcp} = await import('/src/state/acp.ts'); const {applyLiveBatch} = await import('/src/state/live-recovery.ts'); const live = activeLiveAcp(acpStore.get()); applyLiveBatch({id:live.key,revision:live.revision+1,updates:[],requests:live.requests.map((request,index) => ({...request,status:index === 0 ? 'interrupted' : 'completed'}))}); })()`)
  await until(`document.querySelector('[data-turn-stopped]') !== null`)
  assert.equal(await evaluate(`document.querySelector('[data-request-recovery]')`), null)
  assert.equal(await evaluate(`document.body.textContent.includes('Message interrupted')`), false)
  await capture('stopped-turn.png')
  await evaluate(`(async () => { const {getMako} = await import('/src/lib/bridge.ts'); window.fixtureSendCount = 0; getMako().livePrompt = async () => { window.fixtureSendCount++; }; window.fixtureAttachment = {id:'pending-file', index:2, name:'proof.txt', reference:'[proof.txt]', kind:'text', mimeType:'text/plain', size:5, stagedPath:'/retained/proof.txt', pending:true}; window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'One send [proof.txt]', attachments:[window.fixtureAttachment]}})); })()`)
  await until(`document.querySelector('.composer-input').value.includes('One send')`)
  await click('button[aria-label="Send"]')
  await click('button[aria-label="Send"]')
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'One send [proof.txt]', attachments:[{...window.fixtureAttachment, pending:false}]}}))`)
  await until(`window.fixtureSendCount === 1`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(await evaluate("window.fixtureSendCount"), 1)
  await evaluate(`(async () => { const {acp} = await import('/src/state/acp.ts'); const {actions} = await import('/src/state/session.ts'); acp.deactivate(); await actions.openWorkspace('/fixture/project-a'); await actions.newConversationIn('/fixture/project-a'); })()`)
  await click(".composer-input")
  await type("Draft A survives New and navigation")
  await evaluate(`(async () => { const {actions} = await import('/src/state/session.ts'); await actions.openWorkspace('/fixture/project-b'); await actions.newConversationIn('/fixture/project-b'); })()`)
  await until(`document.querySelector('.composer-input').value === ''`)
  await click(".composer-input")
  await type("Draft B stays separate")
  await evaluate(`(async () => { const {actions} = await import('/src/state/session.ts'); await actions.openWorkspace('/fixture/project-a'); await actions.newConversationIn('/fixture/project-a'); })()`)
  await until(`document.querySelector('.composer-input').value === 'Draft A survives New and navigation'`)
  await evaluate(`import('/src/state/acp.ts').then(({acp}) => acp.activate('11111111-1111-4111-8111-111111111111'))`)
  await until(`document.querySelector('.composer-input').value === ''`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'Keep this paragraph through reload'}}))`)
  await until(`document.querySelector('.composer-input').value === 'Keep this paragraph through reload'`)
  const reloaded = new Promise((resolve) => page.once("did-finish-load", resolve))
  await evaluate(`import('/src/state/development.ts').then(module => module.reloadInterface())`)
  await reloaded
  await until(`document.querySelector('.composer-input')?.value === 'Keep this paragraph through reload'`)
  const preview = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await preview.loadURL(`${base}scripts/live-workflow.html?preview=verification`)
  assert.equal(await preview.webContents.executeJavaScript(`document.querySelector('.composer-input').value`), "")
  await preview.webContents.executeJavaScript(`document.querySelector('.composer-input').focus()`)
  preview.webContents.debugger.attach("1.3")
  await preview.webContents.debugger.sendCommand("Input.insertText", { text: "Independent preview draft" })
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), "Keep this paragraph through reload")
  await preview.webContents.executeJavaScript(`import('/src/state/prefs.ts').then(({setPref}) => setPref('quitWithAgents', 'keep'))`)
  await until(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.get().quitWithAgents === 'keep')`)
  await evaluate(`import('/src/state/prefs.ts').then(({setPref}) => setPref('soundVolume', 0.4))`)
  assert.equal(await preview.webContents.executeJavaScript(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.get().quitWithAgents)`), "keep")
  preview.destroy()
  await window.loadURL(`${base}?mock`)
  // The desk is up when its rail's top rows are (#337 replaced the "Thread view" group with them).
  await until(`document.querySelector('nav[data-rail-top]') !== null`)
  assert.notEqual(await evaluate(`import('/src/state/session.ts').then(({store}) => store.get().meta?.cwd)`), "/Users/you/api")
  // A folder's actions join its row under the pointer, as they do for a person.
  const newThreadIn = async (folder) => {
    const action = `button[aria-label="New thread in ${folder}"]`
    // Scrolled to, as a person would: under the rail's own rows a folder may sit below the setup bar at its foot.
    await evaluate(`document.querySelector(${JSON.stringify(action)}).closest('[data-flip-key^="folder:"]').scrollIntoView({ block: "center" }), true`)
    const row = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(action)}).closest('[data-flip-key^="folder:"]').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...row })
    await until(`document.querySelector(${JSON.stringify(action)}).getBoundingClientRect().width > 0`)
    await click(action)
  }
  await newThreadIn("api")
  await until(`import('/src/state/session.ts').then(({store}) => store.get().meta?.cwd === '/Users/you/api')`)
  await until(`document.activeElement?.classList.contains('composer-input')`)
  assert.equal(await evaluate(`import('/src/state/tabs.ts').then(({tabsStore}) => { const s = tabsStore.get(); return s.tabs.length === 2 && s.activeId === s.tabs[1].id })`), true)
  console.log("Project row New opens the thread in the clicked workspace")
  await evaluate(`(() => {
    window.mako.openTab = async () => { throw new Error("fixture: host refused the tab") };
  })()`)
  const beforeFailedOpen = await evaluate(`import('/src/state/session.ts').then(({store}) => store.get().meta?.cwd)`)
  await newThreadIn("site")
  await until(`document.body.textContent.includes('fixture: host refused the tab')`)
  assert.equal(await evaluate(`import('/src/state/session.ts').then(({store}) => store.get().meta?.cwd)`), beforeFailedOpen)
  assert.equal(await evaluate(`import('/src/state/tabs.ts').then(({tabsStore}) => tabsStore.get().tabs.length)`), 2)
  console.log("Failed project New leaves the current thread in place")
  await window.loadURL(`${base}?mock`)
  // The desk is up when its rail's top rows are (#337 replaced the "Thread view" group with them).
  await until(`document.querySelector('nav[data-rail-top]') !== null`)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-composer] [aria-label="Show terminal"], [data-composer] [aria-label="Hide terminal"]'))`), false)
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74,modifiers:4})
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74,modifiers:4})
  await until(`document.querySelector('[aria-label="Resize terminal dock"]') !== null`)
  await until(`document.querySelector('[aria-label="Terminal options"]') !== null`)
  if (await evaluate(`Boolean(document.querySelector('[data-sonner-toast] [data-close-button]'))`)) {
    await click('[data-sonner-toast] [data-close-button]')
    await until(`document.querySelector('[data-sonner-toast]') === null`)
  }
  // Maximize and its restore live in the dock's options menu.
  const terminalOption = async (label) => {
    await click('[aria-label="Terminal options"]')
    await until(`[...document.querySelectorAll('[role=menuitem]')].some(item => item.textContent === ${JSON.stringify(label)})`)
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent === ${JSON.stringify(label)}).setAttribute('data-check-target', '')`)
    await click('[data-check-target]')
  }
  await terminalOption("Maximize")
  await until(`document.querySelector('[aria-label="Resize terminal dock"]') === null`)
  await terminalOption("Restore size")
  await until(`document.querySelector('[aria-label="Resize terminal dock"]') !== null`)

  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'j',code:'KeyJ',windowsVirtualKeyCode:74,modifiers:4})
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'j',code:'KeyJ',windowsVirtualKeyCode:74,modifiers:4})
  await until(`document.querySelector('[aria-label="Resize terminal dock"]') === null`)
  await evaluate(`(async () => { const {prefsStore} = await import('/src/state/prefs.ts'); const {applyLiveSnapshot} = await import('/src/state/live-recovery.ts'); const {acp} = await import('/src/state/acp.ts'); prefsStore.set({railGrouping:'project'}); const id = '99999999-9999-4999-8999-999999999999'; applyLiveSnapshot({session:{id,harness:'devin',cwd:'/fixture/only-live-project',title:'Regression live thread',status:'running',connection:'connected',modes:[],currentMode:null,configOptions:[]},revision:1,createdAt:Date.now(),blocks:[],requests:[],permissions:[],base:null}); acp.activate(id); })()`)
  await until(`document.querySelector('.thread-jump-scope [data-folder-toggle][data-tip^="/fixture/only-live-project"]')?.closest('section')?.textContent.includes('Regression live thread')`)
  // A reply streams its first token alone, then the rest and a tool call.
  // The prose is rate-limited while the turn runs, so what is on screen must
  // catch up with the full text before the turn ends; StrictMode once left the
  // first token on screen until the answer finished ("I", then the tools).
  const streamed = "I'll look at what favicon the web UI currently serves and what icon the desktop app uses."
  const batch = (revision, updates, session) => `import('/src/state/live-recovery.ts').then(({applyLiveBatch}) => applyLiveBatch({id:'99999999-9999-4999-8999-999999999999', revision:${revision}, updates:${JSON.stringify(updates)}${session ? `, session:${JSON.stringify(session)}` : ""}}))`
  await evaluate(batch(2, [{ kind: "user", text: "Fix the favicon", requestId: "request-favicon" }, { kind: "text", id: "turn:text:0", text: streamed.slice(0, 1) }]))
  await until(`[...document.querySelectorAll('[data-exchange="acp-request-request-favicon"] .mako-prose')].at(-1)?.dataset.renderedChars === '1'`)
  await evaluate(batch(3, [{ kind: "text", id: "turn:text:0", text: streamed.slice(1) }, { kind: "tool", id: "read-favicon", title: "Read favicon.svg", toolKind: "read", status: "running", input: '{"path":"/fixture/favicon.svg"}' }]))
  {
    const deadline = Date.now() + 3000
    const shown = () => evaluate(`[...document.querySelectorAll('[data-exchange="acp-request-request-favicon"] .mako-prose')].at(-1)?.dataset.renderedChars`)
    while ((await shown()) !== String(streamed.length)) {
      if (Date.now() > deadline) {
        await capture("streamed-prose-stalled.png")
        assert.fail(`Streamed prose stayed at ${await shown()} of ${streamed.length} characters while the turn ran`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-exchange="acp-request-request-favicon"] .mako-prose')].at(-1).textContent`), streamed)
  assert.equal(await evaluate(`document.querySelector('[data-exchange="acp-request-request-favicon"]').textContent.includes('Read')`), true)
  console.log("PASS: streamed prose catches up with the full text while a turn is still running")
  assert.equal(await evaluate(`document.body.textContent.includes('Running now')`), false)
  // The project says nothing of its rows at rest (the calm rail): the working row's own fin does.
  await until(`[...document.querySelectorAll('.thread-jump-scope [data-folder-toggle][data-tip^="/fixture/only-live-project"]')].some((head) => head.closest('section').querySelector('[data-thread-row] [data-live-mark="working"]'))`)
  assert.equal(await evaluate(`document.querySelectorAll('.thread-jump-scope [data-folder-activity]').length`), 0, "no project chips")
  // ⌘ held alone 200 ms: each of the first nine rows shows its ⌘N where its time was, its fin left where it is.
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'rawKeyDown',key:'Meta',code:'MetaLeft',windowsVirtualKeyCode:91,modifiers:4})
  await until(`document.querySelector('.thread-jump-scope[data-jump-hints]') !== null`)
  assert.equal(await evaluate(`(() => { const row = document.querySelector('.thread-jump-scope [data-thread-row][data-jump-index="1"]'); const cap = row.querySelector('[data-jump-cap]'); const mark = row.querySelector('[data-live-mark]').getBoundingClientRect(); const box = cap.getBoundingClientRect(); return cap.textContent === '⌘1' && getComputedStyle(cap).display === 'flex' && box.left > mark.right })()`), true)
  await capture('project-shortcut-hints.png')
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Meta',code:'MetaLeft',windowsVirtualKeyCode:91,modifiers:0})
  await until(`document.querySelector('.thread-jump-scope[data-jump-hints]') === null`)
  await capture("project-view.png")
  const rowSelector = '.thread-jump-scope [data-thread-row][data-jump-index="1"]'
  const move = async (x, y) => { await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }) }
  const rowPoint = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(rowSelector)}).getBoundingClientRect(); return {x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2)} })()`)
  await move(rowPoint.x, rowPoint.y)
  await until(`getComputedStyle(document.querySelector(${JSON.stringify(rowSelector)} + ' button[aria-label^="Actions for "]').parentElement.parentElement).display === 'flex'`)
  await click(`${rowSelector} button[aria-label^="Actions for "]`)
  await until(`document.querySelector('[role="menu"] [data-thread-action="archive"]') !== null`)
  await move(rowPoint.x + 700, rowPoint.y + 400)
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const anchored = await evaluate(`(() => { const trigger = document.querySelector(${JSON.stringify(rowSelector)} + ' button[aria-label^="Actions for "]'); const menu = document.querySelector('[role="menu"]'); const t = trigger.getBoundingClientRect(), m = menu.getBoundingClientRect(); return {hover: document.querySelector(${JSON.stringify(rowSelector)}).matches(':hover'), pill: getComputedStyle(trigger.parentElement.parentElement).display, triggerWidth: t.width, gap: m.top - t.bottom, right: Math.abs(m.right - t.right)} })()`)
  assert.equal(anchored.hover, false, "The pointer must have left the row")
  assert.equal(anchored.pill, "flex", "The control pill stays visible while its menu is open")
  assert.ok(anchored.triggerWidth > 0, "An open menu keeps a measurable trigger")
  assert.ok(anchored.gap >= 0 && anchored.gap <= 12 && anchored.right <= 2, `The menu stays anchored to its button, received ${JSON.stringify(anchored)}`)
  await capture("thread-actions-anchored.png")
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await page.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await until(`document.querySelector('[role="menu"]') === null`)
  console.log("PASS: a row's actions menu stays anchored after the pointer leaves the row")
  // The flat recent view is the rail's "Show" choice now (#337 removed the "Thread view" toggle): the same pref.
  await evaluate(`import('/src/state/prefs.ts').then(({setPref}) => setPref('railGrouping', 'recent'))`)
  await until(`document.querySelector('.thread-jump-scope [data-folder-toggle][data-tip^="/fixture/only-live-project"]') === null`)
  assert.ok(await evaluate(`document.querySelectorAll('[data-thread-row]').length`) <= 80)
  await capture("recent-view.png")
  console.log("PASS: project-owned running sessions, no global running bucket, and a bounded recent view")
  await window.loadURL(`${base}scripts/live-workflow.html?format`)
  await until(`document.querySelector('.prompt-prose li strong')?.textContent === '85'`)
  await evaluate("document.fonts.ready.then(() => true)")
  const gap = await evaluate(`document.querySelector('.prompt-prose > p').getBoundingClientRect().top - document.querySelector('.prompt-prose > ul').getBoundingClientRect().bottom`)
  assert.ok(gap >= 0 && gap <= 24, `The paragraph gap must be compact, received ${gap}px`)
  await evaluate(`import('/src/lib/bridge.ts').then(({getMako}) => { getMako().copy = async text => { window.copiedText = text } })`)
  await click('[aria-label="Copy question"]', { exposed: true })
  await until(`window.copiedText === document.querySelector('#prompt-format').dataset.source`)
  await capture("prompt-format.png")
  console.log("PASS: exact reported Markdown renders a bold bullet with a compact paragraph gap; copying preserves the original text")
  await window.loadURL(`${base}scripts/live-workflow.html?motion`)
  await until(`document.querySelectorAll('canvas.activity-orb').length === 6 && [...document.querySelectorAll('canvas.activity-orb')].every(canvas => canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some(value => value > 0))`)
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('canvas.activity-orb')].map(canvas => canvas.toDataURL())).size`), 6)
  const benchmark = await evaluate(`window.makoActivityBenchmark()`)
  await writeFile(join(root, 'activity-benchmark.json'), JSON.stringify(benchmark, null, 2))
  console.log('Activity draw measurements:', JSON.stringify(benchmark))
  await capture('activity-states.png')
  if (process.env.MAKO_RECORD_MOTION === '1') {
    const frames = []
    for (let frame = 0; frame < 36; frame++) {
      const file = `activity-${String(frame).padStart(3,'0')}.png`
      await capture(file)
      frames.push({file, at:performance.now()})
      await new Promise((resolve) => setTimeout(resolve, 83))
    }
    await writeFile(join(root, 'activity.frames'), frames.map((frame,index) => `file ${frame.file}\nduration ${((frames[index+1]?.at ?? frame.at + 83) - frame.at) / 1000}\n`).join(''))
  }
  if (process.env.MAKO_REAL_UI_URL) {
    await window.loadURL(process.env.MAKO_REAL_UI_URL)
    await until(`import('/src/state/session.ts').then(({store}) => store.get().phase === 'ready' && Boolean(store.get().meta?.cwd))`)
    await evaluate(`import('/src/state/session.ts').then(({actions,store}) => actions.newConversationIn(store.get().sourceRoot))`)
    await until(`Boolean(document.querySelector('.composer-input')) && document.querySelectorAll('[data-thread-row]').length > 0`)
    await capture("real-host.png")
    console.log("PASS: real host boot, native session catalog, and composer render without starting an agent")
  }
  console.log("PASS: composer geometry, native backspace, one send during staging, previews, narrow prompt navigation, reduced motion, idle cleanup, deferred updates, project drafts, reload, and side-by-side draft isolation")
  clearTimeout(watchdog)
  window.destroy()
  app.exit(0)
}
