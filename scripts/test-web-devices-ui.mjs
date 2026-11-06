import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The web app's Settings › Devices (`src/dev/web-devices-check.tsx`: `WebDevices`, the desktop's own `Devices`, on an
 * account's list held by the fixture), at a phone's width and at a laptop's:
 *
 * - Every device of the account, this browser first, each with its kind, system, Mako and health: online, quiet since
 *   (the account's own word), never connected, needs Mako's update; and the Sessions the account lists on it.
 * - Remove asks first, saying what stops, the Sessions that leave the other devices included.
 * - Add a machine: the lines to run for the host and for a container, with the account's cloud; a sheet from the
 *   bottom on a phone, a dialog on a laptop. A machine that joins turns it into what joined, as the stream says it.
 * - On a phone, a Thread on a machine of the person's own wears a server in its row and in its bar
 *   (`phone-apex.html?machine`).
 *
 * Screenshots, dark and light, go to the printed directory, or to the directory given as the first argument.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void check().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-web-devices-ui-"))
  const evidence = process.argv[2] ? resolve(process.argv[2]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-web-devices-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_DEVICES_ROOT: root, MAKO_DEVICES_EVIDENCE: evidence, MAKO_DEVICES_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Web devices UI evidence: ${evidence}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_DEVICES_ROOT
  const evidence = process.env.MAKO_DEVICES_EVIDENCE
  const base = process.env.MAKO_DEVICES_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => {
    console.error("Web devices UI verification exceeded its 180-second limit")
    app.exit(1)
  }, 180_000)
  const window = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  /** Everything at rest: fonts in, every finite animation done, and a sheet's spring settled (it moves by frames, not by an animation). */
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    let last
    for (let tries = 0; tries < 40; tries++) {
      const now = await evaluate(`(() => { const sheet = document.querySelector('.web-sheet'); return sheet ? getComputedStyle(sheet).transform + sheet.getBoundingClientRect().top : '' })()`)
      if (now === last) break
      last = now
      await wait(50)
    }
    await frames()
  }
  const capture = async (name) => {
    await settle()
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const theme = (next) => evaluate(`import('/src/web-client/theme.ts').then(({ applyTheme }) => (applyTheme(${JSON.stringify(next)}), true))`)
  const both = async (name) => {
    await capture(name)
    await theme("light")
    await capture(`${name}-light`)
    await theme("dark")
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const DEVICES = '[data-testid="account-devices"]'
  const rowOf = (name) => `[...document.querySelectorAll('${DEVICES} [data-device-name]')].find((each) => each.textContent === ${JSON.stringify(name)})?.closest('[data-device-row]')`
  const deviceRow = (name) => evaluate(`(${rowOf(name)})?.innerText.replace(/\\n+/g, '\\n') ?? null`)
  const pressIn = (name, label) => evaluate(`([...(${rowOf(name)}).querySelectorAll('button')].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click(), true)`)
  const pressNamed = (scope, label) => evaluate(`([...document.querySelectorAll('${scope} button')].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click(), true)`)
  const commands = () => evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].map((each) => each.textContent)`)
  const open = async (form) => {
    await window.loadURL(new URL("scripts/web-devices.html", base).href)
    await until(`Boolean(document.querySelector('${DEVICES}[data-form="${form}"] [data-device-name]'))`, `Settings › Devices, ${form}`)
  }

  /** The same account in either form: the devices, a removal asked, a machine added and joined. */
  const devices = async (form, prefix) => {
    await open(form)
    const names = await evaluate(`[...document.querySelectorAll('${DEVICES} [data-device-name]')].map((each) => each.textContent)`)
    assert.equal(names[0], "Safari on iPhone", "this browser first")
    assert.match(await deviceRow("Safari on iPhone"), /^Safari on iPhone\nThis browser\nBrowser · iOS 26\.0\nOnline now/)
    assert.match(await deviceRow("build-box"), /^build-box\nLinux machine · Linux x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now · 2 Sessions\nJoined .+ from Frankfurt, Germany, with a code you approved/)
    assert.match(await deviceRow("gpu-rig"), /\nLinux machine · Linux x64 · Debian 13 · Mako 0\.4\.0\nQuiet since \d/)
    assert.match(await deviceRow("nas"), /^nas\nNeeds Mako's update\nLinux machine · Linux arm64 · Alpine 3\.22 · Mako 0\.1\.37\nOnline now/)
    assert.match(await deviceRow("Ada's MacBook Pro"), /\nMac · macOS 26\.0 · Mako 0\.4\.0\nOnline now · 1 Session\n/)
    assert.match(await deviceRow("ada-terminal"), /\nTerminal · Linux\nNever connected/)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, "nothing runs off the screen sideways")
    await both(`${prefix}-devices`)

    // Remove asks first and says what stops, the Sessions the account lists there included.
    await pressIn("build-box", "Remove")
    await until(`Boolean(document.querySelector('${DEVICES} [data-device-stops]'))`, "the confirmation")
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-device-stops]').textContent`), "build-box is signed out within seconds and can't be reached until it joins again. Its 2 Sessions leave your other devices and stay on build-box.")
    await both(`${prefix}-remove-confirm`)
    await pressIn("build-box", "Cancel")
    await until(`!document.querySelector('${DEVICES} [data-device-stops]')`, "the confirmation gone")
    await pressIn("gpu-rig", "Remove")
    await until(`Boolean(document.querySelector('${DEVICES} [data-device-stops]'))`, "the quiet machine's confirmation")
    await pressIn("gpu-rig", "Remove")
    await until(`![...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'gpu-rig')`, "the device removed")

    // Add a machine: the guide's lines with the account's cloud, for the host and for a container.
    await evaluate(`(document.querySelector('${DEVICES} [data-add-machine]').click(), true)`)
    await until(`Boolean(document.querySelector('[data-add-machine-sheet]'))`, "Add a machine")
    assert.equal(await evaluate(`document.querySelector('.web-sheet').dataset.form`), form === "touch" ? "sheet" : "dialog")
    assert.deepEqual(await commands(), ["mako-host join --cloud https://cloud.example.com", "mako-host"])
    assert.match(await evaluate(`document.querySelector('.web-sheet').innerText`), /^Add a machine[\s\S]*It prints a page and a code[\s\S]*approve it once the code matches[\s\S]*Waiting for a machine to join/)
    await both(`${prefix}-add-machine`)
    await pressNamed("[data-add-machine-sheet]", "Docker")
    await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines")
    assert.deepEqual(await commands(), ["docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL=https://cloud.example.com mako-device", "docker logs -f mako-device"])
    await both(`${prefix}-add-machine-docker`)

    // A machine joins while it waits: the sheet says what joined, as the account's stream did.
    await evaluate(`(webDevicesCheck.join("render-box"), true)`)
    await until(`Boolean(document.querySelector('[data-machine-joined]'))`, "the joined machine")
    assert.match(await evaluate(`document.querySelector('.web-sheet').innerText`), /^render-box joined[\s\S]*render-box is a device of your account[\s\S]*A machine on Linux x64 · Ubuntu 24\.04, from Frankfurt, Germany, with a code you approved\. It's in your devices now\./)
    await both(`${prefix}-add-machine-joined`)
    await pressNamed(".web-sheet", "Done")
    await until(`!document.querySelector('.web-sheet') && [...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'render-box')`, "the machine in the list")
    assert.match(await deviceRow("render-box"), /^render-box\nLinux machine · Linux x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now/)
  }

  await devices("touch", "web-phone")
  console.log("Phone: the account's devices, a removal asked with what stops, a machine added from a sheet and said as it joins")

  // A phone's list and Thread on a machine of the person's own: a server where a Mac's laptop stands.
  await window.loadURL(`${new URL("scripts/phone-apex.html", base).href}?machine`)
  await until(`document.querySelectorAll('[data-thread]').length >= 4`, "the phone's list")
  assert.equal(await evaluate(`document.querySelectorAll('[data-thread] [data-place="machine"]').length >= 3`), true, "idle rows on the machine wear a server")
  assert.equal(await evaluate(`document.querySelectorAll('[data-thread] [data-place="device"]').length`), 0, "none a laptop")
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-thread]')].filter((row) => row.querySelector('[data-place="machine"]')).every((row) => row.innerText.includes('build-box'))`), true, "and say its name, the account having a Mac too")
  await both("web-phone-list-machine")
  const thread = await evaluate(`import('/src/dev/mock-apex-thread.ts').then(({ APEX_THREAD }) => APEX_THREAD)`)
  await window.loadURL(`${new URL("scripts/phone-apex.html", base).href}?machine&open=${thread}`)
  await until(`Boolean(document.querySelector('header [data-place]'))`, "the Thread's bar")
  assert.equal(await evaluate(`document.querySelector('header [data-place]').dataset.place`), "machine")
  assert.match(await evaluate(`document.querySelector('header [data-place]').parentElement.innerText`), /build-box/)
  await both("web-phone-thread-machine")
  console.log("Phone: a machine's rows and its Thread's bar wear the server, with its name")

  window.setContentSize(1280, 800)
  await devices("desk", "web-desk")
  console.log("Laptop: the same devices in the desk's form, Add a machine a dialog")
  clearTimeout(watchdog)
}
