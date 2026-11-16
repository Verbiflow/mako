import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

// A limit's one notice on the production components and the mock bridge's Apex scene as an account ran out
// (`?mock&app=apex&fins=limit`), on the desk, the phone and the laptop's browser. Screenshots of each surface, dark and
// light, land in the printed folder (or `MAKO_LIMIT_UI_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-limit-notice-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-limit-notice-ui", main: fileURLToPath(import.meta.url) }))
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, fs: { strict: false }, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_LIMIT_UI_ROOT: root, MAKO_LIMIT_UI_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_LIMIT_UI_ROOT
  const shots = process.env.MAKO_LIMIT_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  // A page that never loads is a failure here, not a job left to time out.
  setTimeout(() => {
    console.error("The limit notice's UI check took over eight minutes")
    app.exit(1)
  }, 480_000).unref()
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const base = process.env.MAKO_LIMIT_UI_URL
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    // Generous: a cold dev server bundles its dependencies and reloads the page first. Nothing here is timed.
    const deadline = Date.now() + 120_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  /** The page at rest: fonts in and animations done, or a moment on, since a hidden window may never draw their frames. */
  const settle = () =>
    evaluate("Promise.race([document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => undefined)))), new Promise((done) => setTimeout(done, 1500))]).then(() => true)")
  /** The viewport a surface is drawn at, whatever the screen: a runner's 1024 px one clamps the window. A page first: emulating a window that has drawn nothing crashes. */
  const viewport = async (width, height, mobile = false) => {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
    await page.debugger.sendCommand("Emulation.setScrollbarsHidden", { hidden: true })
  }
  const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
  /** The element `selector` names (a selector with no quote in it), cropped with a margin, in both themes. */
  const shoot = async (name, selector) => {
    const files = []
    for (const light of [false, true]) {
      await theme(light)
      await settle()
      const rect = await evaluate(`(() => { const node = document.querySelector('${selector}'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x - 12)), y: Math.max(0, Math.floor(r.y - 12)), width: Math.ceil(r.width + 24), height: Math.ceil(r.height + 24) } })()`)
      await settle()
      const file = join(shots, `${name}-${light ? "light" : "dark"}.png`)
      await writeFile(file, (await page.capturePage(rect)).toPNG())
      files.push(file)
    }
    await theme(false)
    console.log(`SHOTS ${files.join(" ")}`)
  }

  // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the waits after it hold.
  const load = (url) => window.loadURL(url).catch((error) => {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
  })
  const text = (selector) => evaluate(`document.querySelector('${selector}')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
  const rows = (selector) => evaluate(`[...document.querySelectorAll('${selector}')].map((node) => node.innerText.replace(/\\s+/g, ' '))`)
  /** The whole window, in both themes: for what's a screen, not one element. */
  const screen = async (name, setTheme = theme) => {
    const files = []
    for (const light of [false, true]) {
      await setTheme(light)
      await settle()
      const file = join(shots, `${name}-${light ? "light" : "dark"}.png`)
      await writeFile(file, (await page.capturePage()).toPNG())
      files.push(file)
    }
    await setTheme(false)
    console.log(`SHOTS ${files.join(" ")}`)
  }
  const LINE = "Cursor ran out until Sun 12:00 AM PST. 3 Fins moved to Claude Code. 1 Fin has nowhere to go. 7 reports are waiting for their Apex."
  const MOVED = "Moved to Claude Code"
  const OUT = "Out of accounts until Sun 12:00 AM PST: Cursor and Claude Code (work)"

  await viewport(1440, 900)
  console.log("LOADING the desk")
  await load(`${base}?mock&app=apex&fins=limit`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
  await evaluate("window.apexScene.setRunning(false); true")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card")
  await settle()

  console.log("LOADED the desk")
  // 1. The crew card: a move reads as one, a Fin out of accounts stands apart from what finished, never folded.
  const header = await text("[data-crew] header")
  assert.match(header, /1 failed/, `an unfinished Fin counts apart from done: ${header}`)
  const moved = await rows("[data-crew] [data-crew-row] [data-fin-moved]")
  assert.equal(moved.length, 3, `three moved, all of them on the card: ${moved}`)
  assert.ok(moved.every((line) => line.startsWith(MOVED)), `a moved Fin says so: ${moved}`)
  assert.equal(await text("[data-crew] [data-limit-notice]"), `${LINE} Got it`, "the Thread itself says the notice, with its one answer")
  await shoot("crew-card", "[data-crew]")
  await evaluate("(() => { const el = document.querySelector('[data-crew-scroller]'); el.scrollTop = el.scrollHeight; return true })()")
  await settle()
  await until("[...document.querySelectorAll('[data-crew] [data-crew-row]')].some((node) => node.innerText.includes('Review screen hunks'))", "the Fin out of accounts")
  const out = await evaluate("(() => { const node = [...document.querySelectorAll('[data-crew] [data-crew-row]')].find((each) => each.innerText.includes('Review screen hunks')); return { group: node.dataset.childGroup, text: node.innerText.replace(/\\s+/g, ' '), moved: Boolean(node.querySelector('[data-fin-moved]')) } })()")
  console.log("OUT", JSON.stringify(out))
  assert.equal(out.group, "failed", "a Fin out of accounts never reads as done")
  assert.ok(out.text.includes(OUT), "and says why, once")
  assert.equal(out.moved, false, "without the arrows: it didn't move")
  assert.equal(await evaluate("[...document.querySelectorAll('[data-crew] [data-crew-row]')].find((each) => each.innerText.includes('Review screen hunks')).querySelector('[data-live-mark]')?.dataset.liveMark"), "failed", "its mark says it stopped, as its group does")
  assert.equal(await evaluate("[...document.querySelectorAll('[data-crew] [data-crew-row]')].find((each) => each.innerText.includes('Review screen hunks')).querySelector('[title^=Out]')?.title ?? ''"), OUT, "its whole line is one hover away, where the row cuts it")
  await shoot("crew-card-end", "[data-crew]")
  await evaluate("(() => { const el = document.querySelector('[data-crew-scroller]'); el.scrollTop = 0; return true })()")
  console.log("PASS: the crew card shows moves, and a Fin out of accounts apart from what finished")

  // 2. The Thread says it once, and the composer warned before the wall.
  await until(`[...document.querySelectorAll('[data-fin-asks], [data-composer]')].length > 0`, "the composer")
  const asks = await evaluate("document.querySelector('[data-fin-asks]')?.innerText.replace(/\\s+/g, ' ') ?? ''")
  console.log("FIN ASKS", asks.slice(0, 240))
  await evaluate(`import('/src/state/accounts.ts').then(({ accounts, accountsStore }) => { accountsStore.set({ providers: [{ provider: 'claude', label: 'Claude Code', mode: 'selectable', loginCommand: 'claude login' }], accounts: [{ harness: 'claude', name: 'default', email: 'you@example.com', active: true }] }); accounts.offered({ harness: 'claude', because: 'near-limit', from: { name: 'default', email: 'you@example.com', window: { usedPercent: 92, windowMinutes: 10080, resetsAt: Date.now() + 86400000, scope: 'account' } } }) })`)
  await until("Boolean(document.querySelector('[data-account-limit]'))", "the warning before the wall")
  const warned = await text("[data-account-limit]")
  console.log("WARNING", warned)
  assert.match(warned, /When it runs out, Fins go on with your next harness/)
  await evaluate("import('/src/state/fin-defaults.ts').then(({ chooseMoveOnLimit }) => chooseMoveOnLimit(false))")
  await until("document.querySelector('[data-account-limit]')?.innerText.includes('Fins wait until it resets')", "the warning with the switch off")
  assert.doesNotMatch(await text("[data-account-limit]"), /go on/, "with Settings' switch off, Fins don't go on")
  await evaluate("import('/src/state/fin-defaults.ts').then(({ chooseMoveOnLimit }) => chooseMoveOnLimit(true))")
  await until("document.querySelector('[data-account-limit]')?.innerText.includes('go on')", "the warning with the switch on")
  assert.doesNotMatch(warned, /Switch to/, "one account has nothing to switch to")
  await shoot("warning-before-the-limit", "[data-account-limit]")
  await evaluate(`import('/src/state/accounts.ts').then(({ accounts }) => accounts.declineOffer('claude'))`)
  await evaluate(`(() => { const node = [...document.querySelectorAll('*')].find((each) => each.children.length <= 2 && each.innerText?.startsWith('Cursor ran out until') && each.innerText.includes('moved to Claude Code')); node?.setAttribute('data-limit-test', 'line'); node?.scrollIntoView({ block: 'center' }); return Boolean(node) })()`)
  await until("Boolean(document.querySelector('[data-limit-test=line]'))", "the transcript's line")
  await shoot("thread-line", "[data-limit-test=line]")
  const said = await text("[data-limit-test=line]")
  console.log("THREAD LINE", said)
  assert.ok(said.startsWith("Cursor ran out until Sun 12:00 AM PST"), "the transcript says what ran out, until when")
  assert.equal(said.split("ran out").length, 2, "once")
  console.log("PASS: the Thread says it once, and warns before the wall")

  // 3. The Inbox: one notice for the tree, whole, and Got it ends it there.
  await evaluate("document.querySelector('[data-rail-top-row=\"inbox\"]').click(); true")
  await until("Boolean(document.querySelector('[data-inbox]'))", "the Inbox")
  await settle()
  const items = await rows("[data-inbox-item]")
  assert.equal(items.filter((item) => item.includes("ran out")).length, 1, `one notice, not one per Fin: ${items}`)
  assert.ok(items.some((item) => item.includes(LINE) && item.includes("Got it")), "whole, with its one answer")
  assert.ok(items.some((item) => item.includes("Usage · Cursor")), `named for the harness that ran out, not where a Fin went: ${items}`)
  await shoot("inbox", "[data-inbox]")
  await evaluate("[...document.querySelectorAll('[data-inbox-item]')].find((each) => each.innerText.includes('ran out')).querySelector('[data-inbox-answer=\"0\"]').click(); true")
  await until("window.apexScene.responds().length === 1", "Got it reaching the host")
  assert.match(await evaluate("window.apexScene.responds()[0].ask"), /^limit:/)
  await until("![...document.querySelectorAll('[data-inbox-item]')].some((each) => each.innerText.includes('ran out'))", "the notice to leave the Inbox")
  console.log("PASS: one notice in the Inbox, and Got it ends it")

  // 4. The phone: its row, its Inbox, its Thread and its Agents sheet, the moved line whole.
  const phoneTheme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.classList.toggle('dark', ${!light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
  await viewport(390, 844, true)
  await load(`${base}scripts/phone-apex.html?app=apex&fins=limit`)
  await until("document.querySelectorAll('[data-fin-row]').length > 0", "the phone's rows")
  await settle()
  const phone = await rows("[data-fin-row]")
  assert.equal(phone.filter((row) => row.includes("ran out")).length, 1, `one row on the phone: ${phone}`)
  await screen("phone-list", phoneTheme)
  await evaluate("[...document.querySelectorAll('button, a')].find((each) => each.innerText.trim().startsWith('Inbox')).click(); true")
  await until("[...document.querySelectorAll('[data-inbox-item], [data-fin-row]')].some((each) => each.innerText.includes('ran out'))", "the phone's Inbox")
  await settle()
  await screen("phone-inbox", phoneTheme)
  await load(`${base}scripts/phone-apex.html?app=apex&fins=limit`)
  await until("document.querySelectorAll('[data-fin-row]').length > 0", "the phone's rows")
  await evaluate("[...document.querySelectorAll('button, a')].find((each) => each.innerText.includes('Mobile polish') && each.innerText.includes('12 Fins')).click(); true")
  await until("Boolean(document.querySelector('[data-apex-count]'))", "the phone's Thread")
  // The notice stands in the crew card, which mounts after the bar does: the card is what a read of it waits for.
  await until("Boolean(document.querySelector('[data-crew]'))", "the phone's crew card")
  await settle()
  assert.equal(await evaluate("document.querySelectorAll('[data-limit-notice]').length"), 1, "a phone's Thread says the notice once")
  assert.ok(await evaluate("Boolean(document.querySelector('[data-limit-notice] [data-limit-seen]'))"), "and Got it is there")
  // A long line ends in its ellipsis, short of the time: a `nowrap` line takes its whole width unless the row gives it one.
  const crew = await evaluate("[...document.querySelectorAll('button[data-crew-row]')].map((row) => ({ text: row.innerText, over: [...row.querySelectorAll('.truncate')].some((each) => each.getBoundingClientRect().right > row.children[1].getBoundingClientRect().right + 1) }))")
  assert.ok(crew.length > 0, "the phone's crew rows")
  assert.deepEqual(crew.filter((row) => row.over).map((row) => row.text), [], "a phone's crew line stops short of its time")
  await screen("phone-thread", phoneTheme)
  await evaluate("document.querySelector('[data-apex-count]').click(); true")
  await until("Boolean(document.querySelector('[data-agents-sheet]'))", "the phone's Agents sheet")
  await settle()
  await screen("phone-agents", phoneTheme)
  const line = await evaluate("(() => { const node = document.querySelector('[data-agents-sheet] [data-fin-moved] span'); return node ? { lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), text: node.innerText, cut: node.scrollHeight > node.clientHeight + 1 } : null })()")
  console.log("PHONE MOVED", JSON.stringify(line))
  assert.ok(line, "the sheet shows the move")
  assert.equal(line.cut, false, "and all of it, on a phone with no hover to read the rest")
  console.log("PASS: the phone shows the notice once, and a move whole")

  // 5. The laptop's browser: the Apex's Fins and their moves are on its crew card, its only list.
  await viewport(1280, 800)
  await load(`${base}scripts/web-desk.html?app=apex&thread=apex&fins=limit`)
  await until("document.querySelectorAll('[data-crew] [data-crew-row]').length > 0 || document.body.innerText.includes('Mobile polish')", "the laptop's Apex")
  await settle()
  await new Promise((done) => setTimeout(done, 800))
  const web = await rows("[data-crew] [data-crew-row] [data-fin-moved]")
  console.log("LAPTOP", JSON.stringify(web.slice(0, 4)))
  await screen("laptop", phoneTheme)
  assert.equal(web.length, 3, "the laptop's browser shows the moves")
  console.log("PASS: the laptop's browser shows the moves")

  // 6. An Apex whose only Needs you is the notice: where the rail points, the notice stands and Got it ends it.
  await viewport(1440, 900)
  await load(`${base}?mock&app=apex&fins=limit`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row again")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer again")
  await evaluate("window.apexScene.setRunning(false); true")
  await until("Boolean(document.querySelector('[data-crew] [data-limit-notice]'))", "the notice on the card")
  await evaluate("document.querySelector('[data-crew] [data-fin-ask] [data-fin-answer]').click(); true")
  await until("!document.querySelector('[data-crew] [data-fin-ask]')", "the other ask answered")
  await settle()
  assert.equal(await evaluate("document.querySelectorAll('[data-crew-needs]').length"), 0, "no Fin needs the person now")
  assert.equal(await text("[data-limit-notice]"), `${LINE} Got it`, "the notice alone still stands in the Thread")
  await shoot("thread-notice", "[data-crew]")
  // Banner and mark: it asks nothing, so it says so, and the banner's line isn't a name and a cut.
  const banner = await evaluate(`Promise.all([import('/src/state/acp-live.ts'), import('/src/state/acp.ts')]).then(([{ noteFinAsks }, { acpStore, activeAcp }]) => { noteFinAsks({ ...activeAcp(acpStore.get()), key: 'banner-probe' }); const item = window.mockState.notifications().items.find((each) => each.id.includes(':limit:')); return item && { kind: item.kind, body: item.body } })`)
  assert.equal(banner?.kind, "needs-you", "a notice is no question")
  assert.ok(banner?.body.startsWith("Cursor ran out until"), `its words lead the banner: ${banner?.body}`)
  // Scrolled away, the line over the composer brings it back.
  const thread = await evaluate("import('/src/state/acp.ts').then(({ acpStore, activeAcp }) => activeAcp(acpStore.get()).threadId)")
  await evaluate(`import('/src/state/crew-card-view.ts').then(({ mountCrewCard }) => mountCrewCard(${JSON.stringify(thread)}, false))`)
  await until("Boolean(document.querySelector('[data-crew-away]'))", "the line over the composer")
  assert.equal(await text("[data-crew-away]"), "Usage needs you", "the card away, the notice's line says so")
  await evaluate(`import('/src/state/crew-card-view.ts').then(({ mountCrewCard }) => mountCrewCard(${JSON.stringify(thread)}, true))`)
  await evaluate("document.querySelector('[data-limit-seen]').click(); true")
  await until("!document.querySelector('[data-limit-notice]')", "Got it ending it in the Thread")
  assert.ok((await evaluate("window.apexScene.responds()")).some((respond) => respond.ask.startsWith("limit:")), "and telling the host")
  console.log("PASS: the Thread holds the notice, whatever else needs the person")

  // 7. A Thread Mako doesn't move by itself: one card, saying what holds it, and one press.
  const HOLD_AT_LIMIT = `import('/src/state/acp.ts').then(({ acpStore, activeAcp }) => { const state = acpStore.get(); const current = activeAcp(state); const at = Date.now() + 3 * 60 * 60_000; acpStore.set({ conversations: { ...state.conversations, [current.key]: { ...current, requests: [...(current.requests ?? []), { id: 'held-at-limit', text: 'Keep going.', attachments: [], status: 'held', retry: { at, until: at, attempt: 1, since: Date.now(), cause: 'rate-limited', reason: "You've hit your usage limit" } }] } } }) })`
  await evaluate(HOLD_AT_LIMIT)
  await until("Boolean(document.querySelector('[data-limit-continue]'))", "the card")
  assert.match(await text("[data-limit-continue]"), /Codex can take this.*Continue on Codex.*Not now/, "only the choice, as its queue row says what holds it")
  assert.equal(await evaluate("document.querySelectorAll('[data-limit-continue]').length"), 1, "one card")
  await shoot("continue-card", "[data-limit-continue]")
  // Another account to switch to is the same decision: one winner, not a stack.
  await evaluate("Promise.all([import('/src/state/accounts.ts'), import('/src/state/acp.ts')]).then(([{ accountsStore }, { acpStore, activeAcp }]) => { const harness = activeAcp(acpStore.get()).harness; accountsStore.set({ limitOffers: { [harness]: { harness, because: 'refused', from: { name: 'personal' }, to: { name: 'work' } } } }) })")
  await until("!document.querySelector('[data-limit-continue]')", "the account offer to win")
  await evaluate("import('/src/state/accounts.ts').then(({ accountsStore }) => accountsStore.set({ limitOffers: {} }))")
  await until("Boolean(document.querySelector('[data-limit-continue]'))", "the card back")
  await evaluate("[...document.querySelectorAll('[data-limit-continue] button')].find((each) => each.innerText.includes('Continue on')).click(); true")
  await until("window.apexScene.continues().length === 1", "the press to reach the host")
  assert.deepEqual(await evaluate("window.apexScene.continues()"), [await evaluate("import('/src/state/acp.ts').then(({ acpStore, activeAcp }) => activeAcp(acpStore.get()).key)")], "for this Thread, once")
  // The laptop's browser and a phone's dock have it too: being away from the desk is when it's needed.
  for (const [name, width, height, mobile, path] of [["laptop-continue", 1280, 800, false, "scripts/web-desk.html?app=apex&thread=apex&fins=limit"], ["phone-continue", 390, 844, true, "scripts/phone-apex.html?app=apex&fins=limit"]]) {
    await viewport(width, height, mobile)
    await load(`${base}${path}`)
    if (mobile) {
      await until("document.querySelectorAll('[data-fin-row]').length > 0", `${name}: its rows`)
      await evaluate("[...document.querySelectorAll('button, a')].find((each) => each.innerText.includes('Mobile polish') && each.innerText.includes('12 Fins')).click(); true")
    }
    await until("Boolean(document.querySelector('[data-apex-count], [data-crew]'))", `${name}: its Thread`)
    // A phone's page opens the Thread before its conversation is the active one.
    for (const deadline = Date.now() + 30_000; !(await evaluate("import('/src/state/acp.ts').then(({ acpStore, activeAcp }) => Boolean(activeAcp(acpStore.get())))")); await new Promise((done) => setTimeout(done, 100))) assert.ok(Date.now() < deadline, `${name}: its conversation`)
    await evaluate(HOLD_AT_LIMIT)
    await until("Boolean(document.querySelector('[data-limit-continue]'))", `${name}: the card`)
    assert.match(await text("[data-limit-continue]"), /Continue on Codex.*Not now/, `${name}: the same offer`)
    await shoot(name, "[data-limit-continue]")
    await evaluate("[...document.querySelectorAll('[data-limit-continue] button')].find((each) => each.innerText.includes('Not now')).click(); true")
    await until("!document.querySelector('[data-limit-continue]')", `${name}: Not now ends it`)
  }
  console.log("PASS: a Thread a limit holds gets one card, on the desk, the laptop's browser and a phone")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Limit notice UI: passed")
  app.exit(0)
}
