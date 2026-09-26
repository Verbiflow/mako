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
  const { app, BrowserWindow, ipcMain } = await import("electron")
  const { TerminalClients } =
    await import("../dist-electron/terminal-clients.js")
  const root = process.env.MAKO_TERMINAL_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const preload = join(root, "preload.cjs")
  await writeFile(
    preload,
    `const {contextBridge, ipcRenderer} = require("electron");
    contextBridge.exposeInMainWorld("terminalFixture", {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      onTerminalEvent: listener => { const handler = (_, value) => listener(value); ipcRenderer.on("terminal:event", handler); return () => ipcRenderer.removeListener("terminal:event", handler) }
    });`
  )
  const window = new BrowserWindow({
    width: 1000,
    height: 460,
    show: false,
    webPreferences: { preload, backgroundThrottling: false },
  })
  const page = window.webContents
  const errors = []
  page.on("console-message", ({ level, message }) => {
    if (level === "error") errors.push(message)
  })
  const clients = new TerminalClients(
    resolve("dist-electron/terminal-daemon.js"),
    join(root, "terminal"),
    (event) => {
      if (!page.isDestroyed()) page.send("terminal:event", event)
    }
  )
  const owner = String(page.id)
  let daemonPid
  const methods = {
    list: "list",
    create: "create",
    attach: "attach",
    detach: "detach",
    acknowledge: "acknowledge",
    write: "write",
    resize: "resize",
    kill: "kill",
  }
  for (const [channel, method] of Object.entries(methods))
    ipcMain.handle(`mako:terminal-${channel}`, async (_event, ...args) => {
      const client = clients.forOwner(owner)
      const result = await client[method](...args)
      daemonPid = client.daemonPid()
      return result
    })
  const call = (code) =>
    page.executeJavaScript(
      `import('/src/dev/terminal-live-check.tsx').then(async f => { ${code} })`
    )
  const until = async (code) => {
    const deadline = Date.now() + 15000
    while (!(await call(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  // The daemon is detached and outlives this app unless it is stopped explicitly.
  const stopDaemon = () => { try { if (daemonPid) process.kill(daemonPid, "SIGTERM") } catch {} }
  const watchdog = setTimeout(() => { stopDaemon(); app.exit(1) }, 60000)
  try {
    await window.loadURL(
      `${process.env.MAKO_TERMINAL_UI_URL}scripts/terminal-live-browser.html?cwd=${encodeURIComponent(root)}`
    )
    await until(
      "return f.state().sessions.length === 1 && !!f.state().snapshots[f.state().activeId]"
    )
    const first = await call("return f.state().activeId")
    await call("await f.split()")
    await until(
      "return f.state().sessions.length === 2 && !!f.state().snapshots[f.state().activeId]"
    )
    const second = await call("return f.state().activeId")
    await call(
      `f.input(${JSON.stringify(first)}, ${JSON.stringify("echo FIRST_''LIVE\n")})`
    )
    await until(
      `return f.text(${JSON.stringify(first)}).includes('FIRST_LIVE')`
    )
    await page.debugger.attach("1.3")
    await page.executeJavaScript(
      `document.querySelector('[data-terminal-session="${second}"] textarea').focus()`
    )
    await page.debugger.sendCommand("Input.insertText", {
      text: "echo SECOND_''LIVE",
    })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    })
    await until(
      `return f.text(${JSON.stringify(second)}).includes('SECOND_LIVE')`
    )
    assert.equal(
      await call(
        `return f.text(${JSON.stringify(first)}).includes('SECOND_LIVE')`
      ),
      false
    )
    for (let cycle = 0; cycle < 4; cycle++) {
      await call("f.rememberSnapshots()")
      clients.release(owner)
      await call("await f.recover()")
      await until("return f.recoveredSnapshots()")
      await call("f.rememberSnapshots(); f.wake()")
      await until("return f.recoveredSnapshots()")
      await until(
        `return f.text(${JSON.stringify(first)}).includes('FIRST_LIVE') && f.text(${JSON.stringify(second)}).includes('SECOND_LIVE')`
      )
    }
    await writeFile(
      join(root, "live-splits.png"),
      (await page.capturePage()).toPNG()
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        realShells: 2,
        trustedKeyboardInput: "passed",
        socketRecoveryCycles: 4,
        wakeRecovery: "passed",
        errors,
      })
    )
  } catch (error) {
    await writeFile(
      join(root, "failure.png"),
      (await page.capturePage()).toPNG()
    )
    throw error
  } finally {
    clearTimeout(watchdog)
    const client = clients.forOwner(owner)
    for (const session of await client.list().catch(() => []))
      await client.kill(session.id)
    daemonPid = client.daemonPid() ?? daemonPid
    clients.dispose()
    stopDaemon()
    // Destroying the last window quits the app, so it goes after cleanup.
    window.destroy()
  }
  app.exit(0)
}
