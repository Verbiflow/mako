import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Settings › Hooks and commands and › MCP servers over the authoring fixture,
 * driven with trusted input: every agent's view opens, an absent family says
 * why, a Codex hook is trusted and a Grok hook turned off through a preview
 * of the diff, a hook is created from the form, and an MCP server is switched
 * off in one agent's file. Screenshots, light and dark, go to the printed
 * folder, or to `--out <folder>`.
 *
 *   node scripts/test-authoring-ui.mjs [--out docs/audits/…/authoring-closure]
 */

if (process.versions.electron) {
  void review().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-authoring-ui-"))
  const out = process.argv.includes("--out") ? resolve(process.argv[process.argv.indexOf("--out") + 1]) : root
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-authoring-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_AUTHORING_TEST_ROOT: root, MAKO_AUTHORING_TEST_OUT: out, MAKO_AUTHORING_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Authoring settings screenshots: ${out}`)
}

async function review() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_AUTHORING_TEST_ROOT
  const out = process.env.MAKO_AUTHORING_TEST_OUT
  await mkdir(join(root, "profile"))
  await mkdir(out, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const errors = []
  page.on("console-message", (event) => { if (event.level === "error") errors.push(event.message) })
  const evaluate = (code) => page.executeJavaScript(code)
  const fixture = (code) => evaluate(`import('/src/dev/authoring-check.tsx').then(f => { ${code} })`)
  const settle = () => evaluate("document.fonts.ready.then(() => Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)")
  const screenshot = async (name) => {
    await evaluate("document.querySelector('[aria-label=\"Review the change\"]')?.scrollIntoView({ block: 'center' }); true")
    await settle()
    await writeFile(join(out, name), (await page.capturePage()).toPNG())
  }
  const until = async (code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) { await screenshot("failure.png"); throw new Error(`Timed out: ${code}`) }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const text = (value) => `document.body.textContent.includes(${JSON.stringify(value)})`
  /** Presses the last visible element matching `selector` whose text or label is `label`, with real mouse input. */
  const press = async (label, selector = "button,[role=switch],[role=tab]") => {
    const point = await evaluate(`(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getBoundingClientRect().width && (e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)})); const element = found.at(-1); if (!element) throw new Error('Missing: ' + ${JSON.stringify(label)}); element.scrollIntoView({ block: 'center' }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  await window.loadURL(`${process.env.MAKO_AUTHORING_TEST_URL}scripts/authoring-review.html`)
  window.showInactive()
  await until(text("~/.claude/settings.json"))
  assert.ok(await evaluate(text("Runs without asking")), "a project file Claude reads without trust says so")
  await screenshot("hooks-claude-dark.png")
  await fixture("f.theme('light')")
  await screenshot("hooks-claude-light.png")
  await fixture("f.theme('dark')")

  // Codex: an untrusted hook, trusted through a preview of the config.toml diff.
  await press("Codex", "[role=tab]")
  await until(text("~/.codex/hooks.json"))
  assert.ok(await evaluate(text("Not trusted")))
  await press("Trust")
  await until("Boolean(document.querySelector('[aria-label=\"Review the change\"]'))")
  assert.ok(await evaluate(text("as Codex's /hooks review does")), "the preview says what changes")
  assert.ok(await evaluate(text("~/.codex/config.toml")), "and names the file it writes, which is the user's config, not the hook's own file")
  await screenshot("hooks-codex-trust-preview-dark.png")
  await fixture("f.theme('light')")
  await screenshot("hooks-codex-trust-preview-light.png")
  await fixture("f.theme('dark')")
  await press("Apply")
  await until(text("is kept in Mako's backups"))

  // Grok: a hook turned off in ~/.grok/disabled-hooks, and the commands it reads with one shadowed.
  await press("Grok", "[role=tab]")
  await until(text("~/.grok/hooks/cmux-session.json"))
  assert.ok(await evaluate(text("Off: compat.cursor.hooks")), "an import Grok's config turns off says so")
  await press("Turn off SessionStart")
  await until("Boolean(document.querySelector('[aria-label=\"Review the change\"]'))")
  await screenshot("hooks-grok-switch-preview-dark.png")
  await press("Back")
  await press("Commands")
  await until(text("Not used"))
  await screenshot("commands-grok-dark.png")
  await fixture("f.theme('light')")
  await screenshot("commands-grok-light.png")
  await fixture("f.theme('dark')")

  // Cursor has no commands of its own: the reason, not an empty editor.
  await press("Cursor", "[role=tab]")
  await until(text("has no commands of its own"))
  await screenshot("commands-cursor-absent-dark.png")

  // A new Devin hook from the form, previewed before it is written.
  await press("Devin", "[role=tab]")
  await press("Hooks")
  await until(text("hooks.v1.json"))
  await press("Hook")
  await until("Boolean(document.querySelector('textarea'))")
  await evaluate("document.querySelector('textarea').focus()")
  await page.debugger.sendCommand("Input.insertText", { text: "./scripts/after-edit.sh" })
  await press("Preview change")
  await until("Boolean(document.querySelector('[aria-label=\"Review the change\"]'))")
  await screenshot("hooks-devin-create-dark.png")
  await fixture("f.theme('light')")
  await screenshot("hooks-devin-create-light.png")
  await fixture("f.theme('dark')")
  await press("Back")
  await press("Cancel")

  // MCP servers: one server set in six agents' files, switched off in Claude Code's.
  await fixture("f.show('mcp')")
  await until("document.querySelector('[aria-label=\"Where docs is set\"]') !== null")
  await press("Turn off docs for Codex")
  await until("Boolean(document.querySelector('[aria-label=\"Review the change\"]'))")
  await screenshot("mcp-places-dark.png")
  await fixture("f.theme('light')")
  await screenshot("mcp-places-light.png")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [], "the page logs no errors")
  clearTimeout(watchdog)
  console.log("Authoring settings: every agent's view, an absent family's reason, trust and switch previews, a hook from the form and an MCP server's files, light and dark")
  app.exit(0)
}
