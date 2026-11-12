import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// A Fin that waits on the person says on what wherever "Needs you" shows, and one click reaches the answer: on the
// mock bridge's Apex scene (`?mock&app=apex`), at a 1352 × 847 desk window, each asking Fin's rail row carries its
// question under its name; its tab names the question; and the Fin opened from that row shows its ask with its answers
// above its own composer, an answer there reaching the Apex's host. A Fin whose ask is an approval in its own
// conversation keeps the one card that conversation draws. Screenshots land in the printed folder (or
// `MAKO_NEEDS_YOU_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-needs-you-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-needs-you-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_NEEDS_YOU_ROOT: root, MAKO_NEEDS_YOU_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Needs you UI evidence: ${process.env.MAKO_NEEDS_YOU_SHOTS ?? join(root, "shots")}`)
}

/** The scene's Fin that asks the person a question through its Apex (`mock-apex-thread.ts`). */
const QUESTION = "Which tone for the quiet-hours notice? Plain or friendly?"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_NEEDS_YOU_ROOT
  const shots = process.env.MAKO_NEEDS_YOU_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_NEEDS_YOU_URL
  const window = new BrowserWindow({ width: 1352, height: 847, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  atSize(window, 1352, 847)
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(shots, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const shoot = async (name) => writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
  /** The rail row of the asking Fin whose title starts `title`. */
  const row = (title) => `[...document.querySelectorAll('[data-asking-fin]')].find((node) => node.innerText.startsWith(${JSON.stringify(title)}))`

  await window.loadURL(`${base}?mock&app=apex`)
  await until(`Boolean(${row("Quiet-hours")})`, "the asking Fins' rail rows")

  // 1. The rail: "Needs you" says on what, under the Fin's name, for each asking Fin.
  const lines = await evaluate("[...document.querySelectorAll('[data-asking-fin]')].map((node) => [node.innerText.split('\\n')[0], node.querySelector('[data-asking-line]')?.textContent ?? null])")
  assert.ok(lines.length >= 2, `the scene has Fins asking the person: ${JSON.stringify(lines)}`)
  for (const [title, line] of lines) assert.ok(line, `${title}'s rail row says "Needs you" and nothing of what it needs`)
  assert.equal(await evaluate(`${row("Quiet-hours")}.querySelector('[data-asking-line]').textContent`), QUESTION)
  console.log(`PASS: each asking Fin's rail row says what it needs: ${lines.map(([title, line]) => `${title}: ${line}`).join("; ")}`)

  // 2. One click: its rail row opens the Fin, and its question and answers stand above its own composer.
  await evaluate(`${row("Quiet-hours")}.click(); true`)
  await until("Boolean(document.querySelector('[data-child-tab]'))", "the Fin's tab")
  await until("Boolean(document.querySelector('[data-own-asks]'))", "the opened Fin's own ask above its composer")
  const own = await evaluate("document.querySelector('[data-own-asks]').innerText.replace(/\\s+/g, ' ')")
  assert.ok(own.includes(QUESTION) && own.includes("Plain") && own.includes("Friendly"), `the Fin's view shows its question and answers: ${own}`)
  const placed = await evaluate("(() => { const ask = document.querySelector('[data-own-asks]').getBoundingClientRect(); const composer = document.querySelector('[data-composer] [contenteditable], [data-composer] textarea')?.getBoundingClientRect(); return { ask: [ask.top, ask.bottom], composer: composer && [composer.top, composer.bottom], tall: innerHeight } })()")
  assert.ok(placed.ask[0] >= 0 && placed.ask[1] <= placed.tall, `the ask is on screen: ${JSON.stringify(placed)}`)
  assert.match(await evaluate("document.querySelector('[data-child-tab]').title"), /Which tone for the quiet-hours notice/, "the Fin's tab names what it waits on")
  await shoot("fin-opened-from-rail")
  const fin = await evaluate("document.querySelector('[data-own-asks] [data-fin]').dataset.fin")
  await evaluate("[...document.querySelectorAll('[data-own-asks] button')].find((node) => node.innerText.trim().startsWith('Friendly')).click(); true")
  await until(`window.apexScene.responds().some((answer) => answer.fin === ${JSON.stringify(fin)} && answer.option === 1)`, "Friendly reaching the Apex's host for this Fin")
  console.log(`PASS: the Fin opened from its rail row shows "${QUESTION}" with its answers above its composer, and Friendly reaches its Apex`)

  // 3. An approval in the Fin's own conversation keeps its one card there: no second copy from the Apex's roster.
  await evaluate(`${row("Sheet motion")}.click(); true`)
  await until("document.querySelector('[data-child-tab]')?.innerText.includes('Sheet motion')", "the approving Fin")
  await until("[...document.querySelectorAll('button')].some((node) => node.innerText.trim() === 'Allow once')", "its own approval card")
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(await evaluate("Boolean(document.querySelector('[data-own-asks]'))"), false, "the approval shows once, by its own conversation's card")
  await shoot("fin-approval")
  console.log("PASS: a Fin's own approval shows once, on its own card")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Needs you UI: passed")
  app.exit(0)
}
