import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The crew card (`crew-card.tsx`) that replaces "Waiting on N agents" at the end of an Apex's own transcript once
// its own turn settles and its Fins still work, on the mock bridge's Apex scene (`?mock&app=apex`): every Fin
// shown, needs-you first, an ask answered in place through the same action the Agents panel and the dock use,
// moving the Fin everywhere at once (the card, its tab, the rail's badge); forty Fins, bounded and scrolled; the
// phone's compact card; and that a Fin's own step re-renders its row alone, not the card's heavier rows. Screenshots
// land in the evidence folder (or `MAKO_CREW_UI_SHOTS`). Pass a dev server's URL to use it
// (`node scripts/test-crew-card-ui.mjs http://127.0.0.1:20026/`); with none it serves its own.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-crew-card-ui-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-crew-card-ui",
      main: fileURLToPath(import.meta.url),
    })
  )
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { createServer } = await import("vite")
    server = await createServer({
      cacheDir: join(root, "cache"),
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        watch: { ignored: ["**"] },
      },
    })
    await server.listen()
  }
  const env = {
    ...process.env,
    MAKO_CREW_UI_ROOT: root,
    MAKO_CREW_UI_URL: given ?? server.resolvedUrls.local[0],
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], {
      stdio: "inherit",
      env,
    })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Crew card UI evidence: ${root}`)
}

/**
 * Counts each commit's renders by component, as React DevTools does: a fiber rendered in a commit if it did work
 * (`PerformedWork`) and began anew (`actualStartTime`, which a subtree React skipped keeps). Installed before React
 * loads, in the counting window only: the walk costs frames. Adapted from `test-orch-ui.mjs`'s own, without its
 * areas (the crew card has none of its own, only components).
 */
const COMMIT_COUNTER = `
const PERFORMED = 1
const began = new WeakMap()
let tally = { commits: 0, components: {} }
const nameOf = (type) => (typeof type === "function" ? type.displayName || type.name : type && typeof type === "object" ? type.displayName || nameOf(type.type) || nameOf(type.render) : undefined)
function walk(fiber) {
  for (; fiber; fiber = fiber.sibling) {
    const name = nameOf(fiber.type)
    if (typeof fiber.type !== "string" && fiber.flags & PERFORMED && began.get(fiber) !== fiber.actualStartTime) {
      if (name) tally.components[name] = (tally.components[name] ?? 0) + 1
    }
    began.set(fiber, fiber.actualStartTime)
    walk(fiber.child)
  }
}
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot(_, root) {
    tally.commits++
    walk(root.current)
  },
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  checkDCE() {},
}
window.__benchTally = () => JSON.parse(JSON.stringify(tally))
window.__benchReset = () => (tally = { commits: 0, components: {} })
`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_CREW_UI_ROOT
  const shots = process.env.MAKO_CREW_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const base = process.env.MAKO_CREW_UI_URL
  const preload = join(root, "commit-counter.cjs")
  await writeFile(preload, COMMIT_COUNTER)

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      preload,
      contextIsolation: false,
      sandbox: false,
    },
  })
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`
        )
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const settle = () =>
    evaluate(
      "document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => undefined)))).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => true)"
    )
  const capture = async (name) => {
    await settle()
    await writeFile(
      join(shots, `crew-card-ui-${name}.png`),
      (await page.capturePage()).toPNG()
    )
  }
  const theme = (light) =>
    evaluate(
      `document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`
    )
  const both = async (name) => {
    await theme(false)
    await capture(`${name}-dark`)
    await theme(true)
    await capture(`${name}-light`)
    await theme(false)
  }
  const click = (selector) =>
    evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true })()`
    )
  // The card virtualizes past its own height, so a row off screen isn't in the DOM yet: scroll its own scroller
  // top to bottom, a screenful at a time, collecting every row once, in the order it comes into view (the order
  // it's drawn in, since the virtualizer never renders two rows out of their list's order).
  const collectRows = async (selector = "[data-crew-row]") => {
    await evaluate(
      "(() => { const el = document.querySelector('[data-crew-scroller]'); if (el) el.scrollTop = 0; return true })()"
    )
    await settle()
    const seen = new Map()
    for (let step = 0; step < 50; step++) {
      const rows = await evaluate(
        `[...document.querySelectorAll(${JSON.stringify(selector)})].map((row) => ({ key: row.dataset.crewRow, group: row.dataset.childGroup, state: row.dataset.childState, text: row.innerText.replace(/\\s+/g, ' '), html: row.outerHTML }))`
      )
      for (const row of rows) if (!seen.has(row.key)) seen.set(row.key, row)
      const { top, client, total } = await evaluate(
        "(() => { const el = document.querySelector('[data-crew-scroller]'); return el ? { top: el.scrollTop, client: el.clientHeight, total: el.scrollHeight } : { top: 0, client: 0, total: 0 } })()"
      )
      if (top + client >= total - 1) break
      await evaluate(
        `(() => { const el = document.querySelector('[data-crew-scroller]'); el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.85, el.scrollHeight); return true })()`
      )
      await settle()
    }
    await evaluate(
      "(() => { const el = document.querySelector('[data-crew-scroller]'); if (el) el.scrollTop = 0; return true })()"
    )
    return [...seen.values()]
  }

  await window.loadURL(`${base}?mock&app=apex`)
  await until(
    "[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))",
    "the Apex's row"
  )
  await evaluate(
    "[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true"
  )
  await until(
    "Boolean(document.querySelector('[data-composer]'))",
    "the Apex's composer"
  )

  // The Apex's own turn settles (its last request read, the digest); its twelve Fins keep running in the roster.
  // The crew card draws in the footer the old line used, replacing "Waiting on 12 agents".
  await evaluate("window.apexScene.setRunning(false); true")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card")
  await settle()

  const header = await evaluate(`(() => {
    const card = document.querySelector('[data-crew]')
    return {
      total: card.dataset.crew,
      text: card.innerText.replace(/\\s+/g, ' '),
      groups: [...card.querySelectorAll('[data-group]')].map((bar) => bar.dataset.group),
      mark: getComputedStyle(card.querySelector('.live-mark')).width,
    }
  })()`)
  console.log("HEADER", JSON.stringify(header))
  assert.equal(header.total, "12", "the header counts every Fin, not SHOWN = 3")
  assert.equal(header.mark, "20px", "the desk's marks stay the default 20px")
  assert.match(header.text, /^12 Fins/)
  assert.match(
    header.text,
    /5 Fins working · 2 need you/,
    "the rollup line, needs-you named"
  )
  assert.doesNotMatch(
    header.text,
    /and \d+ more/,
    "no SHOWN = 3 cutoff survives"
  )
  assert.doesNotMatch(
    header.text,
    /Waiting on \d+ agents?/,
    "the old line's words are gone for an Apex with Fins"
  )
  assert.deepEqual(
    header.groups.toSorted(),
    ["done", "needs", "queued", "working"],
    "the bar is split by every group that's here"
  )

  // Every Fin, scrolled into view: the rows rank by group, needs-you never behind a later one.
  const rows12 = await collectRows()
  console.log(
    "ROWS",
    JSON.stringify(rows12.map((row) => [row.group, row.text]))
  )
  assert.equal(
    rows12.length,
    12,
    "every Fin is reachable, not just the first screenful"
  )
  const RANK = { needs: 0, working: 1, queued: 2, failed: 3, done: 4 }
  for (let i = 1; i < rows12.length; i++)
    assert.ok(
      RANK[rows12[i].group] >= RANK[rows12[i - 1].group],
      `row ${i} (${rows12[i].group}) follows row ${i - 1} (${rows12[i - 1].group})`
    )
  assert.equal(rows12[0].group, "needs", "a need stands first")

  // Needs you: the question, the options with the recommended one first and labelled, the harness and model, time run.
  const needs = rows12.filter((row) => row.group === "needs")
  assert.equal(needs.length, 2, "push-wording and sheet-motion need the person")
  const wording = needs.find((row) => row.text.includes("push wording"))
  const approval = needs.find((row) => row.text.includes("Sheet motion"))
  assert.match(wording.text, /Which tone for the quiet-hours notice/)
  assert.match(wording.text, /Codex.*gpt-5\.6-sol/)
  assert.match(
    wording.text,
    /Plain Recommended Friendly/,
    "the recommended option comes first and is labelled"
  )
  assert.match(approval.text, /Approve: npm ci.*Allow once Refuse/)
  assert.doesNotMatch(
    wording.text,
    /\d+m \d+s/,
    "a minute is one unit: 18m, not 18m 01s"
  )
  assert.match(wording.text, /\d+m\b/)
  const starting = rows12.find((row) =>
    row.text.includes("Review screen hunks")
  )
  assert.match(starting?.text ?? "", /\d+s\b/, "under a minute stays seconds")

  // One place for an ask. While the card is in view the dock draws none of it; scrolled away, one line, and that
  // line brings Needs you back.
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[data-fin-answer=allow]').length"
    ),
    1,
    "the approval is drawn once, in the card"
  )
  assert.equal(
    await evaluate("document.querySelectorAll('[data-fin-asks]').length"),
    0,
    "the dock's ask list stays out while the card is in view"
  )
  // The transcript follows its end until the reader wheels upward. The card sits at that end, so leaving it
  // puts the card below the fold and the dock's line takes the asks' place.
  const hideCrew = `(() => {
    const card = document.querySelector('[data-crew]')
    let scroller = card && card.parentElement
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement
    if (!scroller) return false
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
    scroller.scrollTop = 0
    return true
  })()`
  await evaluate(hideCrew)
  await until(
    "Boolean(document.querySelector('[data-crew-away]'))",
    "the dock's line while the card is scrolled away"
  )
  const away = await evaluate(
    "document.querySelector('[data-crew-away]').innerText.replace(/\\s+/g, ' ')"
  )
  console.log("AWAY", away)
  assert.match(away, /2 Fins need you/)
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[data-fin-answer=allow]').length"
    ),
    1,
    "the ask is still only in the card"
  )
  await evaluate(
    "[...document.querySelectorAll('[data-sonner-toast]')].forEach((toast) => toast.remove()); true"
  )
  await both("away")
  await click("[data-crew-away]")
  await until(
    "!document.querySelector('[data-crew-away]')",
    "the line leaves once Needs you is back in view"
  )

  // Working: the current step, time run; the Fin asking its own Apex says so with a turned-back arrow.
  const working = rows12.filter((row) => row.group === "working")
  console.log("WORKING", JSON.stringify(working.map((row) => row.text)))
  assert.equal(
    working.length,
    5,
    "composer-chips, dictation, outbox, hunks and token-refresh (asking its Apex) work"
  )
  const asking = working.find((row) => row.text.includes("Push token refresh"))
  assert.ok(
    asking?.html.includes("lucide-corner-up-left"),
    "the Fin asking its Apex draws the turned-back arrow"
  )

  // Done: swipe, deep-links and pull-refresh. `childState()` (packages/host/src/contracts/agents.ts, not this
  // card's own) drops a successfully-done Fin's reason outright — real data never gives the result line or the PR
  // glyph a successful Fin's line to read, so neither draws here; the case right below proves the glyph on a line
  // that does carry one (a failure's reason, which the contract keeps).
  const done = rows12.filter((row) => row.group === "done")
  assert.equal(done.length, 3, "swipe, deep-links and pull-refresh are done")
  for (const row of done)
    assert.ok(
      !row.html.includes("lucide-git-pull-request"),
      `${row.text}: no done Fin's line survives childState() to read`
    )

  // A failed Fin's own reason does survive `childState()`; a PR glyph draws on one that names it.
  await evaluate(`(() => {
    const agents = window.apexScene.children()
    const failed = { ...agents[0], nativeId: "mako-child:crew-card-ui-failed", title: "Ship the release notes", child: { ...agents[0].child, thread: "00000000-0000-4000-8000-00000000fa17", state: { kind: "ended", outcome: "failed", reason: "Opened PR #42, then the check failed." } } }
    window.apexScene.setChildren([...agents, failed])
    return true
  })()`)
  await until(
    "Boolean(document.querySelector('[data-crew-row=\"00000000-0000-4000-8000-00000000fa17\"]'))",
    "the failed Fin's row"
  )
  const failedRow = await evaluate(
    "document.querySelector('[data-crew-row=\"00000000-0000-4000-8000-00000000fa17\"]').outerHTML"
  )
  assert.ok(
    failedRow.includes("lucide-git-pull-request"),
    "a failed Fin whose reason names a PR draws the glyph"
  )
  await evaluate(
    "window.apexScene.setChildren(window.apexScene.children().filter((agent) => agent.nativeId !== 'mako-child:crew-card-ui-failed')); true"
  )

  // The transcript itself may have scrolled past the card's own top while clicking through it; bring its header
  // (and the Stop-all/bar row) back into view before a screenshot means to show the whole card.
  await evaluate(
    "document.querySelector('[data-crew]')?.scrollIntoView({ block: 'start' }); true"
  )
  await evaluate(
    "[...document.querySelectorAll('[data-sonner-toast]')].forEach((toast) => toast.remove()); true"
  ) // a settled turn's own toast, not this shot's subject
  await settle()
  await both("desktop")

  // Stop all: it asks about the Fins it reaches, never the Apex, which already settled.
  const stopAllTitle = await evaluate(
    "[...document.querySelectorAll('[data-crew] header button')].find((button) => button.innerText.includes('Stop all'))?.title"
  )
  console.log("STOP ALL", stopAllTitle)
  assert.match(stopAllTitle ?? "", /Stop \d+ Fins under Mobile polish/)

  // Answering sheet-motion's approval moves it to working everywhere at once: the card, the Agents panel, the
  // rail's badge — all through the one action (`answerFin`) the Agents panel and the dock share.
  const sheetMotion = await evaluate(
    "window.apexScene.children().find((agent) => agent.title === 'Sheet motion on iPad').child.thread"
  )
  const railBefore = await evaluate(
    "document.querySelector('.thread-jump-scope [data-rollup]').getAttribute('aria-label')"
  )
  await click("[data-apex-count]")
  await until(
    "Boolean(document.querySelector('[data-apex-fins]'))",
    "the Agents panel's Fins section"
  )
  await click(`[data-crew-row="${sheetMotion}"] button[data-fin-answer=allow]`)
  await until(
    `document.querySelector('[data-crew-row="${sheetMotion}"]')?.dataset.childGroup === 'working'`,
    "sheet-motion moving to working in the card"
  )
  const responded = await evaluate("window.apexScene.responds().at(-1)")
  console.log("RESPONDED", JSON.stringify(responded))
  assert.equal(responded.fin, sheetMotion)
  assert.equal(responded.allow, true)
  await until(
    `document.querySelector('[data-child-row="${sheetMotion}"]')?.dataset.childState === 'working'`,
    "sheet-motion moving to working in the Agents panel"
  )
  const railAfter = await evaluate(
    "document.querySelector('.thread-jump-scope [data-rollup]').getAttribute('aria-label')"
  )
  console.log("RAIL", railBefore, "->", railAfter)
  assert.match(
    railAfter,
    /1 needs? you/,
    "the rail's badge counts one need now, not two"
  )
  assert.notEqual(railBefore, railAfter)

  // Answering push-wording's report, the recommended option first, moves it too.
  const pushWording = await evaluate(
    "window.apexScene.children().find((agent) => agent.title === 'Quiet-hours push wording').child.thread"
  )
  await click(`[data-crew-row="${pushWording}"] button[data-fin-answer="0"]`)
  await until(
    `document.querySelector('[data-crew-row="${pushWording}"]')?.dataset.childGroup === 'working'`,
    "push-wording moving to working"
  )
  assert.equal(
    await evaluate(
      "document.querySelector('[data-crew-row]')?.dataset.childGroup"
    ),
    "working",
    "no need left: the first row is now a working one"
  )
  assert.equal((await evaluate("window.apexScene.responds()")).length, 2)

  // Forty Fins and the re-render bench below: a fresh load first, so the Agents panel opened above (its own
  // subscription to the same roster) isn't still mounted beside the card, which would count its renders too.
  await window.loadURL(`${base}?mock&app=apex`)
  await until(
    "[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))",
    "the Apex's row again"
  )
  await evaluate(
    "[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true"
  )
  await until(
    "Boolean(document.querySelector('[data-composer]'))",
    "the Apex's composer again"
  )
  await evaluate("window.apexScene.setRunning(false); true")
  await until(
    "Boolean(document.querySelector('[data-crew]'))",
    "the crew card again"
  )
  await settle()

  // Forty Fins: every one counted, none painted at once (bounded height, virtualized), every one reachable by scroll.
  await evaluate("window.apexScene.churn(40, 10 * 60_000); true")
  await until(
    "document.querySelector('[data-crew]')?.dataset.crew === '40'",
    "forty Fins counted"
  )
  await settle()
  const forty = await evaluate(`(() => ({
    header: document.querySelector('[data-crew]').innerText.slice(0, 40),
    mounted: document.querySelectorAll('[data-crew-row]').length,
    scrollable: document.querySelector('[data-crew-scroller]').scrollHeight > document.querySelector('[data-crew-scroller]').clientHeight,
    more: /and \\d+ more/.test(document.querySelector('[data-crew]').innerText),
  }))()`)
  console.log("FORTY", JSON.stringify(forty))
  assert.match(forty.header, /^40 Fins/)
  assert.ok(
    forty.mounted < 40,
    `fewer than 40 rows are painted at once (${forty.mounted})`
  )
  assert.ok(forty.scrollable, "the card scrolls inside itself past twenty rows")
  assert.equal(forty.more, false, "no cutoff text, however many Fins there are")
  const lastTitle = await evaluate("window.apexScene.children().at(-1).title")
  await evaluate(
    "(() => { const scroller = document.querySelector('[data-crew-scroller]'); scroller.scrollTop = scroller.scrollHeight; return true })()"
  )
  await until(
    `document.querySelector('[data-crew-scroller]').innerText.includes(${JSON.stringify(lastTitle)})`,
    "the last Fin reachable by scrolling"
  )
  await evaluate(
    "document.querySelector('[data-crew]')?.scrollIntoView({ block: 'start' }); true"
  )
  await evaluate(
    "[...document.querySelectorAll('[data-sonner-toast]')].forEach((toast) => toast.remove()); true"
  ) // a settled turn's own toast, not this shot's subject
  await settle()
  await both("forty")
  await evaluate(
    "(() => { const scroller = document.querySelector('[data-crew-scroller]'); scroller.scrollTop = 0; return true })()"
  )

  // Re-render discipline: one Fin's step changes; its own row repaints, the card's other rows do not. The card
  // sorts needs-you first, so the first rows mounted at the top are taller "needs" ones, not "working" ones —
  // scroll down past them first, to a "working" row the virtualizer has actually mounted, and mutate that one by
  // its own thread id (not a raw array index, which isn't the sorted row order the card itself draws).
  await evaluate(
    "(() => { const el = document.querySelector('[data-crew-scroller]'); if (el) el.scrollTop = 900; return true })()"
  )
  await settle()
  const target = await evaluate(
    "document.querySelector('[data-crew-row][data-child-group=working]')?.dataset.crewRow"
  )
  assert.ok(target, "a working row is mounted to mutate")
  await evaluate("window.__benchReset(); true")
  await evaluate(`(() => {
    const agents = window.apexScene.children()
    const next = agents.map((agent) => agent.child?.thread === ${JSON.stringify(target)} ? { ...agent, child: { ...agent.child, state: { ...agent.child.state, step: agent.child.state.step + ' (still)' } } } : agent)
    window.apexScene.setChildren(next)
    return true
  })()`)
  await settle()
  const targetText = await evaluate(
    `document.querySelector('[data-crew-row="${target}"]')?.innerText.replace(/\\s+/g, ' ')`
  )
  console.log("TARGET ROW AFTER", targetText)
  assert.match(
    targetText ?? "",
    /\(still\)/,
    "the mutated row's own text reflects its new step"
  )
  const tally = await evaluate("window.__benchTally()")
  console.log("RENDER BENCH", JSON.stringify(tally))
  const rowRenders =
    (tally.components.CrewLineRow ?? 0) + (tally.components.NeedsRow ?? 0)
  console.log(
    `BENCH ${JSON.stringify({ commits: tally.commits, cardReexecuted: tally.components.CrewCard ?? 0, rowsRerendered: rowRenders, components: tally.components })}`
  )
  assert.equal(
    rowRenders,
    1,
    "exactly one Fin's row re-renders for its own step, not the whole card"
  )

  // The phone: the same card, compact, answers in reach of a thumb.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex`)
  await until(
    "Boolean(document.querySelector('[data-thread] [data-rollup]'))",
    "the Apex's row on the phone"
  )
  await click("[data-thread]")
  await until(
    "Boolean(document.querySelector('[data-child-chips]'))",
    "the Apex's chips on the phone"
  )
  await evaluate("window.apexScene.setRunning(false); true")
  await until(
    "Boolean(document.querySelector('[data-crew]'))",
    "the crew card on the phone"
  )
  await settle()
  const phone = await evaluate(`(() => {
    const card = document.querySelector('[data-crew]')
    const buttons = [...card.querySelectorAll('[data-crew-row] button[data-fin-answer]')]
    return {
      total: card.dataset.crew,
      text: card.innerText.replace(/\\s+/g, ' '),
      buttonHeights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
      mark: getComputedStyle(card.querySelector('.live-mark')).width,
    }
  })()`)
  console.log("PHONE", JSON.stringify(phone))
  assert.equal(phone.total, "12")
  assert.equal(
    phone.mark,
    "28px",
    "the phone's card inherits the phone's 28px mark"
  )
  assert.doesNotMatch(
    phone.text,
    /Codex · gpt-5\.6-sol/,
    "the compact card drops the harness and model line"
  )
  assert.doesNotMatch(
    phone.text,
    /\d+m \d+s/,
    "the phone's times are one unit too"
  )
  assert.equal(
    await evaluate("document.querySelector('.web-dock [data-ask=fin]')"),
    null,
    "the phone's dock doesn't repeat the ask while the card is in view"
  )
  for (const height of phone.buttonHeights)
    assert.ok(
      height >= 36,
      `an answer button is a thumb's reach tall (${height}px)`
    )
  await both("phone")
  await evaluate(hideCrew)
  await until(
    "Boolean(document.querySelector('[data-crew-away]'))",
    "the phone's line while the card is scrolled away"
  )
  const phoneAway = await evaluate(`(() => {
    const line = document.querySelector('[data-crew-away]')
    return { text: line.innerText.replace(/\\s+/g, ' '), height: Math.round(line.getBoundingClientRect().height) }
  })()`)
  console.log("PHONE AWAY", JSON.stringify(phoneAway))
  assert.match(phoneAway.text, /2 Fins need you/)
  assert.ok(
    phoneAway.height >= 36,
    `the phone's line is a thumb's reach tall (${phoneAway.height}px)`
  )
  assert.equal(
    await evaluate("document.querySelector('.web-dock [data-ask=fin]')"),
    null,
    "the phone's dock still doesn't draw the ask itself"
  )
  await both("phone-away")
  await click("[data-crew-away]")
  await until(
    "!document.querySelector('[data-crew-away]')",
    "the phone's line leaves once the card is back"
  )

  assert.deepEqual(
    errors.filter(
      (message) =>
        !/Download the React DevTools|already been passed to createRoot/.test(
          message
        )
    ),
    []
  )
  console.log(
    "Crew card UI: header, order, needs/working/done rows, answers moving everywhere, forty Fins, re-render discipline, and the phone passed"
  )
  app.exit(0)
}
