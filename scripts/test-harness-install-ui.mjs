import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, navigate, withMotion } from "./lib/test-window.mjs"

// A harness that isn't installed installs from where the person first wants it, on the production components and the
// mock bridge's install scene (`?install=devin`, whose installer is a stand-in that lands Devin's tested version, or
// fails once with `-fails`): the harness picker installs it in one click, the line above the composer follows the
// install to its sign-in, and that sign-in opens in the harness's Settings row; a composer on a harness not installed
// offers Install there, a failure says why with Try again, and Try again lands it. Screenshots land in the printed
// folder (or `MAKO_INSTALL_UI_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-harness-install-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-harness-install-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_INSTALL_UI_ROOT: root, MAKO_INSTALL_UI_URL: server.resolvedUrls.local[0] }
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
  console.log(`Harness install UI evidence: ${process.env.MAKO_INSTALL_UI_SHOTS ?? join(root, "shots")}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_INSTALL_UI_ROOT
  const shots = process.env.MAKO_INSTALL_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_INSTALL_UI_URL
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  atSize(window, 1440, 900)
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const shoot = async (name) => {
    await new Promise((done) => setTimeout(done, 300))
    await writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const notice = "document.querySelector('[data-harness-install-step]')"
  const step = () => evaluate(`${notice}?.getAttribute('data-harness-install-step') ?? null`)
  const noticeText = () => evaluate(`${notice}?.innerText.replace(/\\s+/g, ' ') ?? ''`)
  const press = (scope, label) => evaluate(`(() => { const button = [...document.querySelectorAll('${scope} button')].find((node) => node.innerText.trim() === ${JSON.stringify(label)}); if (!button) throw new Error('No ${label} in ${scope}'); button.click(); return true })()`)
  const newThread = async () => {
    await until("[...document.querySelectorAll('span')].some((node) => node.textContent.trim() === 'New thread')", "the rail")
    await evaluate("[...document.querySelectorAll('span')].find((node) => node.textContent.trim() === 'New thread').closest('button').click(); true")
    await until("Boolean(document.querySelector('[data-composer]'))", "a new thread's composer")
  }
  const composerHarness = () => evaluate("import('/src/state/thread-store.ts').then((store) => store.threadsStore.get().composerHarness)")

  // The picker: Devin isn't installed, so its row offers Install; one click picks it and installs it.
  await navigate(window, `${base}?mock&install=devin`)
  await newThread()
  assert.equal(await step(), null, "nothing is said while the composer's harness is installed")
  await evaluate("(() => { const trigger = [...document.querySelectorAll('[data-composer] button')].find((node) => /Opus/.test(node.innerText)); trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true })()")
  await until("Boolean(document.querySelector('[data-harness-install=devin]'))", "Devin's row in the picker")
  const row = await evaluate("document.querySelector('[data-harness-install=devin]').innerText.replace(/\\s+/g, ' ')")
  assert.match(row, /Devin\s*Install/, row)
  await shoot("picker-install")
  await evaluate("document.querySelector('[data-harness-install=devin]').click(); true")
  await until(`${notice}?.getAttribute('data-harness-install-step') === 'installing'`, "the line above the composer following the install")
  assert.equal(await composerHarness(), "devin", "the picker's pick stands while its harness installs")
  assert.equal(await noticeText(), "Installing Devin… · 3000.14.30821")
  await shoot("composer-installing")
  // Installed: the next step is signing in, in Mako.
  await until(`${notice}?.getAttribute('data-harness-install-step') === 'sign-in'`, "the sign-in after the install")
  assert.match(await noticeText(), /^Devin is installed · sign in to use it Sign in$/)
  assert.deepEqual(await evaluate("window.mockInstallRuns"), ["devin"])
  await shoot("composer-sign-in")
  await press("[data-harness-install-step=sign-in]", "Sign in")
  await until("document.querySelector('#provider-devin-accounts')?.innerText.includes('Sign in, then paste the code')", "Devin's sign-in in its Settings row")
  await evaluate("document.querySelector('[role=listitem][aria-label=Devin]').scrollIntoView({ block: 'start' }); true")
  await shoot("settings-sign-in")
  console.log("PASS: the picker installs a missing harness in one click, and the composer follows it to its sign-in")

  // The composer on a harness not installed (as a Thread on it would be): Install, a failure with Try again, then in.
  await navigate(window, `${base}?mock&install=devin-fails`)
  await newThread()
  await evaluate("import('/src/state/thread-tuning.ts').then((tuning) => { tuning.setComposerHarness('devin'); return true })")
  await until(`${notice}?.getAttribute('data-harness-install-step') === 'install'`, "the line offering Install")
  assert.equal(await noticeText(), "Devin isn't installed · installs 3000.14.30821, the version Mako is tested with Install")
  await shoot("composer-install")
  await press("[data-harness-install-step=install]", "Install")
  await until(`${notice}?.getAttribute('data-harness-install-step') === 'failed'`, "the failure")
  assert.equal(await noticeText(), "Devin wasn't installed · The download didn't get through. Check the connection. Try again")
  await shoot("composer-failed")
  await press("[data-harness-install-step=failed]", "Try again")
  await until(`${notice}?.getAttribute('data-harness-install-step') === 'sign-in'`, "the sign-in after Try again")
  assert.deepEqual(await evaluate("window.mockInstallRuns"), ["devin", "devin"])
  console.log("PASS: a composer on a missing harness installs it, says why it failed, and Try again lands it")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools|broken-example/.test(message)), [])
  console.log("Harness install UI: passed")
  app.exit(0)
}
