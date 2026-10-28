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
  const root = await mkdtemp(join(tmpdir(), "mako-application-ui-"))
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
      name: "mako-application-ui",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_APPLICATION_TEST_ROOT: root,
    MAKO_APPLICATION_TEST_URL: server.resolvedUrls.local[0],
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
  console.log(`Application UI evidence: ${root}`)
}

async function review() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_APPLICATION_TEST_ROOT
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
    evaluate(`import('/src/dev/application-check.tsx').then(f => { ${code} })`)
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
    // A closing modal remains over the page during its exit animation. Text
    // being present underneath it does not make that button clickable yet.
    await until(`(() => {
      const button = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width && b.textContent.trim() === ${JSON.stringify(text)}).at(-1);
      if (!button || button.disabled) return false;
      const r = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })()`)
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
  const clickSelector = async (selector) => {
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2} })()`)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
  }
  const quits = (count) => until(`import('/src/dev/application-check.tsx').then(f => f.calls.quit === ${count})`)
  const key = async (key, code, modifiers = 0) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    })
  }
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  await window.loadURL(
    `${process.env.MAKO_APPLICATION_TEST_URL}scripts/application-review.html`
  )
  await until("document.body.textContent.includes('7ae32bc6849e318f')")
  await screenshot("updates-dark.png")
  await click("Build update")
  await until("document.body.textContent.includes('Preparing your next build')")
  assert.equal(await fixture("return f.calls.build"), 1)
  await screenshot("building.png")
  await fixture("f.fail('The build failed verification. Your installed app was not changed.')")
  await until("document.querySelector('[role=alert]')?.textContent.includes('failed verification')")
  await screenshot("build-error.png")
  await click("Build update")
  assert.equal(await fixture("return f.calls.build"), 2)
  await fixture("f.ready()")
  await click("Install when agents finish")
  await until(
    "document.querySelector('.application-dialog')?.textContent.includes('Install your update?')"
  )
  await until(
    "document.activeElement.textContent.trim() === 'Install when agents finish'"
  )
  await screenshot("install-choice-dark.png")
  await click("Not now")
  await until("!document.querySelector('.application-dialog')")
  assert.equal(await fixture("return f.calls.stopped + f.calls.waited"), 0)
  await click("Install when agents finish")
  await until(
    "document.querySelector('.application-dialog')?.textContent.includes('Install your update?')"
  )
  await click("Install when agents finish")
  await until("document.body.textContent.includes('Cancel update')")
  assert.equal(await fixture("return f.calls.waited"), 1)
  assert.equal(await fixture("return f.calls.stopped"), 0)
  await until("!document.querySelector('.application-dialog')")
  await key("Escape", 27)
  await until("!document.querySelector('[role=dialog]')")
  await click("Cancel update")
  await until("!document.body.textContent.includes('Cancel update')")
  await key("q", 81, 4)
  await until(
    "document.querySelector('.application-dialog')?.textContent.includes('Quit Mako?')"
  )
  assert.equal(
    await evaluate("document.activeElement.textContent.trim()"),
    "Quit and keep agents running"
  )
  await fixture("f.theme('light')")
  await screenshot("quit-choice-light.png")
  await key("Escape", 27)
  assert.equal(await fixture("return f.calls.quit"), 0)
  await key("q", 81, 4)
  await until(
    "document.querySelector('.application-dialog')?.textContent.includes('Quit Mako?')"
  )
  await click("Quit and keep agents running")
  assert.equal(await fixture("return f.calls.quit"), 1)
  assert.equal(await fixture("return f.calls.stopped"), 0)
  await until("!document.querySelector('.application-dialog')")

  // Handing agents to the cloud at quit: each Thread at work that can go wears the cloud; Hand off pauses each turn,
  // moves its Thread, shows each step, and quits once every one is in the cloud.
  await fixture("f.handOffScene('all')")
  await key("q", 81, 4)
  await until("Boolean(document.querySelector('[data-handoff-action]'))")
  await until("document.querySelectorAll('.application-dialog li[data-handoff=can]').length === 3")
  await screenshot("quit-handoff-light.png")
  await fixture("f.theme('dark')")
  await screenshot("quit-handoff-dark.png")
  await click("Hand off to the cloud and quit")
  await until("document.querySelector('.application-dialog')?.textContent.includes('Pausing its turn')")
  await screenshot("handing-off-dark.png")
  await quits(2)
  assert.equal(await fixture("return f.calls.handedOff"), 1)
  await until("!document.querySelector('.application-dialog')")
  // Remembered: Keep running, chosen with the toggle, quits without asking next time.
  await fixture("f.handOffScene('all')")
  await key("q", 81, 4)
  await until("Boolean(document.querySelector('[data-handoff-action]'))")
  await clickSelector('[role=switch][aria-label="Do this every time I quit while agents work"]')
  await click("Quit and keep agents running")
  await quits(3)
  await until("!document.querySelector('.application-dialog')")
  await fixture("f.handOffScene('all')")
  await key("q", 81, 4)
  await quits(4)
  assert.equal(await evaluate("Boolean(document.querySelector('.application-dialog'))"), false, "remembered: no sheet")
  await evaluate("import('/src/state/prefs.ts').then(({ setPref }) => setPref('quitWithAgents', 'ask'))")
  // Mixed: one can't go and says why, one stays (the cloud is full); the sheet stays, naming each, with what's left.
  await fixture("f.handOffScene('mixed')")
  await key("q", 81, 4)
  await until("document.querySelector('.application-dialog')?.textContent.includes('Stays here:')")
  await screenshot("quit-handoff-mixed-dark.png")
  await click("Hand off to the cloud and quit")
  await until("document.querySelector('.application-dialog')?.textContent.includes('Quit and keep it running here')")
  await screenshot("handoff-stayed-dark.png")
  assert.equal(await fixture("return f.calls.quit"), 4, "with something still at work here, it doesn't quit on its own")
  await key("Escape", 27)
  await until("!document.querySelector('.application-dialog')")
  await fixture("f.theme('light')")
  await fixture("f.handOffScene('none')")
  await key("k", 75, 4)
  await until(
    "document.activeElement?.getAttribute('placeholder') === 'Search commands, models, sessions…'"
  )
  await page.debugger.sendCommand("Input.insertText", {
    text: "Updates and build information",
  })
  await until(
    "document.querySelector('[aria-label=\"Command palette\"] button')?.textContent.includes('Updates and build information')"
  )
  await key("Enter", 13)
  await until(
    "document.querySelector('[data-testid=updates-section]') !== null"
  )
  await screenshot("updates-light.png")
  // What a local update takes from its checkout, said before Build runs; opening Updates asked for it.
  assert.ok((await fixture("return f.calls.sourceChecks")) > 0, "opening Updates reads the source checkout")
  const sourceScenes = {
    behind: "21 new changes on origin/main",
    current: "You're already on 079f9b31",
    changes: "so Mako won't move it",
    branch: "The checkout is on approval-bar",
    offline: "Couldn't reach origin",
    building: "Building 079f9b31",
    ready: "Moved main forward from",
    installed: "21 changes in this build",
  }
  for (const theme of ["light", "dark"]) {
    await fixture(`f.theme('${theme}')`)
    for (const [scene, text] of Object.entries(sourceScenes)) {
      await fixture(`f.sourceScene('${scene}')`)
      await until(`document.querySelector('[data-testid=updates-section]')?.textContent.includes(${JSON.stringify(text)})`)
      await screenshot(`updater-${scene}-${theme}.png`)
    }
  }
  const built = await fixture("return f.calls.build")
  await fixture("f.sourceScene('behind')")
  await click("Update to main 079f9b31 (21 new changes)")
  await until(`import('/src/dev/application-check.tsx').then(f => f.calls.build === ${built + 1})`)
  await fixture("f.sourceScene('current')")
  assert.equal(
    await evaluate("[...document.querySelectorAll('[data-testid=updates-section] button')].some(b => /^(Build|Update)/.test(b.textContent.trim()))"),
    false,
    "the installed revision offers no build"
  )
  await fixture("f.theme('light')")
  await fixture("f.published()")
  await click("Check for updates")
  await until('document.body.textContent.includes("You\'re up to date.")')
  assert.equal(await fixture("return f.calls.checked"), 1)
  await key("Escape", 27)
  await fixture("f.idle()")
  await key("q", 81, 4)
  await until(
    "import('/src/dev/application-check.tsx').then(f => f.calls.quit === 5)"
  )
  assert.equal(
    await evaluate("Boolean(document.querySelector('.application-dialog'))"),
    false
  )
  await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  })
  await evaluate(
    "import('/src/state/application.ts').then(({applicationStore}) => applicationStore.set({dialog: 'quit'}))"
  )
  await until("Boolean(document.querySelector('.application-dialog'))")
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.application-dialog')).animationName"
    ),
    "none"
  )
  assert.deepEqual(errors, [])
  clearTimeout(watchdog)
  console.log(
    "Updates and quit UI: local build, published check, safe focus, cancellation, deferred install, keyboard Quit, command palette, idle Quit, light/dark and reduced motion passed"
  )
  app.exit(0)
}
