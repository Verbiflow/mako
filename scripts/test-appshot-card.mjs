// The Appshot card's hint (electron/appshot-feedback-electron.ts), drawn
// from the card's own page in a hidden window of the test's own: a capture
// added, then the line saying another app came to the front with the press,
// and its ×, which asks to dismiss the hint and nothing else. Nothing is
// shown on screen and nothing takes focus.
//
//   node --import tsx scripts/test-appshot-card.mjs [evidence-dir]
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (process.versions.electron) void card()
else {
  const root = await mkdtemp(join(tmpdir(), "mako-appshot-card-"))
  const evidence = resolve(process.argv[2] ?? root)
  await mkdir(evidence, { recursive: true })
  const env = { ...process.env, NODE_OPTIONS: "--import tsx", MAKO_CARD_EVIDENCE: evidence, MAKO_CARD_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)("electron"), [resolve("scripts/test-appshot-card.mjs")], { env, stdio: "inherit" })
  process.exitCode = await new Promise((done) => child.once("exit", (code) => done(code ?? 1)))
}

async function card() {
  const { app, BrowserWindow } = await import("electron")
  const { cardPage } = await import(resolve("electron/appshot-feedback-electron.ts"))
  const evidence = process.env.MAKO_CARD_EVIDENCE
  app.setPath("userData", join(process.env.MAKO_CARD_ROOT, "profile"))
  app.dock?.hide()
  await app.whenReady()
  try {
    // The card's window with its hint: 104 points and the hint's 48, as the client sizes it.
    const window = new BrowserWindow({ width: 380, height: 152, frame: false, show: false, backgroundColor: "#141210", webPreferences: { sandbox: true, contextIsolation: true } })
    const asked = []
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
      asked.push(url)
    })
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cardPage())}`)
    const icon = `data:image/png;base64,${(await readFile(resolve("public/icons/app-icon.png"))).toString("base64")}`
    const colors = { surface: "oklch(0.238 0.007 50)", text: "oklch(0.93 0.01 60)", muted: "oklch(0.722 0.008 58)", border: "oklch(0.93 0.008 58 / 14%)", font: "-apple-system, system-ui, sans-serif" }
    const run = (code) => window.webContents.executeJavaScript(code)
    await run(`window.update(${JSON.stringify({ id: "a", phase: "added", app: "Notes", title: "Groceries", icon, thumbnail: icon, destination: "Fix the sync bug", colors })}); true`)
    await run(`window.hint(${JSON.stringify("Raycast came to the front too. It may also use ⌃⇧2.")}); true`)
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(await run(`document.getElementById("hint").classList.contains("in")`), true)
    assert.equal(await run(`document.getElementById("hint-text").textContent`), "Raycast came to the front too. It may also use ⌃⇧2.")
    const fits = await run(`(() => { const card = document.getElementById("card").getBoundingClientRect(); const hint = document.getElementById("hint").getBoundingClientRect(); return hint.bottom <= card.bottom + 0.5 })()`)
    assert.ok(fits, "the hint fits inside the card")
    await writeFile(join(evidence, "05-card-hint.png"), (await window.webContents.capturePage()).toPNG())
    // The × asks to dismiss the hint; the card's own click (open Mako) isn't asked for.
    await run(`document.getElementById("hint-close").click(); true`)
    await new Promise((done) => setTimeout(done, 100))
    assert.deepEqual(asked, ["mako-hud:dismiss-hint"])
    await run(`window.hint(null); true`)
    assert.equal(await run(`document.getElementById("hint").classList.contains("in")`), false, "dismissed, the hint goes")
    window.setSize(380, 104)
    await new Promise((done) => setTimeout(done, 200))
    await writeFile(join(evidence, "05b-card-dismissed.png"), (await window.webContents.capturePage()).toPNG())
    console.log(`Appshot card: the hint shows under the receipt, fits the card, and its × asks only to dismiss it. Screenshots in ${evidence}`)
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
