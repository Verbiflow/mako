import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * Screenshots of the Files view and the file viewer from a running `scripts/files-ui.mjs`, in a hidden window at
 * twice the pixels: the tree open to a file, that file highlighted, a name search, a text search, and the light
 * theme; with `--phone`, the same at a phone's width. It also times a keystroke to its painted results.
 *
 *   node scripts/files-ui-shots.mjs <files-check url> [--out <dir>] [--open src,src/components] [--file <path>]
 */

if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const argv = process.argv.slice(2)
  const option = (name) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const url = argv[0]
  if (!url) throw new Error("Pass the files check page's URL")
  const out = resolve(option("--out") ?? (await mkdtemp(join(tmpdir(), "mako-files-shots-"))))
  await mkdir(out, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), "mako-files-shots-app-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-files-shots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, FILES_SHOTS: JSON.stringify({ url, out, root, open: option("--open") ?? "src,src/components,src/components/viewer", file: option("--file") ?? "src/components/viewer/file-view.tsx", name: option("--name") ?? "fileview", text: option("--text") ?? "useVirtualizer", phone: argv.includes("--phone") }) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  process.exitCode = await new Promise((done, failed) => {
    child.once("error", failed)
    child.once("exit", (code) => done(code ?? 1))
  })
  console.log(`Screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow } = await import("electron")
  const config = JSON.parse(process.env.FILES_SHOTS)
  app.commandLine.appendSwitch("force-device-scale-factor", "2")
  app.setPath("userData", join(config.root, "profile"))
  await app.whenReady()
  const size = config.phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }
  const window = new BrowserWindow({ ...size, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Files screenshots exceeded their 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[page] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, ms = 20_000) => {
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${code}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const settle = () => evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))")
  const capture = async (name) => {
    await evaluate("Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))).then(() => true)")
    await settle()
    await writeFile(join(config.out, name), (await page.capturePage()).toPNG())
    console.log(`  ${name}`)
  }
  const press = async (key, code = key, windowsVirtualKeyCode) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode })
  }
  const clearField = async () => {
    await evaluate(`document.querySelector('input[aria-label="Search files by name and contents"]').focus()`)
    await press("Escape", "Escape", 27)
  }
  /** Types a query a character at a time, as a person does, and times each keystroke to its first painted result. */
  const typed = async (text, wanted) => {
    await evaluate(`document.querySelector('input[aria-label="Search files by name and contents"]').focus()`)
    const times = []
    for (const char of text) {
      const started = Date.now()
      await page.debugger.sendCommand("Input.insertText", { text: char })
      // Its first rows: names found, or the line saying none are.
      await until(`Boolean(document.querySelector('[role=listbox] > div > div'))`, 10_000)
      times.push(Date.now() - started)
    }
    if (wanted) await until(wanted, 60_000)
    return times
  }

  // Highlighted: the code's spans carry a token colour, not just the plain text's.
  const highlighted = `(() => { const root = document.querySelector('diffs-container')?.shadowRoot; return Boolean(root && [...root.querySelectorAll('[data-line] span[style]')].some((span) => /--syntax-(keyword|function|string)/.test(span.getAttribute('style') ?? ''))) })()`
  const theme = (name) => `${config.url}?theme=${name}&open=${encodeURIComponent(config.open)}`
  if (config.phone) {
    // The web app's Files at a phone's size: the tree, a search, and a file read on its computer.
    for (const name of ["dark", "light"]) {
      await window.loadURL(`${theme(name)}&form=phone`)
      await until(`document.querySelectorAll('[role=tree] [role=treeitem]').length > 5`)
      await capture(`phone-tree-${name}.png`)
      if (name === "dark") {
        const times = await typed(config.name, `document.querySelector('[role=listbox] [role=option]')?.textContent.length > 0`)
        console.log(`phone keystroke to painted name results: ${times.join(", ")} ms`)
        await capture("phone-search.png")
      }
      await window.loadURL(`${theme(name)}&form=phone&path=${encodeURIComponent(config.file)}`)
      await until(highlighted)
      await capture(`phone-file-${name}.png`)
    }
    clearTimeout(watchdog)
    app.exit(0)
    return
  }
  for (const name of ["dark", "light"]) {
    await window.loadURL(`${config.url}?theme=${name}&icons`)
    await until(`document.querySelectorAll('svg').length > 40`)
    // A hidden window's first frame can be captured before it's composited.
    await new Promise((done) => setTimeout(done, 400))
    await capture(`icons-${name}.png`)
  }
  const opened = Date.now()
  await window.loadURL(`${theme("dark")}&file=${encodeURIComponent(config.file)}`)
  await until(`document.querySelectorAll('[role=tree] [role=treeitem]').length > 5`)
  await until(highlighted)
  console.log(`file highlighted ${Date.now() - opened} ms after the page was asked for`)
  await capture(config.phone ? "phone-tree-dark.png" : "desk-dark.png")

  const nameTimes = await typed(config.name, `document.querySelector('[role=listbox] [role=option]')?.textContent.length > 0`)
  await capture(config.phone ? "phone-search-names.png" : "search-names.png")
  await clearField()
  const textTimes = await typed(config.text, `!document.querySelector('[role=listbox]')?.textContent.includes('Searching') && [...document.querySelectorAll('[role=listbox] [role=option]')].some((row) => /^\\d/.test(row.textContent.trim()))`)
  await capture(config.phone ? "phone-search-text.png" : "search-text.png")
  await clearField()
  console.log(`keystroke to painted name results: ${nameTimes.join(", ")} ms`)
  console.log(`keystroke to painted results while typing "${config.text}": ${textTimes.join(", ")} ms`)

  await window.loadURL(`${theme("light")}&file=${encodeURIComponent(config.file)}`)
  await until(`document.querySelectorAll('[role=tree] [role=treeitem]').length > 5`)
  await until(highlighted)
  await capture(config.phone ? "phone-tree-light.png" : "desk-light.png")
  clearTimeout(watchdog)
  app.exit(0)
}
