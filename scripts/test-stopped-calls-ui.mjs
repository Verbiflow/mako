import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Calls Mako closed, through production components on the transcript fixture
 * page's "Stopped calls" tab, in Electron: each keeps what it had produced
 * and says how it ended under it, a stopped call reads "stopped" and a lost
 * one "cut off", and neither claims it finished with nothing to say. Every
 * row is opened and the page captured dark then light, into the printed
 * directory or the one given as the first argument. `MAKO_THREAD_URL` points
 * it at a Vite server already running; otherwise it starts one on
 * `MAKO_THREAD_PORT` + 4.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void capture().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-stopped-calls-"))
  const target = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
  const evidence = target ? resolve(target) : root
  await mkdir(evidence, { recursive: true })
  const external = process.env.MAKO_THREAD_URL
  const server = external ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: Number(process.env.MAKO_THREAD_PORT ?? 20020) + 4, strictPort: true, hmr: false, watch: null },
  })
  if (server) await server.listen()
  const url = external ?? server.resolvedUrls.local[0]
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-stopped-calls-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_STOPPED_ROOT: root, MAKO_STOPPED_EVIDENCE: evidence, MAKO_STOPPED_PAGE: url }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Stopped calls evidence: ${evidence}`)
}

async function capture() {
  const { app, BrowserWindow } = await import("electron")
  const evidence = process.env.MAKO_STOPPED_EVIDENCE
  app.setPath("userData", join(process.env.MAKO_STOPPED_ROOT, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  const window = new BrowserWindow({ width: 860, height: 1600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const until = async (code, label) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText.slice(0, 2000)")}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const base = new URL("/scripts/transcript-browser.html", process.env.MAKO_STOPPED_PAGE)
  base.searchParams.set("mode", "Stopped calls")
  await page.loadURL(base.href)
  await until("document.querySelectorAll('main button[aria-expanded]').length >= 2", "the turns' work")
  await evaluate("document.fonts.ready.then(() => true)")
  await evaluate("document.querySelector('header').style.display = 'none'; true")
  // Open every group and row, until nothing is left closed.
  for (let round = 0; round < 6; round++) {
    const opened = await evaluate("(() => { const closed = [...document.querySelectorAll('main button[aria-expanded=false]')]; closed.forEach(button => button.click()); return closed.length })()")
    await frames()
    if (!opened) break
  }
  await until("document.querySelectorAll('[data-transcript-tool]').length >= 6", "the calls")
  const groups = await evaluate("[...document.querySelectorAll('main button[aria-expanded]')].filter(button => !button.closest('[data-transcript-tool]')).map(button => button.textContent)")
  assert.ok(groups.some((text) => /3 stopped/.test(text) && !/cut off/.test(text)), `the stopped turn's work reads stopped: ${groups.join(" | ")}`)
  assert.ok(groups.some((text) => /1 cut off/.test(text) && !/stopped/.test(text)), `the cut-off turn's work reads cut off: ${groups.join(" | ")}`)

  const rows = await evaluate(`[...document.querySelectorAll('[data-transcript-tool]')].map(row => ({
    id: row.dataset.transcriptTool,
    head: row.querySelector('button').textContent,
    body: row.querySelector('[data-tool-body]')?.textContent ?? "",
  }))`)
  const row = (id) => {
    const found = rows.find((candidate) => candidate.id.split(":").at(-1) === id)
    assert.ok(found, `the ${id} row is drawn: ${JSON.stringify(rows.map((candidate) => [candidate.id, candidate.head]))}`)
    return found
  }
  assert.match(row("suite").body, /RUNS src\/sync\/merge\.test\.ts/, "a stopped command keeps the output it had")
  assert.match(row("suite").body, /Stopped before it finished\./)
  assert.match(row("suite").head, /stopped/)
  assert.match(row("research").body, /ignores Retry-After/, "a stopped agent keeps what it had said")
  assert.match(row("research").head + row("research").body, /Stopped/)
  assert.match(row("read").body + row("read").head, /stopped|Stopped/, "a stopped call with nothing yet says so")
  assert.match(row("build").body, /transforming \(812\) src\/app\.tsx/, "a cut-off command keeps the output it had")
  assert.match(row("build").body, /Cut off before it finished\./)
  assert.match(row("build").head, /cut off/)
  assert.match(row("lint").body, /Linting 640 files/, "a call the harness canceled keeps its output")
  assert.match(row("lint").body, /Canceled\./)
  for (const id of ["suite", "research", "read", "build", "lint"])
    assert.doesNotMatch(row(id).body, /Completed with no text output|never returned a result|while this call was running/, `${id} claims no ending it didn't have`)

  for (const theme of ["dark", "light"]) {
    await evaluate(`document.documentElement.classList.toggle("light", ${theme === "light"}); true`)
    await frames()
    await until("document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)", "the rows settled")
    const height = await evaluate("Math.ceil(document.querySelector('main').getBoundingClientRect().bottom)")
    const shot = await page.capturePage({ x: 0, y: 0, width: 860, height: Math.min(height, 1600) })
    await writeFile(join(evidence, `stopped-calls-${theme}.png`), shot.toPNG())
  }
  await writeFile(join(evidence, "rows.json"), JSON.stringify(rows, null, 2))
  console.log(`Stopped calls UI: ${rows.length} rows; stopped and cut-off calls keep their output and say how they ended, dark and light`)
  clearTimeout(watchdog)
}
