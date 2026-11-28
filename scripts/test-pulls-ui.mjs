import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The Pull requests panel on the mock bridge (`?mock`), whose project holds three repositories: `acme/api` and
 * `acme/web` list, `acme/infra` can't be read. The tab reads "2 needs you" in the attention hue; rows sit in their
 * sections in order, coded `name#n`; the failed repository is one line with its one fix; merged and closed fold; the
 * keys walk, fold and switch to Issues. `--url <base>` uses a running Vite server. Run by hand: `npm run test:pulls-ui`.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-pulls-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-pulls-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The pull requests UI check", code, signal)))
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
  const guard = guardElectronCheck({ app, page, name: "The pull requests UI check", ms: 180_000 })
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) {
        await writeFile(join(root, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${label}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const click = async (selector) => {
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  }
  const key = async (key) => {
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, text: type === "keyDown" && key.length === 1 ? key : undefined, windowsVirtualKeyCode: key === "Enter" ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 })
  }
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await window.loadURL(`${base}/?mock`).catch((error) => { if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error })
  await until("Boolean(document.querySelector('[data-side-rail] [data-surface-id=pulls]'))", "the Pull requests tab")

  // The tab: beside Changes, reading who needs the person in the attention hue.
  const tabs = await evaluate("[...document.querySelectorAll('[data-side-rail] [data-surface-id]')].map((row) => row.dataset.surfaceId)")
  assert.equal(tabs[tabs.indexOf("changes") + 1], "pulls", "Pull requests sits beside Changes")
  await until("/2 needs you|^2$/.test(document.querySelector('[data-surface-id=pulls] [data-tab-reading]')?.innerText ?? '')", "the tab's reading")
  const hue = await evaluate(`(() => {
    const probe = document.createElement('span'); probe.className = 'text-attention'; document.body.append(probe)
    const attention = getComputedStyle(probe).color; probe.remove()
    return getComputedStyle(document.querySelector('[data-surface-id=pulls] [data-tab-reading]')).color === attention
  })()`)
  assert.ok(hue, "needs you reads in the attention hue")

  // The panel: sections in order, name#n codes, the failed repository as one line with its fix.
  await click("[data-side-rail] [data-surface-id=pulls]")
  await until("document.querySelectorAll('[data-pulls-panel] [data-pull]').length > 0", "the panel's rows")
  const sections = await evaluate("[...document.querySelectorAll('[data-pulls-panel] [data-list-section]')].map((section) => section.dataset.listSection + (section.dataset.folded ? ' (folded)' : ''))")
  assert.deepEqual(sections, ["Needs you", "Ready to merge", "Waiting on checks", "Waiting on others", "Draft", "Recently merged (folded)", "Recently closed (folded)"], "the sections in their order, history folded")
  const codes = await evaluate("[...document.querySelectorAll('[data-pulls-panel] [data-list-section=\"Needs you\"] [data-pull]')].map((row) => row.innerText.split('\\n').filter(Boolean)[0])")
  assert.deepEqual(codes, ["web#90", "api#412"], "a project of several repositories names each row's repository, most recently updated first")
  const problem = await evaluate("document.querySelector('[data-pulls-panel] [data-board-problem]')?.innerText")
  assert.match(problem, /acme\/infra couldn't be read: this login can't see it\s*Open on GitHub/, "the failed repository is one line with its one fix")
  assert.equal(await evaluate("document.querySelectorAll('[data-pulls-panel] [data-board-problem]').length"), 1, "only the failed repository says so")
  assert.match(await evaluate("document.querySelector('[data-board-footer]').innerText"), /6 open · 3 repositories · read/, "the footer counts")

  // Keys while the panel holds focus: j walks, a folded section opens on its header, 2 switches to Issues.
  await evaluate("document.querySelector('[data-pulls-panel] [data-pull]').focus(); document.querySelector('[data-pulls-panel] [data-pull]').click(); true")
  await key("j")
  await until("document.querySelector('[data-pulls-panel] [data-selected]')?.dataset.pull === 'acme/api#412'", "j selects the next row")
  await click("[data-pulls-panel] [data-list-section='Recently merged'] h2 button")
  await until("!document.querySelector('[data-pulls-panel] [data-list-section=\"Recently merged\"]').dataset.folded", "the merged section opens")
  await key("2")
  await until("document.querySelectorAll('[data-pulls-panel] [data-issue]').length === 3", "the Issues view, its closed folded")
  const issueSections = await evaluate("[...document.querySelectorAll('[data-pulls-panel] [data-list-section]')].map((section) => section.dataset.listSection)")
  assert.deepEqual(issueSections, ["Assigned to you", "Open", "Recently closed"], "issues in their sections")
  await key("1")
  await until("document.querySelectorAll('[data-pulls-panel] [data-pull]').length > 0", "back to pull requests")

  await writeFile(join(root, "panel.png"), (await page.capturePage()).toPNG())

  // The page: the rail's row opens it over the conversation, across projects, the same sections; a row previews, Enter
  // opens the pull request as a tab, Escape goes back.
  await click('[data-rail-top-row="pulls"]')
  await until("document.querySelectorAll('[data-pulls-page] [data-pull]').length > 0", "the page's rows")
  assert.match(await evaluate("document.querySelector('[data-pulls-page] [data-list-summary]').innerText"), /2 need you · 6 open · 3 repositories in \d+ projects/, "the page's summary")
  assert.deepEqual(
    await evaluate("[...document.querySelectorAll('[data-pulls-page] [data-list-section]')].map((section) => section.dataset.listSection).slice(0, 5)"),
    ["Needs you", "Ready to merge", "Waiting on checks", "Waiting on others", "Draft"],
    "the page's sections are the panel's"
  )
  assert.match(await evaluate("document.querySelector('[data-pulls-page] [data-board-problem]').innerText"), /acme\/infra couldn't be read/, "the page says the failed repository too")
  await evaluate("document.querySelector('[data-pulls-page] [data-pull=\"acme/api#412\"]').click(); true")
  await until("document.querySelector('[data-board-preview]')?.dataset.boardPreview === 'acme/api#412'", "the preview")
  await until("/lint/.test(document.querySelector('[data-board-preview]').innerText) && /Retries now back off/.test(document.querySelector('[data-board-preview]').innerText)", "the preview's checks and description")
  await key("Enter")
  await until("[...document.querySelectorAll('[role=tab]')].some((tab) => /api#412/.test(tab.textContent))", "the pull request's tab")
  await click('[data-rail-top-row="pulls"]')
  await until("Boolean(document.querySelector('[data-pulls-page]'))", "the page again")
  await key("Escape")
  await until("!document.querySelector('[data-pulls-page]')", "Escape puts the page away")
  console.log("Pull requests page: summary, sections, the failed line, preview, Enter as a tab, Escape passed")
  console.log(`Pull requests UI: the tab's reading, sections, name#n codes, a failed repository's one line, keys and Issues passed (${root})`)
  app.exit(0)
}
