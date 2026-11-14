import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { childGroup, childStateOf, CHILD_GROUPS, orderedChildren, rollup, rollupLabel } from "@mako/host/contracts/children"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * An Apex's row through the production rail and phone list, on the mock bridge's Apex (`?mock&app=apex`): one pip per
 * Fin in `orderedChildren`' order, counted as `rollup` counts them; each Fin that needs the person hung under it and
 * nothing else of the crew in the rail; a Fin going to needs-you nests and leaves once answered, rows below it moving
 * by that row alone while every other row keeps its place, the folder's paging untouched; a nested row opens its Fin
 * in place, and answering one in the Inbox takes it from under its Apex at once. On the phone the Apex's row wears the
 * pips on its second line, and its asking Fins stay the Needs you rows they are, listed once.
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

const LETTER = { needs: "n", queued: "q", idle: "i", failed: "f", done: "d" }

/** The pips a roster draws, as `FinPips` reads them: one letter per Fin in the shared order. */
function expectedPips(children) {
  return orderedChildren(children)
    .map((agent) => {
      const state = childStateOf(agent)
      const group = childGroup(state)
      return group === "working" ? (state.kind === "blocked" ? "l" : "w") : LETTER[group]
    })
    .join("")
}

/** The groups the pips stand in, in order: each group's pips together, in `CHILD_GROUPS`' order. */
function groupsOf(pips) {
  const group = { n: "needs", w: "working", l: "working", q: "queued", i: "idle", f: "failed", d: "done" }
  return [...pips].map((letter) => group[letter])
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
    const pips = apex?.querySelector('[data-fin-pips]')
    return {
      pips: pips?.dataset.finPips,
      label: pips?.getAttribute('aria-label'),
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
  await until(`Boolean(document.querySelector('.thread-jump-scope [data-apex-row] [data-fin-pips]'))`, "the Apex's pips in the rail")
  await until(`document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2`, "the Apex's asking Fins under it")
  const roster = await rosterOf()
  assert.equal(roster.length, 12)
  const counts = rollup(roster)
  let rail = await evaluate(railState)
  assert.equal(rail.pips.length, counts.total, "one pip per Fin")
  assert.deepEqual(groupsOf(rail.pips), CHILD_GROUPS.flatMap((group) => Array(counts[group]).fill(group)), "the pips stand in the shared order, each group as `rollup` counts it")
  assert.equal(rail.label, rollupLabel(counts))
  assert.equal(rail.label, "12 Fins: 2 need you · 5 working · 2 queued · 1 idle · 2 done")
  assert.match(rail.rail, /12 Fins/, "the row says how many Fins")
  assert.equal(rail.height, 44, "the Apex's row is two lines, 44 px")
  const asking = orderedChildren(roster).filter((agent) => childGroup(childStateOf(agent)) === "needs")
  assert.deepEqual(rail.asking.map((row) => row.thread), asking.map((agent) => agent.child.thread), "the Fins that need you hang under the Apex, oldest first")
  for (const row of rail.asking) assert.match(row.text, /Needs you \S/, `${row.text}: Needs you, then what it needs`)
  for (const agent of roster) if (!asking.includes(agent)) assert.ok(!rail.rail.includes(agent.title), `no other Fin is in the rail: ${agent.title}`)
  await capture("desktop-dark.png")

  // A batch brings the roster: the pips now draw the Fin asking its Apex hollow, in the roster's own order.
  await setRoster(roster)
  await until(`document.querySelector('[data-apex-row] [data-fin-pips]')?.dataset.finPips === ${JSON.stringify(expectedPips(roster))}`, "the pips from the roster")
  await settled()
  rail = await evaluate(railState)
  assert.ok(rail.pips.includes("l"), "a Fin asking its Apex has a pip of its own")

  // A working Fin goes to needs-you: it nests under its Apex; the rows below move down by that row and no other row moves.
  const working = orderedChildren(roster).find((agent) => childStateOf(agent).kind === "working")
  const before = rail.rows
  const asked = roster.map((agent) => (agent === working ? withState(agent, { kind: "blocked", on: "person", question: "Allow network access for npm ci?" }) : agent))
  await setRoster(asked)
  await until(`[...document.querySelectorAll('[data-asking-fin]')].some((row) => row.dataset.askingFin === ${JSON.stringify(working.child.thread)})`, "the Fin nesting under its Apex")
  await settled()
  rail = await evaluate(railState)
  assert.equal(rail.pips, expectedPips(asked), "the pips move with it")
  assert.equal(rail.asking.length, 3)
  assert.deepEqual(rail.asking.map((row) => row.thread), orderedChildren(asked).filter((agent) => childGroup(childStateOf(agent)) === "needs").map((agent) => agent.child.thread))
  const nested = rail.rows.findIndex((row) => row.key === `fin:${working.child.thread}`)
  const after = rail.rows.filter((row) => row.key !== `fin:${working.child.thread}`)
  assert.deepEqual(after.map((row) => row.key), before.map((row) => row.key), "every other row keeps its order")
  const top = rail.rows[nested].top
  // An asking Fin's row is two lines, its name and "Needs you" over what it needs: 44 px.
  for (const [index, row] of after.entries()) assert.equal(row.top - before[index].top, row.top > top ? 44 : 0, `${row.key} moves by the nested row alone`)
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
  await evaluate(`document.querySelector('[data-inbox-item^="fin:${answered.child.thread}:"]').querySelector('[data-inbox-answer="allow"], [data-inbox-answer="0"]').click(); true`)
  await until(`![...document.querySelectorAll('[data-asking-fin]')].some((row) => row.dataset.askingFin === ${JSON.stringify(answered.child.thread)})`, "the answered Fin leaving from under its Apex")
  rail = await evaluate(railState)
  assert.deepEqual(rail.asking.map((row) => row.thread), [asking[0].child.thread], "only the Fin still asking hangs there")
  assert.equal(rail.pips.split("n").length - 1, 1, "and its pip moved out of needs-you")
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
  const paging = await evaluate(`[...document.querySelectorAll('.thread-jump-scope section')].filter((section) => /bench-/.test(section.innerText)).map((section) => ({ rows: section.querySelectorAll('[data-thread-row]').length, more: [...section.querySelectorAll('button')].some((button) => /^More/.test(button.innerText)), asking: section.querySelectorAll('[data-asking-fin]').length }))`)
  assert.ok(paging.length > 0, "the bench's folders are listed")
  for (const folder of paging) {
    assert.ok(folder.rows <= 5, `a folder shows its first rows only (${folder.rows})`)
    assert.ok(folder.more, "and offers More")
    assert.ok(folder.asking > 0, "its Apexes' asking Fins hang under them")
  }

  // The phone: the Apex's row has the pips on its second line; its asking Fins are Needs you rows of their own, once.
  window.setContentSize(390, 844)
  await load("/scripts/phone-apex.html")
  await until(`Boolean(document.querySelector('[data-thread] [data-fin-pips]')) && document.querySelectorAll('[data-fin-row]').length > 0`, "the pips on the phone's Apex row")
  const phone = await evaluate(`(() => {
    const pips = document.querySelector('[data-thread] [data-fin-pips]')
    return {
      pips: pips.dataset.finPips,
      label: pips.getAttribute('aria-label'),
      line: pips.innerText,
      fins: [...document.querySelectorAll('[data-fin-row]')].map((row) => row.dataset.finRow),
      nested: document.querySelectorAll('[data-asking-fin]').length,
      list: document.querySelector('[data-list]').innerText,
    }
  })()`)
  assert.equal(phone.pips, expectedPips(roster))
  assert.equal(phone.label, rollupLabel(counts))
  assert.match(phone.line, /12 Fins/)
  assert.deepEqual([...phone.fins].sort(), asking.map((agent) => agent.child.thread).sort(), "each asking Fin is one row")
  assert.equal(phone.nested, 0, "the phone hangs no second copy under the Apex")
  for (const agent of roster) if (!asking.includes(agent)) assert.ok(!phone.list.includes(agent.title), `the phone lists no other Fin: ${agent.title}`)
  await capture("phone-dark.png")

  guard.done()
  console.log("Fin pips: ok")
  app.exit(0)
}
