import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// `/goal` in the window, against the mock bridge: the Mako command in the
// `/` menu, the goal bar's Pause, Resume and Clear, the question before a
// goal is replaced, the drafts a goal Mako can't set leaves in place, and a
// token budget counted down to Out of budget.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = await mkdtemp(join(tmpdir(), "mako-goal-ui-"))
  const threadUrl = process.env.MAKO_THREAD_URL
  const server = threadUrl ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 0, watch: null },
  })
  if (server) await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-goal-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_GOAL_CHECK_ROOT: root,
    MAKO_GOAL_CHECK_URL: `${threadUrl ?? server.resolvedUrls.local[0]}/`.replace(/\/\/$/, "/"),
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    if (server) await server.close()
  }
  console.log(`Goal UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_GOAL_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const capture = async (name, selector) => {
    const end = Date.now() + 2000
    while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
      await new Promise((resolve) => setTimeout(resolve, 25))
    await evaluate("document.fonts.ready")
    await frame()
    const bounds = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} })()`)
      : undefined
    await writeFile(join(root, name), (await page.capturePage(bounds)).toPNG())
  }
  const until = async (code, what = code) => {
    const end = Date.now() + 15000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${what}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const press = async (key, code = key, keyCode = 13) => {
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  }
  const clickAt = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const centre = (expression) => `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`
  const click = async (selector) => {
    await frame()
    const point = await evaluate(centre(`document.querySelector(${JSON.stringify(selector)})`))
    assert.ok(point, `Missing ${selector}`)
    await clickAt(point)
  }
  const clickButton = async (label, within = "document") => {
    await frame()
    const point = await evaluate(centre(`[...${within}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`))
    assert.ok(point, `Missing the ${label} button`)
    await clickAt(point)
  }
  const draft = () => evaluate("document.querySelector('[data-composer] textarea').value")
  const type = async (text) => {
    await click("[data-composer] textarea")
    await page.debugger.sendCommand("Input.insertText", { text })
  }
  const send = async (text) => {
    await type(text)
    await until(`document.querySelector('[data-composer] textarea').value.endsWith(${JSON.stringify(text)})`, `the draft takes ${text}`)
    await press("Enter")
  }
  const bar = "document.querySelector('section[aria-label=\"Goal\"]')"
  const goalStatus = () => evaluate(`${bar}?.dataset.goalStatus ?? null`)
  const toast = (text) => until(`[...document.querySelectorAll('[data-sonner-toast]')].some(t => t.textContent.includes(${JSON.stringify(text)}))`, `a toast saying ${text}`)

  const timer = setTimeout(() => app.exit(1), 90000)
  try {
    await window.loadURL(`${process.env.MAKO_GOAL_CHECK_URL}?mock`)
    await until("Boolean(document.querySelector('[data-composer] textarea'))", "the composer")

    // Before any conversation: `/` offers Mako's goal, and picking it stages the command.
    await type("/go")
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('goal'))", "the goal row in the / menu")
    assert.match(await evaluate("[...document.querySelectorAll('[role=option]')].find(o => o.textContent.startsWith('goal')).textContent"), /Keep working until an objective is met/)
    await capture("menu.png")
    await press("Enter")
    await until("document.querySelector('[data-composer] textarea').value === '/goal '", "the picked command in the draft")
    await press("Enter")
    await toast("Write the goal after /goal")
    assert.equal(await draft(), "/goal ", "an empty goal keeps the draft")
    for (let index = 0; index < 6; index += 1) await press("Backspace", "Backspace", 8)
    await until("document.querySelector('[data-composer] textarea').value === ''", "an empty draft")

    // A conversation to set the goal on.
    await send("Look over the parser before we start")
    await until("document.body.textContent.includes('Look over the parser before we start')", "the first message in the transcript")
    await until("document.querySelector('[data-composer] textarea').value === ''", "the sent draft cleared")

    await send("/goal pause")
    await toast("This conversation has no goal to pause.")
    assert.equal(await draft(), "/goal pause", "a command with no goal keeps the draft")
    for (let index = 0; index < 11; index += 1) await press("Backspace", "Backspace", 8)

    await send("/goal The parser tests pass")
    await until(`${bar}?.dataset.goalStatus === 'active'`, "the goal bar, working")
    assert.equal(await draft(), "", "a goal that was set clears the draft")
    assert.match(await evaluate(`${bar}.textContent`), /GoalWorkingThe parser tests pass/)
    assert.equal(await evaluate("document.body.textContent.includes('/goal The parser tests pass')"), false, "a goal Mako sets is no message in the transcript")
    await capture("bar-working.png", "section[aria-label=\"Goal\"]")

    await clickButton("Pause", bar)
    await until(`${bar}?.dataset.goalStatus === 'paused'`, "the goal paused")
    assert.match(await evaluate(`${bar}.textContent`), /Paused/)
    await capture("bar-paused.png", "section[aria-label=\"Goal\"]")
    await clickButton("Resume", bar)
    await until(`${bar}?.dataset.goalStatus === 'active'`, "the goal resumed")

    await click("section[aria-label=\"Goal\"] button[aria-expanded]")
    await until(`${bar}.textContent.includes('Claude Code keeps working toward this goal')`, "who keeps the goal, once expanded")
    await capture("bar-expanded.png", "section[aria-label=\"Goal\"]")
    await click("section[aria-label=\"Goal\"] button[aria-expanded]")

    // Replacing an unfinished goal asks first; keeping it keeps the draft.
    await send("/goal The changelog mentions the fix")
    await until("document.body.textContent.includes('Replace the goal?')", "the replace question")
    assert.match(await evaluate("document.body.textContent"), /still working toward “The parser tests pass”/)
    await capture("replace.png")
    await clickButton("Cancel")
    await until("!document.body.textContent.includes('Replace the goal?')", "the question dismissed")
    assert.equal(await draft(), "/goal The changelog mentions the fix", "keeping the goal keeps the draft")
    assert.match(await evaluate(`${bar}.textContent`), /The parser tests pass/)
    await press("Enter")
    await until("document.body.textContent.includes('Replace the goal?')", "the replace question again")
    await clickButton("Replace goal")
    await until(`${bar}?.textContent.includes('The changelog mentions the fix')`, "the new goal")
    assert.equal(await draft(), "")
    await until("!document.querySelector('[role=alertdialog], [role=dialog]')", "the question closed")

    await clickButton("Clear", bar)
    await until(`!${bar}`, "the goal bar gone")
    assert.equal(await goalStatus(), null)

    await send("/goal resume")
    await toast("This conversation has no goal to resume.")
    const erase = async () => {
      const length = (await draft()).length
      for (let index = 0; index < length; index += 1) await press("Backspace", "Backspace", 8)
      await until("document.querySelector('[data-composer] textarea').value === ''", "an empty draft")
    }
    await erase()

    // A budget that isn't a count keeps the draft; one that is goes with the goal, and the bar counts toward it.
    await send("/goal The parser tests pass --budget lots")
    await toast("“lots” isn't a token count. Write the budget as a number, such as --budget 200k or --budget 1.5m.")
    assert.equal(await draft(), "/goal The parser tests pass --budget lots", "a bad budget keeps the draft")
    await erase()
    await send("/goal The parser tests pass --budget 200k")
    await until(`${bar}?.textContent.includes('0 / 200k')`, "the budget, before any of it is spent")
    assert.match(await evaluate(`${bar}.textContent`), /The parser tests pass(?!.*--budget)/, "the objective is shown without the budget")
    await until(`${bar}?.textContent.includes('124k / 200k')`, "the count toward the budget")
    assert.equal(await evaluate(`${bar}.querySelector('span.tabular-nums[title]').title`), "1 turn · 124,000 of 200,000 tokens", "the whole count, on hover")
    await capture("bar-budget.png", "section[aria-label=\"Goal\"]")
    await until(`${bar}?.dataset.goalStatus === 'budget-limited'`, "the goal out of budget")
    const spent = await evaluate(`${bar}.textContent`)
    assert.match(spent, /Out of budget/)
    assert.match(spent, /208k \/ 200k/)
    assert.match(spent, /It spent its 200k-token budget\. To keep going, set the goal again with a larger budget\./)
    assert.equal(await evaluate(`[...${bar}.querySelectorAll('button')].some(b => b.textContent.trim() === 'Resume')`), false, "a goal out of budget can't be resumed")
    await capture("bar-out-of-budget.png", "section[aria-label=\"Goal\"]")
    await click("section[aria-label=\"Goal\"] button[aria-expanded]")
    await until(`${bar}.textContent.includes('2 turns · 208,000 of 200,000 tokens')`, "the whole count, once expanded")
    await capture("bar-out-of-budget-expanded.png", "section[aria-label=\"Goal\"]")
    console.log(`Goal UI: the / menu, empty and goal-less commands, set, Pause, Resume, the keeper, the replace question, Clear, and a token budget counted to Out of budget`)
  } finally {
    clearTimeout(timer)
    app.exit(process.exitCode ?? 0)
  }
}
