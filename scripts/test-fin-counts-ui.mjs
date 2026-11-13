import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/*
 * Every surface that counts an Apex's Fins, drawn from one roster, says the same numbers in the same words: the
 * composer's chip, the crew card, the rail's pips, the Agents panel, the stop card and the phone's row. Written for
 * what the person saw: "Waiting on 4 agents" over "3 Fins working", because the old line counted an idle Fin as
 * work and called Fins agents. On the mock bridge's Apex scene (`?mock&app=apex`), with its roster set to three
 * Fins working (their steps raw shell commands under a home folder) and one idle. Each surface carries the words it
 * drew in `data-fin-counts` and shows its numbers in its text; both are read. Pass a dev server's URL to use it;
 * with none it serves its own.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-fin-counts-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-counts-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_FIN_COUNTS_ROOT: root, MAKO_FIN_COUNTS_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

/** The numbers a surface's words say, by group: "4 Fins · 3 working · 1 idle". */
function numbers(words) {
  const found = {}
  for (const [key, pattern] of [
    ["total", /(\d+) Fins?\b/],
    ["needs", /(\d+) needs? you/],
    ["working", /(\d+) working/],
    ["queued", /(\d+) queued/],
    ["idle", /(\d+) idle/],
    ["failed", /(\d+) failed/],
    ["done", /(\d+) done/],
  ]) {
    const match = pattern.exec(words)
    if (match) found[key] = Number(match[1])
  }
  return found
}

/** Every number `shown` says agrees with `truth`. */
function agrees(surface, words, truth) {
  const shown = numbers(words)
  assert.ok(Object.keys(shown).length > 0, `${surface} says how many: "${words}"`)
  for (const [key, value] of Object.entries(shown)) assert.equal(value, truth[key], `${surface} says ${value} ${key}, the roster ${truth[key]}: "${words}"`)
  assert.doesNotMatch(words, /\bagents?\b/i, `${surface} calls them Fins: "${words}"`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_FIN_COUNTS_ROOT
  await mkdir(join(root, "shots"), { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_FIN_COUNTS_URL
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  atSize(window, 1440, 900)
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, " ") ?? ""`)
  const counts = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.dataset.finCounts ?? ""`)

  await window.loadURL(`${base}?mock&app=apex`)
  await until("[...document.querySelectorAll('[data-thread-row]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
  await evaluate("window.apexScene.setRunning(false); true")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card")

  // Three Fins at work, their steps as a harness reports them, and one idle: the screenshot's crew.
  await evaluate(`(() => {
    const steps = [
      "Shell cd /Users/someone/.mako/worktrees/makomono-0a1b2c3d/dogfood && npm run typecheck",
      "Shell gh pr checks 340 -R Verbiflow/mako 2>&1 | awk '{print $1, $2}'",
      "Read /Users/someone/makomono/mako/src/web-client/desk.tsx",
    ]
    const four = window.apexScene.children().slice(0, 4).map((agent, index) => index < 3
      ? { ...agent, state: { kind: "working", activity: steps[index] }, child: { ...agent.child, state: { kind: "working", step: steps[index] } } }
      : { ...agent, state: { kind: "waiting" }, child: { ...agent.child, state: { kind: "idle" } } })
    window.apexScene.setChildren(four)
    return true
  })()`)
  const truth = { total: 4, needs: 0, working: 3, queued: 0, idle: 1, failed: 0, done: 0 }
  const label = "4 Fins: 3 working · 1 idle"
  await until(`document.querySelector('[data-crew] [data-fin-counts]')?.dataset.finCounts === ${JSON.stringify(label)}`, "the crew card on the new roster")
  await until(`document.querySelector('[data-agents-toggle]')?.dataset.finCounts === ${JSON.stringify(label)}`, "the composer's chip on the new roster")

  const surfaces = {
    "the composer's chip": "[data-agents-toggle]",
    "the crew card": "[data-crew] header",
    "the rail's pips": "[data-thread-row] [data-fin-pips]",
  }
  for (const [surface, selector] of Object.entries(surfaces)) {
    const at = selector === "[data-crew] header" ? "[data-crew] [data-fin-counts]" : selector
    assert.equal(await counts(at), label, `${surface} counts the roster as every surface does`)
    // The composer's chip shows the count and says the rest by its name, the line its tooltip reads.
    const words = selector === "[data-agents-toggle]" ? await evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-label") ?? ""`) : await text(selector)
    agrees(surface, words, truth)
  }
  assert.equal(await evaluate("document.querySelector('[data-thread-row] [data-fin-pips]').dataset.finPips"), "wwwi", "one pip per Fin: three working, one idle")

  // No Fin needs the person, so the Apex's row stops saying so; its mark is the slower comet of work that runs on.
  await until("![...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish'))?.innerText.includes('Needs you')", "the Apex's row standing down from Needs you")
  assert.equal(await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish')).querySelector('[data-live-mark]')?.dataset.liveMark"), "background", "the Apex's mark says its Fins work on")

  // Nothing says the Apex waits: its turn ended, and its Fins are the crew card's, not a background line's.
  assert.equal(await evaluate("Boolean(document.querySelector('[data-background-work]'))"), false, "no background line beside the crew card")
  assert.doesNotMatch(await text("[data-composer]"), /Waiting on/, "no 'Waiting on' over the composer")

  // Steps are phrases: no home folder, no shell plumbing. The idle Fin is under the settled line, opened.
  await evaluate("(() => { const el = document.querySelector('[data-crew-scroller]'); if (el) el.scrollTop = el.scrollHeight; const line = document.querySelector('[data-crew-settled=folded]'); line?.click(); return true })()")
  await until("document.querySelector('[data-crew-settled]')?.dataset.crewSettled === 'open'", "the settled line opening")
  const rows = await evaluate("[...document.querySelectorAll('[data-crew-row]')].map((row) => row.innerText.replace(/\\s+/g, ' '))")
  for (const row of rows) assert.doesNotMatch(row, /\/Users\/|2>&1|&&|\| awk/, `a Fin's step is a phrase: "${row}"`)
  assert.ok(rows.some((row) => row.includes("Running gh pr checks 340")), `the shell step reads as what it does: ${JSON.stringify(rows)}`)
  assert.ok(rows.some((row) => row.includes("Reading desk.tsx")), `the read names its file: ${JSON.stringify(rows)}`)
  assert.ok(rows.some((row) => /\bIdle\b/.test(row)), `the idle Fin says it's idle: ${JSON.stringify(rows)}`)

  // The Agents panel, opened from the chip, counts the same.
  await evaluate("document.querySelector('[data-agents-toggle]').click(); true")
  await until("Boolean(document.querySelector('[data-apex-fins]'))", "the Agents panel's Fins")
  assert.equal(await counts("[data-apex-fins]"), label, "the Agents panel counts the roster as every surface does")
  agrees("the Agents panel", await text("[data-apex-fins] > div"), truth)

  // The stop card, opened from the composer's stop, counts the same.
  const stop = await evaluate("(() => { const button = document.querySelector('[data-composer] button[aria-label^=\"Stop\"]'); if (!button) return false; button.click(); return true })()")
  if (stop) {
    await until("Boolean(document.querySelector('[data-stop-apex]'))", "the stop card")
    assert.equal(await counts("[data-stop-apex]"), label, "the stop card counts the roster as every surface does")
    agrees("the stop card", await text("[data-stop-apex] > div"), truth)
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true")
  }
  await page.capturePage().then((image) => writeFile(join(root, "shots", "desktop.png"), image.toPNG()))

  // The phone's list, on the fixture's twelve Fins, counts them as the desktop's rail does on the same roster.
  await window.loadURL(`${base}?mock&app=apex`)
  await until("Boolean(document.querySelector('[data-thread-row] [data-fin-pips]'))", "the desktop rail's pips")
  const desktop = await counts("[data-thread-row] [data-fin-pips]")
  await window.loadURL(`${base}scripts/phone-apex.html`)
  await until("Boolean(document.querySelector('[data-fin-pips]'))", "the phone row's pips")
  assert.equal(await counts("[data-fin-pips]"), desktop, "the phone's row counts the Fins as the desktop's rail does")
  agrees("the phone's row", await evaluate("document.querySelector('[data-fin-pips]').getAttribute('aria-label')"), numbers(desktop))

  // An older Session of the Apex on screen, its own roster empty, its Thread's Fins in the newest Session's: the chip
  // shows them, as every surface reads a Session's Fins from its Thread (`conversationRoster`). #524's third review
  // found it hidden, counting the Session's own roster.
  await window.loadURL(`${base}?mock&app=apex`)
  await until("[...document.querySelectorAll('[data-thread-row]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row again")
  await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-agents-toggle]'))", "the composer's chip on the Apex's newest Session")
  const fins = await evaluate(`(async () => {
    const { acpStore, threadChildren } = await import('/src/state/acp-state.ts')
    const state = acpStore.get()
    const shown = state.conversations[state.activeKey]
    const older = crypto.randomUUID(), newer = crypto.randomUUID(), newerKey = crypto.randomUUID()
    acpStore.set({
      conversations: { ...state.conversations, [shown.key]: { ...shown, sessionId: older, nativeAgents: { agents: [], limited: false } }, [newerKey]: { ...shown, key: newerKey, sessionId: newer, session: { ...shown.session, id: newerKey } } },
      threadSessions: { ...state.threadSessions, [shown.threadId]: [older, newer] },
    })
    return threadChildren(acpStore.get(), shown.threadId).length
  })()`)
  assert.ok(fins > 0, "the Thread has its Fins in its newest Session")
  await until("Boolean(document.querySelector('[data-agents-toggle]'))", "the composer's chip on an older Session with an empty roster")
  assert.match(await counts("[data-agents-toggle]"), new RegExp(`^${fins} Fins`), "counting the Thread's Fins")

  console.log(`Fin counts agree on every surface: ${label}; on the phone, ${desktop}; and on an older Session, its Thread's ${fins}`)
  app.exit(0)
}
