import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { childGroup, childStateOf, orderedChildren, rollup, rollupLabel } from "@mako/host/contracts/children"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * An Apex's row through the production rail and phone list, on the mock bridge's Apex (`?mock&app=apex`): its fin,
 * one line, its Fins counted in its tip as `rollup` counts them (the pips are the Overview's); folded, each Fin that
 * needs the person hung under it with its ask and nothing else of the Shiver in the rail; a Fin going to needs-you nests and leaves once answered, rows below it moving
 * by that row alone while every other row keeps its place, the folder's paging untouched; a nested row opens its Fin
 * in place, and answering one in the Inbox takes it from under its Apex at once. On the phone the Apex's row counts them the
 * same and its asking Fins hang under it, listed once.
 * Screenshots land in the printed directory. `--url <base>` uses a running Vite server instead of starting one.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-fin-pips-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-pips-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The Fin pips UI check", code, signal)))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The Fin pips UI check", ms: 120_000 })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const capture = async (name) => {
    await evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const load = async (path) => {
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const railState = `(() => {
    const apex = [...document.querySelectorAll('.thread-jump-scope [data-apex-row]')].find((row) => row.innerText.includes('Mobile polish'))
    return {
      label: (apex?.dataset.tip ?? '').split('\\n').find((line) => /^\\d+ Fins?\\b/.test(line)),
      fin: apex?.querySelector('[data-apex-mark]') !== null,
      height: Math.round(apex?.getBoundingClientRect().height),
      asking: [...document.querySelectorAll('.thread-jump-scope [data-asking-fin]')].map((row) => ({ thread: row.dataset.askingFin, text: row.innerText.replace(/\\s+/g, ' '), active: row.dataset.active === 'true' || row.hasAttribute('data-active') })),
      rail: document.querySelector('.thread-jump-scope').innerText,
      rows: [...document.querySelectorAll('.thread-jump-scope [data-flip-key], .thread-jump-scope [data-asking-fin]')].map((row) => ({ key: row.dataset.flipKey ?? 'fin:' + row.dataset.askingFin, top: Math.round(row.getBoundingClientRect().top) })),
    }
  })()`
  // Rows land where they go before they're measured, not mid-glide.
  const settled = async () => {
    await new Promise((done) => setTimeout(done, 300))
    await evaluate("Promise.all(document.getAnimations().filter((animation) => animation.id === 'rail-flip').map((animation) => animation.finished.catch(() => {}))).then(() => true)")
  }
  const rosterOf = () => evaluate("JSON.parse(JSON.stringify(window.apexScene.children()))")
  const setRoster = (agents) => evaluate(`window.apexScene.setChildren(${JSON.stringify(agents)}); true`)
  const withState = (agent, state) => ({ ...agent, child: { ...agent.child, state } })

  // The desk, as a window boots: the Apex's row from its host's summary, its asking Fins once the Inbox reads its roster.
  await load("/?mock&app=apex")
  await until(`Boolean(document.querySelector('.thread-jump-scope [data-apex-row] [data-apex-mark]'))`, "the Apex's row in the rail")
  await until(`document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2`, "the Apex's asking Fins under it")
  const roster = await rosterOf()
  assert.equal(roster.length, 12)
  const counts = rollup(roster)
  let rail = await evaluate(railState)
  assert.equal(rail.label, rollupLabel(counts), "the Apex's tip counts its Fins as `rollup` does")
  assert.equal(rail.label, "12 Fins: 2 need you · 5 working · 2 queued · 1 idle · 2 done")
  assert.equal(rail.fin, true, "the Apex wears a Thread's fin")
  assert.equal(rail.height, 28, "the Apex's row is one line, 28 px")
  const asking = orderedChildren(roster).filter((agent) => childGroup(childStateOf(agent)) === "needs")
  assert.deepEqual(rail.asking.map((row) => row.thread), asking.map((agent) => agent.child.thread), "the Fins that need you hang under the Apex, oldest first")
  for (const row of rail.asking) assert.ok(row.text.length > 0 && (await evaluate(`document.querySelector('[data-asking-fin="${row.thread}"] [data-asking-line]')?.textContent ?? ''`)).length > 0, `${row.text}: its ask beside its name`)
  for (const agent of roster) if (!asking.includes(agent)) assert.ok(!rail.rail.includes(agent.title), `no other Fin is in the rail: ${agent.title}`)
  await capture("desktop-dark.png")

  // A batch brings the roster: the tip counts it, a Fin asking its Apex among the working.
  await setRoster(roster)
  await until(`(${railState}).label === ${JSON.stringify(rollupLabel(rollup(roster)))}`, "the counts from the roster")
  await settled()
  rail = await evaluate(railState)

  // A working Fin goes to needs-you: it nests under its Apex; the rows below move down by that row and no other row moves.
  const working = orderedChildren(roster).find((agent) => childStateOf(agent).kind === "working")
  const before = rail.rows
  const asked = roster.map((agent) => (agent === working ? withState(agent, { kind: "blocked", on: "person", question: "Allow network access for npm ci?" }) : agent))
  await setRoster(asked)
  await until(`[...document.querySelectorAll('[data-asking-fin]')].some((row) => row.dataset.askingFin === ${JSON.stringify(working.child.thread)})`, "the Fin nesting under its Apex")
  await settled()
  rail = await evaluate(railState)
  assert.equal(rail.label, rollupLabel(rollup(asked)), "the counts move with it")
  assert.equal(rail.asking.length, 3)
  assert.deepEqual(rail.asking.map((row) => row.thread), orderedChildren(asked).filter((agent) => childGroup(childStateOf(agent)) === "needs").map((agent) => agent.child.thread))
  const nested = rail.rows.findIndex((row) => row.key === `fin:${working.child.thread}`)
  const after = rail.rows.filter((row) => row.key !== `fin:${working.child.thread}`)
  assert.deepEqual(after.map((row) => row.key), before.map((row) => row.key), "every other row keeps its order")
  const top = rail.rows[nested].top
  // An asking Fin's row is one line, its name and what it needs: 28 px.
  for (const [index, row] of after.entries()) assert.equal(row.top - before[index].top, row.top > top ? 28 : 0, `${row.key} moves by the nested row alone`)
  await capture("desktop-asking-dark.png")

  // Answered, it leaves the rail and the rows go back.
  await setRoster(roster)
  await until(`document.querySelectorAll('[data-asking-fin]').length === 2`, "the answered Fin leaving the rail")
  await settled()
  rail = await evaluate(railState)
  assert.deepEqual(rail.rows, before, "every row is back where it was")

  // Answered in the Inbox, through the Apex's host, it leaves from under its Apex at once.
  const answered = asking[1]
  await evaluate(`document.querySelector('[data-rail-top-row="inbox"]').click(); true`)
  await until(`Boolean(document.querySelector('[data-inbox-item^="fin:${answered.child.thread}:"]'))`, "the Fin's ask in the Inbox")
  await evaluate(`document.querySelector('[data-inbox-item^="fin:${answered.child.thread}:"]').click(); true`)
  await until(`Boolean(document.querySelector('[data-inbox-item^="fin:${answered.child.thread}:"] [data-ask-answers]'))`, "the Fin's ask selected")
  await evaluate(`document.querySelector('[data-inbox-item^="fin:${answered.child.thread}:"]').querySelector('[data-inbox-answer="allow"], [data-inbox-answer="0"]').click(); true`)
  await until(`![...document.querySelectorAll('[data-asking-fin]')].some((row) => row.dataset.askingFin === ${JSON.stringify(answered.child.thread)})`, "the answered Fin leaving from under its Apex")
  rail = await evaluate(railState)
  assert.deepEqual(rail.asking.map((row) => row.thread), [asking[0].child.thread], "only the Fin still asking hangs there")
  assert.match(rail.label ?? "", /1 needs you/, "and the count moved out of needs-you")
  await evaluate(`document.querySelector('[data-rail-top-row="inbox"]').click(); true`)

  // A nested row opens its Fin in place, and is the lit row while it shows.
  const first = asking[0].child.thread
  await evaluate(`document.querySelector('[data-asking-fin="${first}"]').click(); true`)
  await until(`document.querySelector('[data-asking-fin="${first}"]')?.hasAttribute('data-active')`, "the opened Fin's row lit")
  await until(`Boolean(document.querySelector('[data-child-tab="${first}"][aria-selected="true"]'))`, "the Fin open in its Apex's strip")
  await capture("desktop-open-dark.png")

  // Fifty more Apexes: each folder still pages its Threads (five shown, then More), nested rows aside.
  await load("/?mock&app=apex&apexes=50")
  await until(`document.querySelectorAll('.thread-jump-scope [data-apex-row]').length > 10`, "the bench's Apex rows")
  const paging = await evaluate(`[...document.querySelectorAll('.thread-jump-scope section')].filter((section) => /bench-/.test(section.innerText)).map((section) => ({ rows: section.querySelectorAll('[data-thread-row]').length, more: [...section.querySelectorAll('button')].some((button) => /^Show \\d+ more/.test(button.innerText)), asking: section.querySelectorAll('[data-asking-fin]').length }))`)
  assert.ok(paging.length > 0, "the bench's folders are listed")
  for (const folder of paging) {
    assert.ok(folder.rows <= 5, `a folder shows its first rows only (${folder.rows})`)
    assert.ok(folder.more, "and offers Show N more")
    assert.ok(folder.asking > 0, "its Apexes' asking Fins hang under them")
  }

  // The phone: the Apex's row counts its Fins as the desk's does; folded, its asking Fins hang under it, once each.
  window.setContentSize(390, 844)
  await load("/scripts/phone-apex.html")
  await until(`Boolean(document.querySelector('[data-apex-row][data-fin-counts]')) && document.querySelectorAll('[data-hung-fins] [data-asking-fin]').length > 0`, "the phone's Apex row and its asking Fins")
  const phone = await evaluate(`(() => ({
    label: document.querySelector('[data-apex-row][data-fin-counts]').dataset.finCounts,
    fins: [...document.querySelectorAll('[data-hung-fins] [data-fin-row]')].map((row) => row.dataset.finRow),
    list: document.querySelector('[data-list]').innerText,
  }))()`)
  assert.equal(phone.label, rollupLabel(counts))
  assert.deepEqual([...phone.fins].sort(), asking.map((agent) => agent.child.thread).sort(), "folded, each asking Fin is one row under its Apex")
  for (const agent of roster) if (!asking.includes(agent)) assert.ok(!phone.list.includes(agent.title), `the phone lists no other Fin while folded: ${agent.title}`)
  await capture("phone-dark.png")

  guard.done()
  console.log("Fin pips: ok")
  app.exit(0)
}
