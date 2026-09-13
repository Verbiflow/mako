import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-preload-test-"))
  const file = fileURLToPath(import.meta.url)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "mako-preload-test", main: file })
  )
  const child = spawn(resolve("node_modules/.bin/electron"), [root], {
    stdio: "inherit",
    env: { ...process.env, MAKO_PRELOAD_TEST_ROOT: root },
  })
  const code = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1))
  )
  await rm(root, { recursive: true, force: true })
  process.exitCode = code
} else {
  void runElectron()
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = await import("electron")
  app.setPath("userData", process.env.MAKO_PRELOAD_TEST_ROOT)
  await app.whenReady()
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(repo, "dist-electron/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  const errors = []
  window.webContents.on("preload-error", (_event, _path, error) =>
    errors.push(error.message)
  )
  ipcMain.handle("mako:thread-page", (_event, ...args) => ({
    path: args[0],
    before: args[1],
    limit: args[2],
  }))
  try {
    await window.loadURL("data:text/html,<title>Mako preload check</title>")
    assert.deepEqual(errors, [])
    const value = await window.webContents.executeJavaScript(
      "window.mako.pageThread('/exact-thread', undefined, 12)"
    )
    assert.deepEqual(value, {
      path: "/exact-thread",
      before: undefined,
      limit: 12,
    })
    await window.webContents.executeJavaScript(
      "window.mako.onEvent(event => document.title = event.message); void 0"
    )
    window.webContents.send("mako:event", {
      type: "notice",
      level: "info",
      message: "Host event received",
    })
    const deadline = Date.now() + 3000
    while (
      (await window.webContents.executeJavaScript("document.title")) !==
        "Host event received" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      await window.webContents.executeJavaScript("document.title"),
      "Host event received"
    )
    console.log(
      "Electron preload: the bundled bridge loads in a sandboxed renderer, optional arguments survive IPC, and host events reach the isolated renderer"
    )
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
