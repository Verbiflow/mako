import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// An Apex's Overview in the desk's right rail, on the mock bridge's Apex scene (`?mock&app=apex`): the twelve Fins
// with every section filled (`&fins=overview`), the plain twelve, two hundred Fins (`&fincount=200`) folded to their
// first rows and opened into a windowed list, and a Thread with no Fins, which keeps Changes. It checks what each must
// draw and that the Apex's own stream draws nothing in the panel, and writes the screenshots into <out>.
//
//   node scripts/apex-overview-screenshots.mjs <out> [--port 20031]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "apex-overview-screenshots")
  const port = Number(args[args.indexOf("--port") + 1]) || 20031
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-apex-overview-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_OVERVIEW_SHOTS: out, MAKO_OVERVIEW_URL: `http://127.0.0.1:${port}/` }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [join(out, "electron")], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Overview screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_OVERVIEW_SHOTS
  const base = process.env.MAKO_OVERVIEW_URL
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const end = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await writeFile(join(out, "timed-out.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out: ${what}`)
      }
      await pause(50)
    }
  }
  const capture = async (name, selector) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await pause(400)
    const box = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } })()`)
      : undefined
    await writeFile(join(out, name), (await page.capturePage(box)).toPNG())
  }
  const open = async (query) => {
    await window.loadURL(`${base}?mock&app=apex&idle=1${query}`)
    await until("document.querySelectorAll('[data-thread-row]').length > 0", "the desk")
    await toApex()
  }
  // The desk boots on whichever conversation was last on screen: the Apex's row brings its Thread.
  const toApex = async () => {
    await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
    await until("Boolean(document.querySelector('[data-crew]'))", "the Apex's Thread")
  }
  const headings = () => evaluate("[...document.querySelectorAll('[data-apex-fins] [data-child-group], [data-overview-section=background] [data-child-group]')].map((node) => node.innerText.replace(/\\s+/g, ' ').trim())")
  const rows = (section) => evaluate(`document.querySelectorAll('[data-overview-section=${section}] [data-child-row]').length`)

  for (const theme of ["dark"]) {
    nativeTheme.themeSource = theme
    // Every section filled. The rail is open at boot on what it last showed, Changes: an Apex shows its Overview over it.
    await open(`&fins=overview&theme=${theme}`)
    await until("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))", "the Overview, with nothing pressed")
    assert.equal(await evaluate("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId"), "agents", "the Apex's rail opens on its Overview")
    assert.equal(await evaluate("document.querySelector('[data-side-rail] [data-surface-id=agents]').getAttribute('aria-label')"), "Overview", "and its row is named so")
    await until("document.querySelectorAll('[data-overview-pull]').length === 3", "the tree's three pull requests")
    assert.deepEqual(await headings(), ["Needs you 3", "Working 5", "Waiting 3", "Failed 1", "Pull requests 3"], `the sections that hold something, in order (${theme})`)
    const pulls = await evaluate("[...document.querySelectorAll('[data-overview-pull]')].map((node) => node.innerText.replace(/\\s+/g, ' ').trim())")
    assert.match(pulls.join(" | "), /#371 .+ Checks passed \| #366 .+ Checks failed \| #368 .+ Checks running/, "each with its number, title and checks, in the roster's order")
    assert.match(await evaluate("document.querySelector('[data-overview-section=waiting] [data-child-row]').innerText"), /Waiting on you\/mako#368 checks · 12m/, "a waiting Fin says what it waits on, and for how long")
    assert.equal(await evaluate("document.querySelectorAll('[data-overview-section=needs] [data-fin-answer]').length > 0"), true, "an ask is answered in place")
    const overflow = await evaluate("[...document.querySelectorAll('.companion-panel [data-child-row], .companion-panel [data-overview-pull]')].filter((row) => [...row.querySelectorAll('.truncate')].some((each) => each.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5)).length")
    assert.equal(overflow, 0, "no row's words run past its edge")
    await capture(`overview-${theme}.png`)
    await capture(`overview-${theme}-panel.png`, ".companion-panel")

    // Under the pointer or focus a row offers Message and Stop; the row itself opens the Fin.
    await evaluate("document.querySelector('[data-overview-section=working] [data-child-row]').focus(); true")
    await capture(`overview-${theme}-row-actions.png`, ".companion-panel")
  }
  nativeTheme.themeSource = "dark"

  // The Apex's own answer streaming draws nothing in the panel: nothing in it changes while the transcript does.
  await window.loadURL(`${base}?mock&app=apex&fins=overview&theme=dark`)
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the desk with a turn running")
  await toApex()
  await until("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))", "the Overview beside a running turn")
  const streamed = await evaluate(`(async () => {
    let overview = 0
    let transcript = 0
    // Rows coming, going or being drawn anew.
    // A row's own clock is left out: its time appearing ("1s") or turning over is the second clock's, never a batch's.
    const clock = (record) => [...record.addedNodes, ...record.removedNodes].every((node) => node.nodeType === 3 || node.classList?.contains('tabular'))
    const panel = new MutationObserver((records) => { overview += records.filter((record) => !clock(record)).length })
    panel.observe(document.querySelector('.companion-panel [data-sheet-scroll]'), { subtree: true, childList: true })
    const main = new MutationObserver((records) => { transcript += records.length })
    main.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true })
    await new Promise((done) => setTimeout(done, 2500))
    panel.disconnect()
    main.disconnect()
    return { transcript, overview }
  })()`)
  console.log("STREAM", JSON.stringify(streamed))
  assert.equal(streamed.overview, 0, `no row of the Overview came, went or was drawn anew beside a running turn: ${JSON.stringify(streamed)}`)

  // A pick for this Thread is kept: Changes, then back to the Thread, is still Changes; the Overview's row brings it back.
  await evaluate("document.querySelector('[data-side-rail] [data-surface-id=changes]').click(); true")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'changes'", "Changes, picked on the Apex")
  await evaluate("document.querySelector('[data-side-rail] [data-surface-id=agents]').click(); true")
  await until("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))", "the Overview again from its row")

  // The plain twelve: no Fin waits on a pull request and none failed, so those sections aren't drawn.
  await open("&theme=dark")
  await until("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))", "the twelve's Overview")
  assert.deepEqual(await headings(), ["Needs you 2", "Working 5", "Waiting 3", "Done 2"], "the twelve by section")
  await capture("overview-twelve.png", ".companion-panel")

  // Two hundred Fins: ten a section until one is opened, and an opened one past a hundred rows mounts a screenful.
  await open("&fincount=200&theme=dark")
  await until("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))", "two hundred Fins' Overview")
  assert.equal(await evaluate("document.querySelector('[data-apex-fins]').dataset.apexFins"), "200")
  const folded = await evaluate("document.querySelectorAll('.companion-panel [data-child-row]').length")
  const sections = await evaluate("document.querySelectorAll('[data-apex-fins] [data-overview-section]').length")
  assert.ok(folded <= sections * 10, `at most ten rows a section before any is opened: ${folded} rows in ${sections} sections`)
  await capture("overview-200.png")
  await capture("overview-200-panel.png", ".companion-panel")
  const working = await evaluate("document.querySelector('[data-overview-section=working] [data-child-group]').innerText.replace(/\\s+/g, ' ').trim()")
  await evaluate("document.querySelector('[data-overview-section=working] [data-overview-more]').click(); true")
  await until("Boolean(document.querySelector('[data-overview-section=working] [data-overview-windowed]'))", "the opened section, windowed")
  await pause(300)
  const mounted = await rows("working")
  const total = Number(await evaluate("document.querySelector('[data-overview-section=working] [data-overview-windowed]').dataset.overviewWindowed"))
  console.log("WINDOWED", JSON.stringify({ working, total, mounted }))
  assert.ok(total > 100 && mounted < 60, `an opened section of ${total} mounts what's in view: ${mounted}`)
  await capture("overview-200-opened.png", ".companion-panel")
  await evaluate("(() => { const el = document.querySelector('.companion-panel [data-sheet-scroll]'); el.scrollTop = el.scrollHeight; return true })()")
  await pause(400)
  assert.ok((await rows("working")) < 60, "and still a screenful at the list's end")
  await capture("overview-200-end.png", ".companion-panel")

  // A Thread with no Fins keeps what the rail showed: Changes.
  await open("&theme=dark")
  await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => !row.innerText.includes('Mobile polish'))?.click(); true")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'changes'", "a Thread with no Fins on Changes")
  assert.equal(await evaluate("Boolean(document.querySelector('.companion-panel [data-apex-fins]'))"), false, "no Overview for it")
  await capture("thread-without-fins.png")

  console.log("PASS: an Apex's rail opens on its Overview, section by section, and another Thread keeps Changes")
  app.exit(0)
}
