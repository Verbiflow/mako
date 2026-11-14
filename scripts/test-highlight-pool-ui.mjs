import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The highlight pool's workers end once no view holds them (`src/lib/highlight-pool.tsx`), through the real pool and
 * React (`src/dev/highlight-pool-check.tsx`): a render that read the pool and never committed leaves an idle wait that
 * ends its workers; a committed view holds them through every wait; the last view leaving starts the wait again.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-highlight-pool-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-highlight-pool", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_POOL_ROOT: root, MAKO_POOL_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_POOL_ROOT, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the wait below holds.
  await window.loadURL(new URL("scripts/highlight-pool.html", process.env.MAKO_POOL_URL).href).catch((error) => {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
  })
  const deadline = Date.now() + 120_000
  while (!(await window.webContents.executeJavaScript("Boolean(window.poolCheck)"))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the pool check")
    await new Promise((done) => setTimeout(done, 50))
  }
  const result = await window.webContents.executeJavaScript("window.poolCheck")
  console.log(`POOL ${JSON.stringify(result)}`)
  assert.equal(result.error, undefined, "the check ran")
  assert.ok(result.afterAbandoned.workers > 0, "a render that never committed made the pool's workers")
  assert.equal(result.afterAbandoned.pending, 1, "and left an idle wait for them")
  assert.equal(result.abandonedExpired.workers, 0, "which ends them")
  assert.ok(result.whileHeld.workers > 0, "a committed view keeps the pool's workers through every wait")
  assert.equal(result.whileHeld.pending, 0, "and none is pending while it holds them")
  assert.equal(result.afterLeaving.pending, 1, "the last view leaving starts the wait")
  assert.equal(result.leftExpired.workers, 0, "which ends the workers")
  console.log("Highlight pool: an abandoned render's workers end, a held view keeps its own, and the last view's leaving ends them")
  app.exit(0)
}
