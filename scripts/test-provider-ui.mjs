import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void review().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-provider-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**"] },
    },
  })
  await server.listen()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-provider-ui",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_PROVIDER_TEST_ROOT: root,
    MAKO_PROVIDER_TEST_URL: server.resolvedUrls.local[0],
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], {
      stdio: "inherit",
      env,
    })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Provider settings evidence: ${root}`)
}

async function review() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PROVIDER_TEST_ROOT
  await mkdir(join(root, "profile"))
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1200,
    height: 840,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const page = window.webContents
  page.debugger.attach("1.3")
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const fixture = (code) =>
    evaluate(`import('/src/dev/provider-check.tsx').then(f => { ${code} })`)
  const screenshot = async (name) => {
    await evaluate(
      "document.fonts.ready.then(() => Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).then(() => true)"
    )
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await screenshot("failure.png")
        throw new Error(`Timed out: ${code}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  const click = async (text) => {
    const point = await evaluate(
      `(() => { const buttons = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width && b.textContent.trim() === ${JSON.stringify(text)}); const button = buttons.at(-1); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)}); const r = button.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`
    )
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    })
  }
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  await window.loadURL(
    `${process.env.MAKO_PROVIDER_TEST_URL}scripts/provider-review.html`
  )
  await until("document.body.textContent.includes('0.0.0-beta-19425')")
  assert.equal(
    await evaluate("document.querySelectorAll('[role=list]').length"),
    1
  )
  assert.equal(
    await evaluate("document.body.textContent.includes('Runtime versions')"),
    false
  )
  await screenshot("agents-dark.png")
  await fixture("f.theme('light')")
  await screenshot("agents-light.png")
  await fixture("f.theme('dark')")
  await evaluate(
    `document.querySelector('[aria-label="Manage Cursor"]').click()`
  )
  await click("Paste API key")
  await until("document.activeElement?.type === 'password'")
  await page.debugger.sendCommand("Input.insertText", { text: "fixture-key" })
  await click("Save")
  await until("document.body.textContent.includes('This key was refused')")
  assert.equal(
    await evaluate("document.querySelector('input[type=password]').value"),
    "fixture-key"
  )
  await evaluate(
    "document.querySelector('[role=alert]').scrollIntoView({block:'center'})"
  )
  await screenshot("agents-auth-error.png")
  await click("Cancel")
  await click("Close")
  await evaluate(
    `document.querySelector('[aria-label="Manage OpenCode"]').click()`
  )
  await until("document.body.textContent.includes('OpenCode credentials')")
  assert.equal(
    await evaluate("document.querySelectorAll('[role=list]').length"),
    1
  )
  await evaluate(
    "document.querySelector('#provider-opencode-accounts').scrollIntoView({block:'center'})"
  )
  await screenshot("agents-opencode-credentials.png")
  await evaluate(
    "document.querySelector('[aria-label=\"Update OpenCode 1\"]').scrollIntoView({block:'center'})"
  )
  // The update nearest OpenCode 1 must dispatch its installation key only.
  const updatePoint = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Update OpenCode 1"]');
    const r = button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`)
  for (const type of ["mousePressed", "mouseReleased"])
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      ...updatePoint,
    })
  await until("document.body.textContent.includes('Download interrupted')")
  assert.deepEqual(await fixture("return f.calls"), ["sign-in-key", "opencode"])
  assert.equal(
    await evaluate("document.body.textContent.includes('0.0.0-beta-19425')"),
    true
  )
  await screenshot("agents-update-error.png")
  await evaluate(
    "document.querySelector('[role=list]').parentElement.style.width='480px'"
  )
  await screenshot("agents-narrow.png")
  assert.equal(
    await evaluate(
      "(() => {const t=document.querySelector('[role=list]');return t.scrollWidth <= t.clientWidth+1})()"
    ),
    true
  )
  await evaluate(`document.querySelector('[role="listitem"][aria-label="Grok"]').scrollIntoView({block:'center'})`)
  await click("Sign in")
  await until("document.body.textContent.includes('Complete sign-in in your browser')")
  await until("document.body.textContent.includes('using Grok’s CLI login')")
  assert.equal(await evaluate(`document.querySelector('#provider-grok-accounts').textContent.includes('Paste API key')`), false)
  assert.equal(await evaluate(`document.querySelector('#provider-grok-accounts').textContent.includes('system key store is unavailable')`), false)
  assert.deepEqual(await fixture("return f.calls"), ["sign-in-key", "opencode", "sign-in-browser"])
  await screenshot("agents-grok-connected.png")
  assert.deepEqual(errors, [])
  clearTimeout(watchdog)
  window.destroy()
  app.exit(0)
}
