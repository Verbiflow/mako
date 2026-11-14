import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Settings › Models › Connections and Add a connection, the production
 * components on the mock bridge, driven with trusted input: the list's
 * subscriptions and kept connections, the dialog's groups, search and local
 * detection, a gateway checked and added, a row tested, turned off and
 * removed, a subscription served through OpenCode, and light and dark
 * captures. `node scripts/test-model-connections-ui.mjs [evidence folder]`.
 */
if (!process.versions.electron) {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const root = testScratch("mako-model-connections-ui-")
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: Number(process.env.MAKO_UI_PORT ?? 0) } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ main: fileURLToPath(import.meta.url) }))
  const evidence = resolve(process.argv[2] ?? join(root, "evidence"))
  const env = { ...process.env, MAKO_CONNECTIONS_URL: server.resolvedUrls.local[0], MAKO_CONNECTIONS_ROOT: root, MAKO_CONNECTIONS_EVIDENCE: evidence }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("exit", done)
      child.once("error", fail)
    })
  } finally {
    await server.close()
  }
} else {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_CONNECTIONS_ROOT
  const evidence = process.env.MAKO_CONNECTIONS_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  await mkdir(evidence, { recursive: true })
  const window = new BrowserWindow({ show: false, width: 820, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const text = () => evaluate("document.body.innerText")
  const capture = async (name) => {
    await evaluate("Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))")
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, what = code) => {
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${what}`)
      }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const showing = (words) => until(`document.body.innerText.includes(${JSON.stringify(words)})`, `shows "${words}"`)
  const press = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  /** Clicks the one enabled control named `name`: its accessible label or its own text. */
  const click = async (name, within = "document") => {
    await until(`[...(${within}).querySelectorAll("button,[role=menuitem],[role=switch]")].some(e => !e.disabled && ((e.getAttribute("aria-label") ?? "") === ${JSON.stringify(name)} || e.innerText.trim() === ${JSON.stringify(name)}))`, `a control named "${name}"`)
    const point = await evaluate(`(() => {
      const found = [...(${within}).querySelectorAll("button,[role=menuitem],[role=switch]")].filter(e => !e.disabled && ((e.getAttribute("aria-label") ?? "") === ${JSON.stringify(name)} || e.innerText.trim() === ${JSON.stringify(name)}))
      if (found.length !== 1) throw new Error(found.length + " controls named ${name.replace(/"/g, "")}")
      found[0].scrollIntoView({ block: "center" })
      const r = found[0].getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    await press(point)
  }
  /** A row of the dialog's list, by provider name. */
  const pick = async (name) => {
    const point = await evaluate(`(() => {
      const row = [...document.querySelectorAll('[role=dialog] section button')].find(e => e.querySelector('.font-medium')?.innerText === ${JSON.stringify(name)})
      row.scrollIntoView({ block: "center" })
      const r = row.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    await press(point)
  }
  const type = (value) => page.debugger.sendCommand("Input.insertText", { text: value })
  const dialog = "document.querySelector('[role=dialog]')"
  const theme = (light) => evaluate(`document.documentElement.classList.toggle("light", ${light})`)
  const timer = setTimeout(() => {
    console.error("The connections UI check exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  try {
    await window.loadURL(`${process.env.MAKO_CONNECTIONS_URL}scripts/model-connections.html`)

    /* The list: each subscription's sign-ins, then what the person kept, each saying what it serves. */
    await showing("Serves OpenCode: 42 models · openrouter.ai")
    await showing("Serves OpenCode: 3 models · localhost:11434")
    const list = await text()
    assert.match(list, /Claude\nServes Claude Code · personal@example\.com, team@example\.com/, "Claude's row names its signed-in accounts")
    assert.match(list, /ChatGPT\nServes OpenCode · developer@example\.com/, "ChatGPT through OpenCode is a subscription row")
    assert.ok(!list.includes("GitHub Copilot"), "a subscription nobody signed in to has no row")
    await capture("list-dark.png")

    /* The dialog: one searchable list in four groups, local servers found on their ports. */
    await click("Add a connection")
    await until(`${dialog} !== null`)
    await showing("Running · 3 models")
    await showing("Not running")
    const groups = await evaluate(`[...${dialog}.querySelectorAll("section")].map(s => s.getAttribute("aria-label"))`)
    assert.deepEqual(groups, ["Subscriptions", "Gateways", "Local", "Custom endpoint"])
    assert.equal(await evaluate(`[...${dialog}.querySelectorAll("section button")].find(e => e.innerText.startsWith("OpenRouter")).disabled`), true, "a connected gateway can't be added twice")
    assert.match(await evaluate(`${dialog}.innerText`), /Claude\nPro or Max, through Claude Code's own sign-in\n✓?\s*2 accounts\nAdd another/)
    await capture("dialog-dark.png")
    await evaluate(`${dialog}.querySelector("section[aria-label='Custom endpoint']").scrollIntoView({ block: "end" })`)
    await capture("dialog-local-dark.png")
    await evaluate(`${dialog}.querySelector("input[aria-label='Search connections']").focus()`)
    await type("deep")
    await until(`${dialog}.querySelectorAll("section button").length === 1`, "search narrows to one row")
    assert.match(await evaluate(`${dialog}.innerText`), /Gateways[\s\S]*DeepInfra/)
    await evaluate(`(() => { const input = ${dialog}.querySelector("input[aria-label='Search connections']"); input.select() })()`)
    await type("nothing like it")
    await showing("Nothing matches.")
    await evaluate(`${dialog}.querySelector("input[aria-label='Search connections']").select()`)
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
    await until(`${dialog}.querySelectorAll("section").length === 4`)

    /* A subscription served through OpenCode signs in with OpenCode's own login. */
    await pick("GitHub Copilot")
    await showing("opencode auth login")
    await click("Back to all connections")
    await until(`${dialog}.querySelectorAll("section").length === 4`)

    /* A gateway: paste a key, Check access lists what it serves, keep them, add. */
    await pick("Together AI")
    await until("document.activeElement?.type === 'password'", "the key field takes focus")
    assert.equal(await evaluate(`[...${dialog}.querySelectorAll("button[type=submit]")][0].disabled`), true, "Check access waits for a key")
    await type("tgp-fake-refused")
    await click("Check access", dialog)
    await showing("The endpoint refused this key.")
    await evaluate("document.querySelector('input[type=password]').select()")
    await type("tgp-fake-key")
    await click("Check access", dialog)
    await showing("Keeps 8 of 8 models")
    await capture("check-dark.png")
    await click("Keep none", dialog)
    await showing("Keeps 0 of 8 models")
    assert.equal(await evaluate(`${dialog}.querySelector("button[type=submit]").disabled`), true, "nothing kept, nothing to add")
    await click("Keep all", dialog)
    await click("Add 8 models", dialog)
    await until(`${dialog} === null`, "the dialog closes once added")
    await showing("Serves OpenCode: 8 models · api.together.xyz")

    /* A row: test, turn off, remove. */
    const row = (name) => `[...document.querySelectorAll('[role=listitem]')].find(e => e.querySelector('.font-medium')?.innerText === ${JSON.stringify(name)})`
    await click("Test", row("OpenRouter"))
    await showing("Reachable: it lists 341 models.")
    await click("Turn off Ollama")
    await showing("Off · localhost:11434")
    assert.equal(await evaluate(`${row("Ollama")}.querySelector("[role=switch]").getAttribute("aria-checked")`), "false")
    await click("Together AI options")
    await click("Remove connection")
    await showing("Remove this connection and its key from this Mac?")
    await until("document.querySelector('[role=menu]') === null", "the menu has gone")
    await click("Remove", row("Together AI"))
    await until(`!document.body.innerText.includes("api.together.xyz")`, "the removed row goes")
    await click("Turn on Ollama")
    await showing("Serves OpenCode: 3 models · localhost:11434")
    await click("Dismiss", row("OpenRouter"))

    /* Light. */
    await theme(true)
    await capture("list-light.png")
    await click("Add a connection")
    await showing("Running · 3 models")
    await capture("dialog-light.png")
    await evaluate(`${dialog}.querySelector("section[aria-label='Custom endpoint']").scrollIntoView({ block: "end" })`)
    await capture("dialog-local-light.png")
    await pick("Fireworks")
    await until("document.activeElement?.type === 'password'")
    await type("fw-fake-key")
    await click("Check access", dialog)
    await showing("Keeps 8 of 8 models")
    await capture("check-light.png")
    await click("Close", dialog)
    await until(`${dialog} === null`)
    window.setSize(440, 900)
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false, "the list fits a narrow window")
    console.log("PASS: connections list with subscriptions and kept connections; dialog groups, search, local detection; a subscription through OpenCode; a gateway checked, refused, kept and added; test, turn off and on, remove; narrow layout; light and dark captures")
  } finally {
    clearTimeout(timer)
    window.destroy()
    app.quit()
  }
}
