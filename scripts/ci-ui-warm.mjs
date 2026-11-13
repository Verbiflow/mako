import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * A UI shard's first Electron start and first page load, made once before its suites and timed: on a fresh Mac runner
 * the first start of the downloaded Electron is checked by the system, and whichever suite came first paid for it
 * (about 90 s, run 43362332623). It opens the desk the shard serves (`MAKO_UI_VITE_URL`, `?mock`), waits until it draws
 * words, and prints how long Electron took to start and the page to draw, to the job's summary too.
 *
 *   MAKO_UI_VITE_URL=http://127.0.0.1:4173/ node scripts/ci-ui-warm.mjs
 */
const base = process.env.MAKO_UI_VITE_URL
if (!base) throw new Error("MAKO_UI_VITE_URL names the served renderer")
const LIMIT_MS = 5 * 60_000

const app = await mkdtemp(join(tmpdir(), "mako-ui-warm-"))
await writeFile(join(app, "package.json"), JSON.stringify({ name: "mako-ui-warm", main: "main.cjs" }))
await writeFile(join(app, "main.cjs"), `
const { app, BrowserWindow } = require("electron")
const began = Date.now()
app.whenReady().then(async () => {
  const ready = Date.now() - began
  const win = new BrowserWindow({ show: false, width: 1352, height: 847 })
  const loading = Date.now()
  await win.loadURL(process.env.MAKO_UI_VITE_URL + "?mock&app=apex")
  let words = ""
  while (words.length < 40 && Date.now() - loading < 120000) {
    await new Promise((next) => setTimeout(next, 100))
    words = await win.webContents.executeJavaScript("document.body?.innerText ?? ''").catch(() => "")
  }
  console.log(JSON.stringify({ readyMs: ready, drawnMs: Date.now() - loading, drew: words.length >= 40 }))
  app.exit(words.length >= 40 ? 0 : 1)
})
`)

const started = Date.now()
const child = spawn(resolve("node_modules/.bin/electron"), [app], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } })
let out = ""
child.stdout.on("data", (chunk) => (out += chunk))
const limit = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS)
const code = await new Promise((done) => child.once("exit", done))
clearTimeout(limit)
await rm(app, { recursive: true, force: true })
const line = `UI warm-up: Electron launched and drew the desk in ${Math.round((Date.now() - started) / 1000)} s (${out.trim().split("\n").at(-1) ?? "no reading"})`
console.log(line)
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises")
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}
process.exit(code === 0 ? 0 : 1)
