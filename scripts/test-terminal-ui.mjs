import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    ;(await import("electron")).app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-terminal-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    server: { port: 0, host: "127.0.0.1" },
  })
  await server.listen()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "terminal-check",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_TERMINAL_UI_ROOT: root,
    MAKO_TERMINAL_UI_URL: server.resolvedUrls.local[0],
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], {
      env,
      stdio: "inherit",
    })
    process.exitCode = await new Promise((done, reject) => {
      child.once("exit", (code) => done(code ?? 1))
      child.once("error", reject)
    })
  } finally {
    await server.close()
  }
  console.log(`Terminal UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_TERMINAL_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1000,
    height: 420,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  const page = window.webContents
  const errors = []
  page.on("console-message", (details) => {
    if (details.level === "error") {
      errors.push(details.message)
      console.error(details.message)
    }
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const call = (code) =>
    evaluate(
      `import('/src/dev/terminal-check.tsx').then(async f => { ${code} })`
    )
  const until = async (code) => {
    const deadline = Date.now() + 15000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const capture = async (name) =>
    writeFile(join(root, name), (await page.capturePage()).toPNG())
  const watchdog = setTimeout(() => app.exit(1), 60000)
  try {
    await window.loadURL(
      `${process.env.MAKO_TERMINAL_UI_URL}scripts/terminal-browser.html`
    )
    console.log("Terminal fixture loaded")
    await until(
      "document.querySelector('.xterm-rows')?.textContent.includes('Connected to workspace')"
    )
    await evaluate("document.fonts.ready.then(() => true)")
    await capture("dark.png")
    const beforeResize = await call("return f.metrics.resizes")
    await evaluate(
      "document.querySelector('.terminal-viewport').style.paddingRight = '13px'"
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(
      await call("return f.metrics.resizes"),
      beforeResize,
      "Sub-cell resize must not send PTY resize"
    )
    const beforeBurst = await call("return f.metrics.acknowledgements")
    await call(
      "await Promise.all(Array.from({length:100}, (_, i) => new Promise(resolve => setTimeout(() => { f.output('burst-' + i + '\\r\\n'); resolve() }, i))))"
    )
    await until(
      "document.querySelector('.xterm-rows')?.textContent.includes('burst-99')"
    )
    const burstAcks =
      (await call("return f.metrics.acknowledgements")) - beforeBurst
    assert.ok(
      burstAcks < 50,
      `100 chunks should batch, got ${burstAcks} acknowledgements`
    )
    await call("f.recreateRenderer()")
    await until(
      "document.querySelector('.xterm-rows')?.textContent.includes('renderer recovery')"
    )
    await call('f.output("\\r\\nRECOVERED_INPUT")')
    await until(
      "document.querySelector('.xterm-rows')?.textContent.includes('RECOVERED_INPUT')"
    )
    await call("f.reconnect()")
    await until(
      "document.querySelector('.xterm-rows')?.textContent.includes('RECOVERED_INPUT')"
    )
    await evaluate(
      "document.querySelector('[aria-label=\"Search terminal\"]').click()"
    )
    await until(
      "document.activeElement?.getAttribute('aria-label') === 'Find in terminal'"
    )
    await page.debugger.attach("1.3")
    await page.debugger.sendCommand("Input.insertText", { text: "workspace" })
    await capture("search.png")
    await evaluate(
      "document.querySelector('[aria-label=\"Close terminal search\"]').click()"
    )
    await evaluate("document.documentElement.classList.add('light')")
    await new Promise((resolve) => setTimeout(resolve, 80))
    const theme = await call("return f.latestTerminal().options.theme")
    assert.notEqual(theme.blue, theme.cyan)
    await capture("light.png")
    window.setSize(420, 340)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      await evaluate("document.documentElement.scrollWidth > innerWidth"),
      false
    )
    await capture("narrow.png")
    // Exercise production split layout, input targeting and replay with real xterm.
    window.setSize(1000, 520)
    await call('await f.split("horizontal")')
    await until(
      `document.querySelectorAll('[data-terminal-active="true"]').length === 2`
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const splitIds = await call(
      "return f.state().groups.find(g => g.sessionIds.includes(f.state().activeId)).sessionIds"
    )
    await call(
      `f.output("\\r\\nLEFT_ONLY", ${JSON.stringify(splitIds[0])}); f.output("\\r\\nRIGHT_ONLY", ${JSON.stringify(splitIds[1])})`
    )
    await call(`f.terminalFor(${JSON.stringify(splitIds[0])}).scrollToBottom()`)
    await until(
      `document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows')?.textContent.includes('LEFT_ONLY')`
    )
    await until(
      `document.querySelector('[data-terminal-session="${splitIds[1]}"] .xterm-rows')?.textContent.includes('RIGHT_ONLY')`
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows').textContent.includes('RIGHT_ONLY')`
      ),
      false
    )
    const beforeFocusAttach = await call("return f.metrics.attachments")
    await evaluate(
      `document.querySelector('[data-terminal-session="${splitIds[0]}"] textarea').focus()`
    )
    await page.debugger.sendCommand("Input.insertText", { text: "LEFT_INPUT" })
    await until(
      `document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows')?.textContent.includes('LEFT_INPUT')`
    )
    assert.equal(await call("return f.inputs.at(-1).id"), splitIds[0])
    assert.equal(await call("return f.metrics.attachments"), beforeFocusAttach)
    const beforeReplayWrites = await call("return f.metrics.writes")
    await call("f.replayQueries()")
    await until(
      `document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows')?.textContent.includes('REPLAY_SAFE')`
    )
    assert.equal(
      await call("return f.metrics.writes"),
      beforeReplayWrites,
      "History replay must not send device responses into the live shell"
    )
    await call('f.output("\\x1b[6n")')
    await until(
      `document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows') !== null`
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok(
      (await call("return f.metrics.writes")) > beforeReplayWrites,
      "Live terminal queries still receive replies"
    )
    await call('f.output("\\x1b[?1049h\\x1b[2J\\x1b[HALTERNATE_SCREEN")')
    await until(`document.querySelector('[data-terminal-session="${splitIds[0]}"] .xterm-rows')?.textContent.includes('ALTERNATE_SCREEN')`)
    await call('f.reconnect()')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await call(`return f.terminalFor(${JSON.stringify(splitIds[0])}).buffer.active.type`), 'alternate')
    await call('f.output("\\x1b[?1049l\\r\\nNORMAL_SCREEN")')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(await call(`return f.terminalFor(${JSON.stringify(splitIds[0])}).buffer.active.type`), 'normal')
    const beforeFont = await call(
      "return f.terminalFor(f.state().activeId).cols"
    )
    await call("f.font(16)")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      await call("return f.terminalFor(f.state().activeId).options.fontSize"),
      16
    )
    assert.ok(
      (await call("return f.terminalFor(f.state().activeId).cols")) < beforeFont
    )
    await call("f.font(12)")
    const divider = await evaluate(
      `(() => { const r = document.querySelector('[aria-label="Resize terminal panes"]').getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2} })()`
    )
    const beforeDrag = await call(
      `return f.terminalFor(${JSON.stringify(splitIds[0])}).cols`
    )
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...divider,
      button: "left",
      clickCount: 1,
    })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: divider.x + 90,
      y: divider.y,
      button: "left",
      buttons: 1,
    })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: divider.x + 90,
      y: divider.y,
      button: "left",
      clickCount: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(
      (await call(
        `return f.terminalFor(${JSON.stringify(splitIds[0])}).cols`
      )) > beforeDrag,
      "Dragging the split divider resizes the PTY grid"
    )
    await capture("split-horizontal.png")
    await evaluate("document.documentElement.classList.remove('light')")
    await new Promise((resolve) => setTimeout(resolve, 80))
    await capture("split-dark.png")
    await evaluate("document.documentElement.classList.add('light')")
    await call("f.reconnect()")
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (const id of splitIds)
      assert.ok(
        await call(`return !!f.state().snapshots[${JSON.stringify(id)}]`)
      )
    await evaluate(
      `document.querySelector('[aria-label^="Close Tests"]').click()`
    )
    await until(`document.querySelector('[role="dialog"]') !== null`)
    await evaluate(
      `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === 'Cancel').click()`
    )
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-terminal-active="true"]').length`
      ),
      2
    )
    await call('await f.split("vertical")')
    await until(
      `document.querySelectorAll('[data-terminal-active="true"]').length === 3`
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await capture("split-vertical.png")
    await call('f.activate("terminal-2")')
    const initialRenders = await call("return f.rendererCount()")
    await call('f.activate("terminal-0")')
    await until(
      "document.querySelector('[data-terminal-session=\"terminal-0\"][data-terminal-active=\"true\"] .xterm-rows')?.textContent.includes('Connected to workspace')"
    )
    const afterFirstSwitch = await call("return f.rendererCount()")
    assert.ok(afterFirstSwitch > initialRenders)
    await call('f.activate("terminal-2")')
    await until(
      'document.querySelector(\'[data-terminal-session="terminal-2"][data-terminal-active="true"]\') !== null'
    )
    assert.ok((await call("return f.rendererCount()")) >= afterFirstSwitch)
    for (let i = 0; i < 4; i++) {
      await call("await f.create()")
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.equal(
      await evaluate(
        "document.querySelectorAll('[data-terminal-session]').length"
      ),
      3,
      "Renderer cache stays bounded"
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        burstChunks: 100,
        acknowledgements: burstAcks,
        rendererRecovery: "passed",
        reconnect: "passed",
        search: "passed",
        narrow: "passed",
        splitInputAndResize: "passed",
        replayIsolation: "passed",
        alternateScreenRecovery: "passed",
        fontPreferences: "passed",
        closeCancellation: "passed",
        errors,
      })
    )
  } catch (error) {
    await capture("failure.png")
    throw error
  } finally {
    clearTimeout(watchdog)
    window.destroy()
  }
  app.exit(0)
}
