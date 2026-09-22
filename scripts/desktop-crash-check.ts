import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { app, BrowserWindow, crashReporter } from "electron"
import { listCrashes } from "../electron/crash.js"
import { flushHostLog } from "../electron/host-log.js"
import { watchRendererHealth } from "../electron/renderer-health.js"
import { z } from "zod"
import "../electron/client-main.js"

async function until(test: () => boolean | Promise<boolean>, message: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await test())) {
    assert.ok(Date.now() < deadline, message)
    await delay(20)
  }
}

async function check() {
  const root = app.getAppPath()
  const dataRoot = join(root, "profile")
  const control = async (path: string) => {
    const response = await fetch(`${process.env.VITE_DEV_SERVER_URL}${path}`, { method: "POST" })
    assert.equal(response.status, 200)
  }
  const status = async () => z.object({ clients: z.array(z.string()), forwarded: z.array(z.string()) }).parse(
    await (await fetch(`${process.env.VITE_DEV_SERVER_URL}/status`)).json()
  )
  try {
    await until(() => BrowserWindow.getAllWindows().some((window) => window.getTitle() === "Ready"), "desktop should load", 30_000)
    const window = BrowserWindow.getAllWindows()[0]!
    assert.equal(window.isVisible(), false)
    assert.equal(crashReporter.getUploadToServer(), false)
    assert.equal(app.getPath("crashDumps"), join(`${dataRoot}-ui-crash-test`, "Crashpad"))
    await until(async () => (await status()).clients.length === 1, "client should attach once")
    const clientIds = (await status()).clients
    await control("/complete")
    await until(async () => (await window.webContents.executeJavaScript("window.finished")) === 20, "completion events should keep reaching the window")
    await window.webContents.executeJavaScript(`localStorage.setItem('draft', 'unsent fixture draft')`)
    const beforePid = window.webContents.getOSProcessId()
    window.webContents.forcefullyCrashRenderer()
    await until(() => listCrashes().some((report) => report.kind === "renderer-gone"), "real renderer termination must leave a report")
    await until(() => window.webContents.getOSProcessId() > 0 && window.webContents.getOSProcessId() !== beforePid && !window.webContents.isCrashed() && window.getTitle() === "Ready" && !window.webContents.isLoading(), "the desktop must recover its renderer")
    assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('draft')"), "unsent fixture draft")
    assert.deepEqual((await status()).clients, clientIds, "renderer recovery must retain the host attachment")
    await control("/complete")
    await until(async () => (await window.webContents.executeJavaScript("window.finished")) === 20, "host events must work after recovery")

    // A host outage must not swallow renderer reports, or prevent reading them.
    await control("/offline")
    await window.webContents.executeJavaScript(`window.mako.reportCrash('renderer-error', {message:'fixture while host unavailable', source:'fixture'})`)
    const reports = z.array(z.object({ message: z.string() })).parse(await window.webContents.executeJavaScript("window.mako.crashes()"))
    assert.ok(reports.some((report) => report.message === "fixture while host unavailable"))
    const { forwarded } = await status()
    assert.ok(!forwarded.includes("mako:report-crash") && !forwarded.includes("mako:crashes"))
    // Restore the fixture before the normal client's reconnect timer can launch a host.
    await control("/online")
    try {
      setTimeout(() => { throw new Error("fixture uncaught main error") }, 0)
      void Promise.reject(new Error("fixture unhandled main rejection"))
      await until(() => listCrashes().some((report) => report.message === "fixture uncaught main error") && listCrashes().some((report) => report.message === "fixture unhandled main rejection"), "main failures must be recorded")

      // Exercise the same watcher with a controlled native dialog decision.
      const repeated = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      let decisions = 0
      watchRendererHealth(repeated, { closing: () => false, retry: async () => { decisions++; return false } })
      await repeated.loadURL("data:text/html,<title>Repeated</title>")
      const firstDeath = once(repeated.webContents, "render-process-gone")
      repeated.webContents.forcefullyCrashRenderer()
      await firstDeath
      await until(() => !repeated.webContents.isCrashed() && !repeated.webContents.isLoading(), "first crash should recover")
      repeated.webContents.forcefullyCrashRenderer()
      await until(() => decisions === 1, "second crash should request a deliberate retry")
      await delay(650)
      assert.equal(repeated.webContents.isCrashed(), true, "a declined retry must stop the reload loop")
      repeated.destroy()

      const closing = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      watchRendererHealth(closing, { closing: () => true })
      await closing.loadURL("data:text/html,<title>Closing</title>")
      closing.webContents.forcefullyCrashRenderer()
      await delay(650)
      assert.equal(closing.webContents.isCrashed(), true, "shutdown must not resurrect a renderer")
      closing.destroy()

      const brokenLoad = new BrowserWindow({ show: false, webPreferences: { sandbox: true, preload: join(root, "missing-preload.cjs") } })
      watchRendererHealth(brokenLoad, { closing: () => false })
      await brokenLoad.loadURL("data:text/html,<title>Missing preload</title>")
      await until(() => listCrashes().some((report) => report.source?.endsWith("preload") === true), "preload failure must be recorded")
      await assert.rejects(brokenLoad.loadFile(join(root, "missing.html")))
      await until(() => listCrashes().some((report) => report.message.startsWith("Page load failed:")), "failed main-frame navigation must be recorded")
      brokenLoad.destroy()
      await flushHostLog()
      const log = await readFile(join(`${dataRoot}-ui-crash-test`, "logs", "desktop.log"), "utf8")
      assert.match(log, /desktop starting/)
      assert.match(log, /renderer exited: .*exit/)
      assert.match(log, /reloading after crash/)
      await until(async () => (await readdir(join(app.getPath("crashDumps"), "pending"))).some((name) => name.endsWith(".dmp")), "native crashes must leave a local minidump")
      console.log("Desktop crash checks passed: actual client, 20 completion transitions, real renderer death/reload, persisted draft, unchanged host attachment, post-recovery events, offline diagnostics, main errors, bounded retry and shutdown.")
    } finally { await flushHostLog() }
  } finally {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
  }
}

void check().then(() => app.exit(0)).catch((error) => {
  console.error(error)
  app.exit(1)
})
