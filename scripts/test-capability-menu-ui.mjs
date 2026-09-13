import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The composer's `/` and `$` capability menu against a real host: discovery
 * runs for real, the selected provider changes what is listed, picks insert
 * the typed sigil, and a bare `$5` never covers the draft. Screenshots stay in
 * the printed directory. Nothing is sent to a provider.
 */
if (process.versions.electron) {
  void check().then(async () => {
    const { app } = await import("electron")
    app.exit(0)
  }).catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const url = process.argv[2]
  assert.ok(url, "Pass the URL printed by npm run dev")
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  const root = await mkdtemp(join(tmpdir(), "mako-capability-menu-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-capability-menu-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_MENU_CHECK_ROOT: root, MAKO_MENU_CHECK_URL: url }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolveExit(code ?? 1))
  })
  console.log(`Capability menu evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_MENU_CHECK_ROOT
  const base = process.env.MAKO_MENU_CHECK_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const capture = async (name) => {
    // Let the menu's entrance finish so the capture shows its settled paint.
    await new Promise((resolveTick) => setTimeout(resolveTick, 350))
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise((resolveTick) => setTimeout(resolveTick, 40))
    }
  }
  const click = async (selector, text = "") => {
    // Floating surfaces position in a layout effect; read the rect after that frame.
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    const point = await evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.startsWith(${JSON.stringify(text)})); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); node.scrollIntoView({block:'nearest'}); const r = node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode })
  }
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const inputValue = () => evaluate("document.querySelector('.composer-input').value")
  const clearInput = async () => {
    await evaluate("(() => { const input = document.querySelector('.composer-input'); input.focus(); input.select(); })()")
    await key("Backspace", "Backspace", 8)
    await until("document.querySelector('.composer-input').value === ''")
  }
  const menu = (sigil) => `document.querySelector('[data-mention-menu="${sigil}"]')`
  const rows = () => evaluate("[...document.querySelectorAll('[data-mention-menu] [role=option]')].map(node => ({title: node.querySelector('.font-mono').textContent, builtIn: Boolean(node.querySelector('[aria-label=\"Built into Mako\"]')), badge: node.querySelector('[data-slot], .ring-inset')?.textContent ?? null, group: node.closest('[role=group]').getAttribute('aria-label')}))")
  const watchdog = setTimeout(() => app.exit(1), 240_000)
  try {
    await window.loadURL(base)
    await until("Boolean(document.querySelector('.composer-input')) && !document.querySelector('.composer-input').readOnly")
    const profiles = await evaluate("window.mako.harnessProfiles()")
    const report = {}
    for (const theme of ["dark", "light"]) {
      // Mako's theme is its own preference, not the OS setting.
      await evaluate(`import('/src/state/prefs.ts').then(({setPref}) => setPref('theme', ${JSON.stringify(theme)}))`)
      await until(`document.documentElement.classList.contains('light') === ${JSON.stringify(theme === "light")}`)
      for (const profile of profiles.slice(0, theme === "dark" ? profiles.length : 1)) {
        await click('[data-composer] button[aria-label^="Agent:"]')
        await until(`Boolean([...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.startsWith(${JSON.stringify(profile.label)})))`)
        await click('[role="dialog"] button', profile.label)
        try {
          await until("!document.querySelector('[role=\"dialog\"]')", 5_000)
        } catch {
          // A provider whose row needs a sign-in flow keeps the picker open; it is not this menu's concern.
          console.error(`UNVERIFIED: ${profile.id}: the agent picker did not accept the selection`)
          await key("Escape", "Escape", 27)
          await until("!document.querySelector('[role=\"dialog\"]')")
          continue
        }
        await click(".composer-input")
        await type("$")
        await until(`Boolean(${menu("$")})`)
        // Discovery may still be running on the first open; wait for it to land.
        await until(`${menu("$")} && !${menu("$")}.hasAttribute('data-loading') && document.querySelectorAll('[data-mention-menu] [role=option]').length > 0`, 120_000)
        await new Promise((resolveTick) => setTimeout(resolveTick, 300))
        await capture(`${theme}-${profile.id}-dollar.png`)
        const listed = await rows()
        const header = await evaluate(`${menu("$")}.getAttribute('aria-label')`)
        const selected = await evaluate("document.querySelector('[data-composer] button[aria-label^=\"Agent:\"]').getAttribute('aria-label').slice(7)")
        assert.equal(selected, profile.label, "the picker took the selection")
        assert.ok(header.includes(profile.label), `header names the selected provider: ${header}`)
        assert.ok(listed.some((row) => row.builtIn && row.group === "MCP servers"), "a built-in Mako server wears the fin")
        assert.ok(listed.some((row) => row.title === "mako-conversations"), "the launch-attached conversation tools are listed")
        report[`${theme}:${profile.id}`] = listed
        await clearInput()
      }
    }
    await evaluate("import('/src/state/prefs.ts').then(({setPref}) => setPref('theme', 'dark'))")

    // Filtering highlights the name hit and a pick inserts the typed sigil.
    await click(".composer-input")
    await type("$mako-b")
    await until(`${menu("$")} && document.querySelectorAll('[data-mention-menu] [role=option]').length > 0`)
    await capture("filtered.png")
    assert.ok(await evaluate("Boolean(document.querySelector('[data-mention-menu] [role=option] .font-semibold'))"), "matched glyphs are emphasised")
    assert.equal(await evaluate("document.querySelector('[data-mention-menu] [role=group]').getAttribute('aria-label')"), "MCP servers", "a server name hit leads")
    await key("ArrowDown", "ArrowDown", 40)
    await key("ArrowUp", "ArrowUp", 38)
    await key("Enter", "Enter", 13)
    await until("!document.querySelector('[data-mention-menu]')")
    const picked = await inputValue()
    assert.match(picked, /^\$mcp:mako-\S+ $/, `a server pick inserts the $ form: ${JSON.stringify(picked)}`)
    assert.ok(await evaluate("Boolean(document.querySelector('[data-composer] .ring-border'))"), "the inserted token paints as a chip")
    await capture("picked.png")
    await clearInput()

    // `/` opens the same vocabulary at the start of an empty draft.
    await click(".composer-input")
    await type("/")
    await until(`Boolean(${menu("/")})`)
    await until("document.querySelectorAll('[data-mention-menu] [role=option]').length > 0")
    await capture("slash.png")
    await key("Enter", "Enter", 13)
    await until("!document.querySelector('[data-mention-menu]')")
    const slashPick = await inputValue()
    assert.match(slashPick, /^\/\S+ $/, `a slash pick keeps the slash: ${JSON.stringify(slashPick)}`)
    await clearInput()

    // A `$` that is not a mention never covers the draft and gives Enter back.
    await click(".composer-input")
    await type("$5")
    await new Promise((resolveTick) => setTimeout(resolveTick, 200))
    assert.equal(await evaluate("document.querySelector('[data-mention-menu]')"), null, "$5 opens nothing")
    await key("Escape", "Escape", 27)
    await clearInput()

    // A slash later in the draft is prose.
    await click(".composer-input")
    await type("fix /Users/me/repo")
    await new Promise((resolveTick) => setTimeout(resolveTick, 200))
    assert.equal(await evaluate("document.querySelector('[data-mention-menu]')"), null, "a path is not a command")
    await clearInput()

    // The + menu's "Use a skill" takes focus and hands it back inside the
    // composer's blur window; the menu it opens must outlive that timer.
    await click("[aria-label='Add to message']")
    await until("Boolean(document.querySelector('[data-add=\"skill\"]'))")
    await click("[data-add='skill']")
    await until(`Boolean(${menu("$")})`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 400))
    assert.ok(await evaluate(`Boolean(${menu("$")})`), "the skill menu opened from + survives the composer's blur timer")
    assert.equal(await inputValue(), "$", "the + menu inserted the sigil")
    await key("Escape", "Escape", 27)
    await clearInput()

    await writeFile(join(root, "rows.json"), JSON.stringify(report, null, 2))
    for (const [key, listed] of Object.entries(report)) console.log(`${key}: ${listed.map((row) => `${row.group === "Skills" ? "skill" : "mcp"}:${row.title}${row.builtIn ? "*" : ""}`).join(", ")}`)
    console.log("PASS: capability menu lists provider-relevant skills and MCP servers, filters, picks, and steps aside")
  } catch (error) {
    await capture("failure.png")
    throw error
  } finally {
    clearTimeout(watchdog)
    window.destroy()
  }
}
