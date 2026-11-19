import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * Automations, against the production components on the mock desk's automations scene (`?mock&app=automations`):
 * the rail's row opening the view over the conversation, the list by project with its filters, search and keys, each
 * standing's row (running, paused, waiting for the cloud, failing, off), one automation's page and its runs (statuses,
 * causes, gate keys and context, folded skips, pull requests, Threads that open), the Thread an automation ran saying
 * so and leading back, the editor creating one from blank and a template, editing one and reading it back,
 * validation, "Make this an automation" from a Thread's menu, a proposal approved and declined from the view and from
 * the Inbox, and decided proposals. `MAKO_SHOTS=<dir>` keeps every screenshot there; otherwise in the printed
 * scratch directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const root = testScratch("mako-automations-ui-")
  const server = await uiVite({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-automations-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  console.log(`Screenshots: ${process.env.MAKO_SHOTS ?? root}`)
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The Automations UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  const shots = process.env.MAKO_SHOTS ?? root
  mkdirSync(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 1440, 900)
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The Automations UI check", ms: 180_000 })
  const errors = []
  page.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message)
    if (details.level === "error" || details.level === "warning") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = () => new Promise((resolveWait) => setTimeout(resolveWait, 250))
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await frames()
    await settle()
    await writeFile(join(shots, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const point = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const click = async (selector, button = "left") => {
    const at = await point(selector)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...at })
  }
  const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 }
  const press = async (key, modifiers = 0) => {
    const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0)
    const text = key.length === 1 && !modifiers ? key : undefined
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers, ...(text && { text }) })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, modifiers })
  }
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const MOD = process.platform === "darwin" ? 4 : 2
  /** Sets a form control's value as the person would, so React hears it. */
  const fill = (selector, value) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing field ' + ${JSON.stringify(selector)}); const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`)
  const store = (expression) => evaluate(`import('/src/state/automations.ts').then(({ automationsStore }) => { const state = automationsStore.get(); return ${expression} })`)
  const open = async (url) => {
    await window.loadURL(url)
    await until(`document.querySelector('[data-rail-top-row="automations"]') !== null`, "the rail")
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railWidth: 264, theme: 'dark'}))`)
    await until(`import('/src/state/automations.ts').then(({ automationsStore }) => automationsStore.get().loaded)`, "automations read")
    // The mock desk's demo plugin says it didn't load; put its toast away so it covers nothing drawn here.
    await until(`document.querySelector('[data-sonner-toast]') !== null`, "the plugin's toast")
    await evaluate(`document.querySelector('[data-sonner-toast] [data-close-button]')?.click(); true`)
  }
  const ROW = (id) => `[data-automation-row$="#${id}"]`

  await open(`${base}?mock&app=automations`)

  // 1. The rail's row: a decision waits, so its reading is the attention count; pressing it opens the view, not Settings.
  assert.equal(await text('[data-rail-top-row="automations"] [data-automations-proposed]'), "2", "two proposals wait")
  await capture("rail-row.png")
  await click('[data-rail-top-row="automations"]')
  await until(`document.querySelector('[data-automations="list"] [data-automation-row]') !== null`, "the list")
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Search settings"]'))`), false, "not Settings")
  const groups = await evaluate(`[...document.querySelectorAll('[data-automations-project]')].map((node) => ({ project: node.dataset.automationsProject, rows: node.querySelectorAll('[data-automation-row]').length }))`)
  assert.deepEqual(groups.map((group) => group.rows), [6, 3, 3], `rows by project: ${JSON.stringify(groups)}`)
  const standings = await evaluate(`[...new Set([...document.querySelectorAll('[data-automation-standing]')].map((node) => node.dataset.automationStanding))].sort()`)
  assert.deepEqual(standings, ["off", "on", "paused", "running", "unsupported"], "every standing drawn")
  assert.match(await text(`[data-automation-key$="#nightly-ci-triage"]`), /Every weekday at 7:00 in Europe\/London/)
  assert.match(await text(`[data-automation-key$="#release-notes"]`), /When a release is published in Verbiflow\/mako/)
  assert.match(await text(`[data-automation-key$="#nightly-ci-triage"]`), /Running since/)
  assert.match(await text(`[data-automation-key$="#weekly-deps"]`), /Paused after 3 failed runs/)
  assert.match(await text(`[data-automation-key$="#check-failed-fix"]`), /waits for the cloud account to register it/)
  assert.equal(await evaluate(`document.querySelectorAll('[data-automation-key$="#nightly-ci-triage"] [data-proposal-status="pending"]').length`), 1, "the pending change opens on its row")
  assert.equal(await evaluate(`document.querySelectorAll('[data-automation-proposed="pr-review-digest"]').length`), 1, "a proposed new one is a row of its own")
  assert.match(await text('[data-automations-file="legacy"]'), /first shape/)
  await capture("list-all.png")
  console.log("PASS: the rail opens the list: three projects, every standing, sentences, the pending proposal on its row")

  // 2. Filters and search, by mouse and by key.
  for (const [filter, key] of [["needs", "3"], ["paused", "4"], ["scheduled", "2"]]) {
    await click("[data-automation-row]")
    await until(`document.querySelector('[data-automations="detail"]') !== null`, "a row opens its page")
    await press("Escape")
    await until(`document.querySelector('[data-automations="list"]') !== null`, "Escape back to the list")
    await until(`document.activeElement?.matches('[data-automation-row]')`, "focus back on a row")
    await press(key)
    await until(`document.querySelector('[data-automations-filter="${filter}"][aria-selected="true"]') !== null`, `${filter} by its key`)
    await capture(`list-${filter}.png`)
  }
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-row]')].map((node) => node.dataset.automationRow.split('#')[1])`), ["nightly-ci-triage", "weekly-deps", "flaky-tests", "broken-links", "token-rotation"], "Scheduled: those with a schedule")
  await click('[data-automations-filter="paused"]')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-automation-row]')].map((node) => node.dataset.automationRow.split('#')[1]).sort()`), ["broken-links", "weekly-deps"], "Paused: by failures and by a changed file")
  await click('[data-automations-filter="all"]')
  await press("/")
  await until(`document.activeElement?.matches('[data-automations-search]')`, "/ to search")
  await type("sentry")
  await until(`document.querySelectorAll('[data-automation-row]').length === 1`, "search narrows")
  await capture("list-search.png")
  await press("Escape")
  await until(`document.querySelectorAll('[data-automation-row]').length === 12`, "Escape clears the search")
  console.log("PASS: filters by click and key, search, Escape clears then goes back")

  // 3. Keys on a row: arrows move, T switches it, R runs it now.
  await evaluate(`document.querySelector('${ROW("flaky-tests")}').focus()`)
  await press("ArrowDown")
  assert.match(await evaluate(`document.activeElement.dataset.automationRow`), /check-failed-fix$/, "ArrowDown moves to the next row")
  await press("ArrowUp")
  await press("t")
  await until(`import('/src/state/automations.ts').then(({ automationsStore, automationView }) => automationView(automationsStore.get(), '/Users/you/mako', 'flaky-tests')?.local.enabled === true)`, "T turns it on")
  await press("r")
  await until(`document.querySelector('[data-automation-key$="#flaky-tests"]')?.dataset.automationStanding === 'running'`, "R runs it now")
  await until(`[...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.innerText.includes('Hunt flaky tests started'))`, "Run now's toast")
  await capture("list-run-now.png")
  await until(`document.querySelector('[data-automation-key$="#flaky-tests"] [data-automation-last="completed"]') !== null`, "the run completes live")
  console.log("PASS: arrows, T and R on a row; the run moves live")

  // 4. One automation's page and its runs.
  await evaluate(`document.querySelector('${ROW("nightly-ci-triage")}').focus()`)
  await press("Enter")
  await until(`document.querySelector('[data-automation-runs]') !== null`, "the runs")
  const runs = await evaluate(`[...document.querySelectorAll('[data-run-status]')].map((node) => node.dataset.runStatus)`)
  for (const status of ["fired", "completed", "skipped", "failed-to-start"]) assert.ok(runs.includes(status), `a ${status} run: ${runs}`)
  assert.equal(await evaluate(`document.querySelector('[data-run-skips]')?.dataset.runSkips`), "3", "three gate skips in a row fold into one line")
  assert.equal(await text('[data-run-pull]'), "Verbiflow/mako#1042")
  assert.match(await text('[data-run="' + (await evaluate(`document.querySelectorAll('[data-run]')[0].dataset.run`)) + '"] [data-run-gate-key]'), /11873,11871/)
  assert.equal(await evaluate(`document.querySelectorAll('[data-next-runs] span.tabular').length`), 3, "the next three runs")
  await capture("page-triage.png")
  await click('[data-run-details]')
  await until(`document.querySelector('[data-run-gate-context]') !== null`, "the gate's context")
  assert.match(await text('[data-run-gate-context]'), /"failures": 2/)
  await click('[data-run-skips] button')
  await capture("page-triage-details.png")
  console.log("PASS: the page: statuses, folded skips, gate key and context, the pull request, next runs")

  // 5. A run's Thread opens, says what ran it, and leads back.
  await click('[data-run-thread="a7000000-0002-4000-8000-0000000000a2"]')
  await until(`!document.querySelector('[data-automations]') && document.querySelector('[data-automation-run-line="nightly-ci-triage"]') !== null`, "the Thread, with its line")
  assert.match(await text('[data-automation-run-line]'), /Run of Nightly CI triage/)
  assert.match(await text('[data-automation-run-line]'), /next/)
  await capture("thread-badge.png")
  await click('[data-automation-run-link]')
  await until(`document.querySelector('[data-automation-page="nightly-ci-triage"]') !== null`, "the badge opens the automation")
  console.log("PASS: a run's Thread says 'Run of … · next …' and leads back")

  // 6. Event causes, runWhen checks, cloud waiting, and decided proposals on their pages.
  await press("Escape")
  await click(ROW("release-notes"))
  await until(`document.querySelector('[data-automation-page="release-notes"] [data-run]') !== null`, "release notes' runs")
  assert.match(await text('[data-automation-runs]'), /Release v0\.171\.0 published in Verbiflow\/mako/)
  assert.match(await text('[data-automation-runs]'), /Not worth a run: 0\.170\.2 is a patch release/)
  assert.match(await text('[data-automation-page="release-notes"]'), /Earlier proposals[\s\S]*Approved/)
  await capture("page-event-runs.png")
  await press("Escape")
  await click(ROW("schema-doc"))
  await until(`document.querySelector('[data-automation-page="schema-doc"] [data-proposal-status="stale"]') !== null`, "a stale proposal")
  assert.match(await text('[data-automation-page="schema-doc"] [data-proposal-status="stale"]'), /Out of date/)
  await capture("page-stale-proposal.png")
  await press("Escape")
  await click(ROW("weekly-deps"))
  await until(`document.querySelector('[data-automation-page="weekly-deps"] [data-proposal-status="expired"]') !== null`, "an expired proposal")
  assert.match(await text('[data-automation-page-note]'), /Paused after 3 failed runs/)
  await capture("page-paused-failed.png")
  await press("Escape")
  await click(ROW("check-failed-fix"))
  await until(`document.querySelector('[data-automation-page="check-failed-fix"]') !== null`, "the cloud trigger's page")
  assert.match(await text('[data-automation-page-note]'), /waits for the cloud account/)
  await capture("page-cloud-waiting.png")
  await press("Escape")
  await click(ROW("flaky-tests"))
  await until(`document.querySelector('[data-automation-page="flaky-tests"] [data-proposal-status="declined"]') !== null`, "a declined proposal")
  await press("Escape")
  console.log("PASS: event causes with links, runWhen passes and skips, stale, expired, declined and approved proposals")

  // 7. Approve the pending change from the view: its diff, then the definition it writes.
  const diff = await evaluate(`[...document.querySelectorAll('[data-automation-key$="#nightly-ci-triage"] [data-diff-field]')].map((node) => node.dataset.diffField)`)
  assert.deepEqual(diff, ["prompt", "triggers", "start", "limits"], "the diff names what changes, in order")
  assert.ok(await evaluate(`document.querySelectorAll('[data-automation-key$="#nightly-ci-triage"] [data-diff-line="add"]').length > 0 && document.querySelectorAll('[data-automation-key$="#nightly-ci-triage"] [data-diff-line="remove"]').length > 0`), "the prompt's lines added and removed")
  assert.match(await text('[data-automation-key$="#nightly-ci-triage"] [data-diff-field="triggers"]'), /When a check fails in Verbiflow\/mako, only if the check is on main/)
  assert.match(await text('[data-automation-key$="#nightly-ci-triage"] [data-diff-field="start"]'), /claude-opus-5-5[\s\S]*claude-sonnet-5/)
  await evaluate(`document.querySelector('[data-automation-key$="#nightly-ci-triage"] [data-proposal]').scrollIntoView({ block: 'center' })`)
  await capture("list-proposal.png")
  await click('[data-automation-key$="#nightly-ci-triage"] [data-proposal-answer="approve"]')
  await until(`import('/src/state/automations.ts').then(({ automationsStore, automationView }) => automationView(automationsStore.get(), '/Users/you/mako', 'nightly-ci-triage')?.definition.start.model === 'claude-sonnet-5')`, "the approved change written")
  assert.equal(await evaluate(`document.querySelectorAll('[data-automation-key$="#nightly-ci-triage"] [data-proposal-status="pending"]').length`), 0, "no longer pending on its row")
  await click('[data-automation-proposed="pr-review-digest"] [data-proposal-answer="decline"]')
  await until(`document.querySelector('[data-automation-proposed]') === null`, "the declined create leaves")
  assert.equal(await store(`state.projects[0].proposals.find((each) => each.id === 'p-pr-digest').status`), "declined")
  assert.equal(await evaluate(`document.querySelector('[data-rail-top-row="automations"] [data-automations-proposed]')`), null, "the rail's count clears")
  console.log("PASS: approve and decline from the view; the rail's count follows")

  // 8. The Inbox's card: a fresh scene, the proposal's diff, declined and approved through its ask.
  for (const answer of ["decline", "approve"]) {
    await open(`${base}?mock&app=automations`)
    await evaluate(`import('/src/components/inbox/open-inbox.ts').then(({ openInbox }) => openInbox())`)
    await until(`document.querySelector('[data-inbox] [data-inbox-proposal="p-triage-faster"] [data-diff-field="prompt"]') !== null`, "the Inbox's proposal card")
    assert.match(await text('[data-inbox-proposal]'), /Proposes a change/)
    assert.match(await text('[data-inbox-item]:has([data-inbox-proposal])'), /Speed up the nightly triage/, "the card names the proposing Thread")
    assert.ok(await evaluate(`Boolean(document.querySelector('[data-inbox-proposal] [data-proposal-show]'))`), "a way to the automation")
    if (answer === "decline") await capture("inbox-proposal.png")
    await click(`[data-inbox-proposal] [data-proposal-answer="${answer}"]`)
    await until(`document.querySelector('[data-inbox-proposal]') === null`, `the ${answer}d ask leaves the Inbox`)
    const decided = await store(`state.projects[0].proposals.find((each) => each.id === 'p-triage-faster').status`)
    assert.equal(decided, answer === "approve" ? "approved" : "declined")
    const model = await store(`state.projects[0].automations.find((each) => each.definition.id === 'nightly-ci-triage').definition.start.model`)
    assert.equal(model, answer === "approve" ? "claude-sonnet-5" : "claude-opus-5-5")
  }
  console.log("PASS: the Inbox's card shows the diff and decides through its ask, both ways")

  // 9. The editor: new from blank, validation, schedule picker, save, and the row it adds.
  await click('[data-rail-top-row="automations"]')
  await until(`document.querySelector('[data-automations="list"] [data-automation-row]') !== null`, "the list again")
  await press("n")
  await until(`document.querySelector('[data-automations-new] [data-template="ci-triage"]') !== null`, "starting points")
  await capture("new-templates.png")
  await click('[data-template="blank"]')
  await until(`document.querySelector('[data-automation-editor="new"]') !== null`, "the editor")
  await until(`document.activeElement?.matches('[data-automation-name]')`, "the name takes the keyboard")
  await press("s", MOD)
  await until(`document.querySelector('[data-field-problem="name"]') !== null && document.querySelector('[data-field-problem="objective"]') !== null`, "save shows what's missing")
  await capture("editor-validation.png")
  await type("Morning standup notes")
  assert.equal(await evaluate(`document.querySelector('[data-automation-id]').value`), "morning-standup-notes", "the id follows the name")
  await fill("[data-automation-objective]", "Summarise yesterday's merged pull requests and today's open reviews for the standup.")
  await fill('[data-trigger-index="0"] [data-schedule-preset]', "weekly")
  await until(`document.querySelector('[data-trigger-index="0"] [aria-label="Day of the week"]') !== null`, "weekly asks for a day")
  await fill('[data-trigger-index="0"] [aria-label="Day of the week"]', "2")
  await fill('[data-trigger-index="0"] [aria-label="Time"]', "08:30")
  await fill('[data-trigger-index="0"] [data-schedule-zone]', "Europe/London")
  assert.match(await text('[data-automation-summary]'), /every Tuesday at 8:30 in Europe\/London/)
  assert.equal(await evaluate(`document.querySelectorAll('[data-trigger-index="0"] [data-next-runs] span.tabular').length`), 3, "next three runs")
  await click("[data-add-trigger]")
  await until(`document.querySelector('[data-add-trigger-kind="github"]') !== null`, "the trigger menu")
  await capture("editor-add-trigger.png")
  await click('[data-add-trigger-kind="commit"]')
  await until(`document.querySelector('[data-trigger-index="1"][data-trigger-kind="commit"]') !== null`, "a commit trigger")
  await fill('[data-trigger-index="1"] [aria-label="Branch"]', "main")
  await fill('[data-trigger-index="1"] [data-run-when]', "The commit changes a migration")
  await fill("[data-start-harness]", "claude")
  await evaluate(`document.querySelector('[data-choice="result:pull-request"] input').click()`)
  await capture("editor-new.png")
  await evaluate(`document.querySelector('[data-automation-editor] .overflow-y-auto').scrollTo(0, 99999)`)
  await capture("editor-new-bottom.png")
  assert.match(await text("[data-shared-note]"), /Shared with the repo[\s\S]*this Mac/)
  await click("[data-automation-save]")
  await until(`document.querySelector('[data-automation-page="morning-standup-notes"]') !== null`, "saved, its page")
  const saved = await store(`state.projects[0].automations.find((each) => each.definition.id === 'morning-standup-notes')`)
  assert.equal(saved.definition.triggers[0].cron, "30 8 * * 2")
  assert.equal(saved.definition.triggers[1].runWhen, "The commit changes a migration")
  assert.equal(saved.definition.start.harness, "claude")
  assert.equal(saved.definition.result, "pull-request")
  assert.equal(saved.local.enabled, false, "a new one starts off")
  await capture("page-new.png")
  console.log("PASS: blank to saved: validation, id from name, schedule picker, next runs, a second trigger, off on save")

  // 10. Edit round-trip: change the name and the schedule to a custom cron; a bad cron says why; the page reads it back.
  await press("e")
  await until(`document.querySelector('[data-automation-editor="morning-standup-notes"]') !== null`, "the editor on it")
  assert.equal(await evaluate(`document.querySelector('[data-automation-name]').value`), "Morning standup notes")
  await fill("[data-automation-name]", "Standup notes")
  assert.equal(await evaluate(`document.querySelector('[data-automation-id]').value`), "morning-standup-notes", "an existing id stays")
  await fill('[data-trigger-index="0"] [data-schedule-preset]', "custom")
  await fill('[data-trigger-index="0"] [data-cron-input]', "0 8 * *")
  await until(`document.querySelector('[data-cron-problem]') !== null`, "a four-field cron says why")
  await capture("editor-bad-cron.png")
  await fill('[data-trigger-index="0"] [data-cron-input]', "0 8 * * 2,4")
  await until(`document.querySelector('[data-cron-problem]') === null`, "fixed")
  await click('[data-remove-trigger="1"]')
  await press("s", MOD)
  await until(`document.querySelector('[data-automation-page="morning-standup-notes"]') !== null`, "saved")
  assert.match(await text('[data-automation-page="morning-standup-notes"] h1'), /Standup notes/)
  assert.match(await text('[data-page-trigger="schedule"]'), /On the schedule 0 8 \* \* 2,4 in Europe\/London/)
  assert.equal(await evaluate(`document.querySelectorAll('[data-page-trigger]').length`), 1, "the removed trigger is gone")
  await press("e")
  await until(`document.querySelector('[data-cron-input]')?.value === '0 8 * * 2,4'`, "the editor reads it back")
  await press("Escape")
  await until(`document.querySelector('[data-automation-page="morning-standup-notes"]') !== null`, "Escape leaves an unchanged editor")
  console.log("PASS: edit, a bad cron, save, and the page and editor read it back")

  // 11. A cloud trigger in the editor: its webhook window and what happens while this Mac is off.
  await press("Escape")
  await click(ROW("stripe-webhook"))
  await press("e")
  await until(`document.querySelector('[data-webhook-window]')?.value === '300'`, "a webhook's gathering window")
  assert.ok(await evaluate(`Boolean(document.querySelector('[aria-label="If this Mac is off"]'))`), "what to do while this Mac is off")
  await evaluate(`document.querySelector('[data-trigger-index="0"]').scrollIntoView({ block: 'start' }); true`)
  await capture("editor-cloud-trigger.png")
  await press("Escape")
  await press("Escape")

  // 12. Duplicate and delete with Undo, from the row's menu.
  await click(`[data-automation-key$="#openapi-sync"] [data-automation-menu]`)
  await until(`document.querySelector('[data-automation-action="duplicate"]') !== null`, "the row's menu")
  await capture("row-menu.png")
  await click('[data-automation-action="duplicate"]')
  await until(`document.querySelector('[data-automation-editor="new"]') !== null && document.querySelector('[data-automation-id]').value === 'openapi-sync-copy'`, "a copy in the editor")
  await click("[data-automation-save]")
  await until(`document.querySelector('[data-automation-page="openapi-sync-copy"]') !== null`, "the copy saved")
  await press("Escape")
  await click(`[data-automation-key$="#openapi-sync-copy"] [data-automation-menu]`)
  await click('[data-automation-action="delete"]')
  await until(`document.querySelector('[data-automation-key$="#openapi-sync-copy"]') === null`, "deleted")
  await until(`[...document.querySelectorAll('[data-sonner-toast] button')].some((button) => button.innerText === 'Undo')`, "Undo offered")
  await evaluate(`[...document.querySelectorAll('[data-sonner-toast] button')].find((button) => button.innerText === 'Undo').click()`)
  await until(`document.querySelector('[data-automation-key$="#openapi-sync-copy"]') !== null`, "Undo puts it back")
  console.log("PASS: duplicate, delete, undo")

  // 13. "Make this an automation" from a Thread's menu.
  await press("Escape")
  await until(`!document.querySelector('[data-automations]')`, "back to the conversation")
  const proposer = "[data-automation-test-row]"
  await until(`(() => { const row = [...document.querySelectorAll('.thread-jump-scope [data-thread-row]')].find((node) => node.innerText.includes('Speed up the nightly triage')); row?.setAttribute('data-automation-test-row', ''); return Boolean(row) })()`, "the proposing Thread's row")
  await click(proposer, "right")
  await until(`document.querySelector('[data-thread-action="make-automation"]') !== null`, "the Thread's menu")
  await capture("thread-menu.png")
  await click('[data-thread-action="make-automation"]')
  await until(`document.querySelector('[data-automation-editor="new"]') !== null`, "the editor from the Thread")
  assert.match(await text('[data-automation-editor] h1'), /Make this an automation/)
  assert.match(await evaluate(`document.querySelector('[data-automation-objective]').value`), /Do again what this Thread/)
  await capture("editor-from-thread.png")
  await press("Escape")
  console.log("PASS: Make this an automation from a Thread's menu")

  // 14. Nothing yet: the empty state with its templates.
  await evaluate(`Promise.all([import('/src/state/automations.ts'), import('/src/state/automations-view.ts')]).then(([{ automationsStore }, { openAutomations }]) => { openAutomations(); setTimeout(() => automationsStore.set({ projects: [] }), 300) })`)
  await until(`document.querySelector('[data-automations-empty] [data-template="ci-triage"]') !== null`, "the empty state")
  await capture("empty.png")
  console.log("PASS: the empty state offers templates")

  // 15. A routed window (the web desk) draws no Automations: no row, no view.
  await window.loadURL(`${base}scripts/web-desk.html?app=busy`)
  await until(`document.querySelector('[data-rail-top]') !== null`, "the web desk")
  assert.equal(await evaluate(`document.querySelector('[data-rail-top-row="automations"]')`), null, "no Automations row on the web desk")
  console.log("PASS: the web desk leaves Automations out")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  guard.done()
  console.log("Automations UI: passed")
  app.exit(0)
}
