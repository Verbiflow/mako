import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void check().then(async () => {
    const { app } = await import("electron")
    app.exit(0)
  }).catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const url = process.argv[2]
  assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Pass the local dev URL")
  const root = await mkdtemp(join(tmpdir(), "mako-diagram-check-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_DIAGRAM_TEST_ROOT: root, MAKO_DIAGRAM_TEST_URL: url }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)) })
  console.log(`Diagram evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_DIAGRAM_TEST_ROOT, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 60_000)
  const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code) => {
    const deadline = Date.now() + 10_000
    while (!await evaluate(code)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}; UI: ${await evaluate('document.body.innerText')}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  page.debugger.attach("1.3")
  const click = async (label) => {
    const point = await evaluate(`(() => { const n = [...document.querySelectorAll('button')].find(n => n.textContent === ${JSON.stringify(label)}); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  for (const query of ["?without-visibility", ""]) {
    await window.loadURL(new URL(`scripts/diagram-check.html${query}`, process.env.MAKO_DIAGRAM_TEST_URL).href)
    await until(`document.querySelector('img[alt="Diagram"]')?.naturalWidth > 0`)
    assert.equal(await evaluate(`document.body.textContent.includes('Rendering diagram…')`), false)
    await click("Toggle diagram")
    await until(`!document.querySelector('img[alt="Diagram"]')`)
    await click("Toggle diagram")
    await until(`document.querySelector('img[alt="Diagram"]')?.naturalWidth > 0`)
    await click("Toggle invalid source")
    await until(`document.body.textContent.includes('Diagram could not render.')`)
    await click("Toggle invalid source")
    await until(`document.querySelector('img[alt="Diagram"]')?.naturalWidth > 0`)
    console.log(`Exact diagram renders, remounts, and recovers after invalid source ${query ? 'without intersection notifications' : 'normally'}`)
  }
  await writeFile(join(process.env.MAKO_DIAGRAM_TEST_ROOT, "diagram.png"), (await page.capturePage()).toPNG())
  clearTimeout(watchdog)
  window.destroy()
}
