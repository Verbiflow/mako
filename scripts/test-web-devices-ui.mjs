import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { literal } from "./lib/page-code.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * The web app's Settings › Devices (`src/dev/web-devices-check.tsx`: `WebDevices`, the desktop's own `Devices`, on an
 * account's list held by the fixture), at a phone's width and at a laptop's:
 *
 * - Every device of the account, this browser first, each with its kind, system, Mako and health: online, quiet since
 *   (the account's own word), never connected, needs Mako's update; and the Sessions the account lists on it.
 * - Remove asks first, saying what stops, the Threads that leave the other devices included.
 * - Add a machine: the lines to run for the host and for a container, with the account's cloud; a sheet from the
 *   bottom on a phone, a dialog on a tablet and a laptop. A machine that joins turns it into what joined, as the
 *   stream says it. With no machine past a code's life it stops saying it waits and says how to try again; a machine
 *   that joins late still turns it. A removal that fails there is said there, with the machine still shown.
 * - On a phone, at 393 and at 320 wide, a row's facts break between facts and stay in their column: none runs into
 *   Remove or off the screen, the Mako version is whole, and a name beside a chip is whole. Measured, not read off
 *   the markup.
 * - This browser alone, or no device at all, gets a line about what a machine is for, and empty its own words.
 * - A Thread on a machine of the person's own wears a server: on a phone in its row and its bar
 *   (`phone-apex.html?machine`), in a laptop's browser in the rail, the strip above the Thread and the composer's
 *   chip (`web-desk.html?machine`).
 *
 * The forms are a phone (390 wide), a tablet (1180 wide under a finger: the touch rows, the sheet a dialog) and a
 * laptop (1280 wide under a mouse).
 *
 * Screenshots, dark and light, go to the printed directory, or to the directory given as the first argument.
 * `--only phone|widths|tablet|laptop|marks` (any number, by commas) runs those parts alone.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void check().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const root = testScratch("mako-web-devices-ui-")
  const args = process.argv.slice(2)
  const onlyAt = args.indexOf("--only")
  const only = onlyAt === -1 ? "" : args.splice(onlyAt, 2)[1]
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-web-devices-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_DEVICES_ROOT: root, MAKO_DEVICES_EVIDENCE: evidence, MAKO_DEVICES_URL: server.resolvedUrls.local[0], MAKO_DEVICES_ONLY: only }
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
  const parts = new Set((process.env.MAKO_DEVICES_ONLY || "phone,widths,tablet,laptop,marks").split(","))
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const watchdog = setTimeout(() => {
    console.error("Web devices UI verification exceeded its 480-second limit")
    app.exit(1)
  }, 480_000)
  const window = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 390, 844)
  const page = window.webContents
  // The debugger answers once the window holds a page.
  await window.loadURL("about:blank")
  page.debugger.attach("1.3")
  /** The page under a finger (a phone's or a tablet's pointer) or under a mouse, as the web app's forms ask the browser. */
  const pointer = async (touch) => {
    await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 })
    await page.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", { enabled: false })
  }
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
  /**
   * `working`: the page shows a Thread at work, whose marks move for as long as it works, so there is no rest to wait
   * for: it's shot a few frames on, as `test-web-desk-ui.mjs` shoots the same desk.
   */
  const capture = async (name, working = false) => {
    if (working) {
      await evaluate("document.fonts.ready.then(() => true)")
      for (let frame = 0; frame < 3; frame++) await frames()
    } else await settle()
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const theme = (next) => evaluate(`import('/src/web-client/theme.ts').then(({ applyTheme }) => (applyTheme(${literal(next)}), true))`)
  const both = async (name, working = false) => {
    await capture(name, working)
    await theme("light")
    await capture(`${name}-light`, working)
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
  const rowOf = (name) => `[...document.querySelectorAll('${DEVICES} [data-device-name]')].find((each) => each.textContent === ${literal(name)})?.closest('[data-device-row]')`
  const deviceRow = (name) => evaluate(`(${rowOf(name)})?.innerText.replace(/\\n+/g, '\\n') ?? null`)
  const pressIn = (name, label) => evaluate(`([...(${rowOf(name)}).querySelectorAll('button')].find((each) => each.innerText.trim() === ${literal(label)}).click(), true)`)
  const pressNamed = (scope, label) => evaluate(`([...document.querySelectorAll('${scope} button')].find((each) => each.innerText.trim() === ${literal(label)}).click(), true)`)
  const commands = () => evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].map((each) => each.textContent)`)
  const open = async (form, query = "") => {
    await window.loadURL(`${new URL("scripts/web-devices.html", base).href}${query}`)
    await until(`Boolean(document.querySelector('${DEVICES}[data-form="${form}"]'))`, `Settings › Devices, ${form}`)
  }

  /**
   * The same account in each form: the devices, a removal asked, a machine added and joined; then a wait that runs
   * out, a machine that joins late and a removal that fails in the sheet; then the lists with nothing to remove.
   * `sheet` is how Add a machine is drawn there.
   */
  const devices = async (form, prefix, sheet) => {
    await open(form)
    await until(`Boolean(document.querySelector('${DEVICES} [data-device-name]'))`, "the devices")
    const names = await evaluate(`[...document.querySelectorAll('${DEVICES} [data-device-name]')].map((each) => each.textContent)`)
    assert.equal(names[0], "Safari on iPhone", "this browser first")
    assert.match(await deviceRow("Safari on iPhone"), /^Safari on iPhone\nThis browser\nBrowser · iOS 26\.0\nOnline now/)
    assert.match(await deviceRow("build-box"), /^build-box\nLinux machine · x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now · 2 Threads\nJoined .+ from Frankfurt, Germany, with a code you approved/)
    assert.match(await deviceRow("gpu-rig"), /\nLinux machine · x64 · Debian 13 · Mako 0\.4\.0\nQuiet since (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}[:.]\d{2}/)
    assert.match(await deviceRow("nas"), /^nas\nNeeds Mako's update\nLinux machine · arm64 · Alpine 3\.22 · Mako 0\.1\.37\nOnline now/)
    assert.match(await deviceRow("Ada's MacBook Pro"), /\nMac · macOS 26\.0 · Mako 0\.4\.0\nOnline now · 1 Thread\n/)
    // A fact keeps its dot behind it: no line of a row's facts starts with one, however narrow the row.
    assert.equal(
      await evaluate(`[...document.querySelectorAll('${DEVICES} [data-device-facts] span')].every((fact) => !fact.textContent.startsWith(' ') && !fact.textContent.startsWith('·'))`),
      true,
      "no line of facts starts with a dot"
    )
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-note]').textContent`), "Removing a device signs it out within seconds, wherever it is.")
    // The devices' records are read again while this shows: as it opens, and whenever the window comes back to the front.
    const reads = await evaluate(`webDevicesCheck.refreshes()`)
    assert.ok(reads >= 1, "read as Settings opened")
    await evaluate(`(window.dispatchEvent(new Event('focus')), true)`)
    await until(`webDevicesCheck.refreshes() > ${reads}`, "read again as the window came back")
    assert.match(await deviceRow("ada-terminal"), /\nTerminal · Linux\nNever connected/)
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, "nothing runs off the screen sideways")
    await both(`${prefix}-devices`)

    // Remove asks first and says what stops, the Sessions the account lists there included.
    await pressIn("build-box", "Remove")
    await until(`Boolean(document.querySelector('${DEVICES} [data-device-stops]'))`, "the confirmation")
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-device-stops]').textContent`), "build-box is signed out within seconds and can't be reached until it joins again. Its 2 Threads leave your other devices and stay on build-box.")
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
    assert.equal(await evaluate(`document.querySelector('.web-sheet').dataset.form`), sheet)
    assert.deepEqual(await commands(), ["mako-host join --cloud https://cloud.example.com", "mako-host"])
    assert.match(await evaluate(`document.querySelector('.web-sheet').innerText`), /^Add a machine[\s\S]*watch and steer its Threads, and start new ones there[\s\S]*It prints a page and a code[\s\S]*approve it once the code matches[\s\S]*Waiting for a machine to join\s+Close$/)
    assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').dataset.machineWaiting`), "waiting")
    await both(`${prefix}-add-machine`)
    await pressNamed("[data-add-machine-sheet]", "Docker")
    await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines")
    assert.deepEqual(await commands(), ["docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL=https://cloud.example.com mako-device", "docker logs -f mako-device"])
    // The container's long line wraps inside its box: nothing of it lies under Copy or past the edge.
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].every((line) => line.scrollWidth <= line.clientWidth)`), true, "no line is cut")
    await both(`${prefix}-add-machine-docker`)

    // A machine joins while it waits: the sheet says what joined, as the account's stream did.
    await evaluate(`(webDevicesCheck.join("render-box"), true)`)
    await until(`Boolean(document.querySelector('[data-machine-joined]'))`, "the joined machine")
    assert.match(await evaluate(`document.querySelector('.web-sheet').innerText`), /^render-box joined[\s\S]*render-box is a device of your account[\s\S]*A machine on Linux x64 · Ubuntu 24\.04, from Frankfurt, Germany, with a code you approved\. It's in your devices now\./)
    await both(`${prefix}-add-machine-joined`)
    await pressNamed(".web-sheet", "Done")
    await until(`!document.querySelector('.web-sheet') && [...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'render-box')`, "the machine in the list")
    assert.match(await deviceRow("render-box"), /^render-box\nLinux machine · x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now/)

    // No machine comes: past a code's life the sheet stops saying it waits, and says how to try again.
    await open(form)
    await until(`Boolean(document.querySelector('${DEVICES} [data-add-machine]'))`, "the devices again")
    await evaluate(`(document.querySelector('${DEVICES} [data-add-machine]').click(), true)`)
    await until(`document.querySelector('[data-machine-waiting]')?.dataset.machineWaiting === 'waiting'`, "the wait")
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-machine-waiting] .shimmer-text'))`), true, "it shimmers while a code can still be confirmed")
    await evaluate(`(webDevicesCheck.lapse(), true)`)
    await until(`document.querySelector('[data-machine-waiting]')?.dataset.machineWaiting === 'lapsed'`, "the wait given up")
    assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').textContent`), "No machine yet. A code lasts 10 minutes, so run the join line again for a new one.")
    assert.equal(await evaluate(`Boolean(document.querySelector('.web-sheet .shimmer-text'))`), false, "nothing shimmers once nothing is on its way")
    await both(`${prefix}-add-machine-no-machine`)
    // In a container the code's end stopped it, and its name is taken: the words name the line that starts it again,
    // never the run line above, which can't run twice.
    await pressNamed("[data-add-machine-sheet]", "Docker")
    await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines, the wait given up")
    assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').textContent`), "No machine yet. A code lasts 10 minutes, so run docker start mako-device for a new one.")
    assert.equal(await evaluate(`document.querySelector('[data-machine-waiting] code').textContent`), "docker start mako-device", "set as a line to run")
    assert.match((await commands())[0], /--name mako-device /, "the container it starts is the one the run line named")
    // The words are the sheet's last line: brought into view on a phone, where the container's lines are taller than the screen.
    await evaluate(`(document.querySelector('.web-sheet [data-sheet-scroll]')?.scrollTo(0, 100000), true)`)
    await both(`${prefix}-add-machine-no-machine-docker`)
    await pressNamed("[data-add-machine-sheet]", "Mako's host")
    await until(`document.querySelector('[data-machine-waiting]').textContent.includes('run the join line again')`, "the host's words, as they were")

    // A machine that joins late still turns the sheet into what joined. Removing it fails: said in the sheet, where
    // Remove was pressed, with the machine still shown, and not behind it.
    await evaluate(`(webDevicesCheck.join("render-box"), true)`)
    await until(`Boolean(document.querySelector('[data-machine-joined]'))`, "the late machine")
    await evaluate(`(webDevicesCheck.failRemovals(true), true)`)
    await pressNamed(".web-sheet", "Not yours? Remove")
    await until(`Boolean(document.querySelector('.web-sheet [data-machine-remove-failed]'))`, "the failed removal, in the sheet")
    assert.equal(await evaluate(`document.querySelector('[data-machine-remove-failed]').textContent`), "render-box is still on your account: Mako Cloud couldn't be reached. Try again in a moment.")
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-machine-joined]'))`), true, "the sheet still shows what joined")
    assert.equal(await evaluate(`Boolean(document.querySelector('${DEVICES} [data-device-remove-failed]'))`), false, "and the failure isn't said behind it as well")
    await both(`${prefix}-add-machine-remove-failed`)
    await evaluate(`(webDevicesCheck.failRemovals(false), true)`)
    await pressNamed(".web-sheet", "Not yours? Remove")
    await until(`!document.querySelector('.web-sheet') && ![...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'render-box')`, "the machine removed")

    // This browser alone has nothing to remove, and no device at all nothing to list: the line says what a machine is for.
    const purpose = "Add a machine of your own, and Threads can run there while you watch and steer them from here."
    await open(form, "?devices=one")
    await until(`document.querySelectorAll('${DEVICES} [data-device-name]').length === 1`, "this browser alone")
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-note]').textContent`), purpose)
    await both(`${prefix}-devices-one`)
    await open(form, "?devices=none")
    await until(`Boolean(document.querySelector('${DEVICES} [data-devices-empty]'))`, "no devices")
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-empty]').textContent`), "No devices yet.")
    assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-note]').textContent`), purpose)
    await both(`${prefix}-devices-none`)

    // A gateway from before it said its own address: the lines leave the cloud to the machine, and each still runs as
    // it's written, with no placeholder a shell would misread.
    await open(form, "?cloud=unsaid")
    await until(`Boolean(document.querySelector('${DEVICES} [data-add-machine]'))`, "the devices, the cloud unsaid")
    await evaluate(`(document.querySelector('${DEVICES} [data-add-machine]').click(), true)`)
    await until(`Boolean(document.querySelector('[data-add-machine-sheet]'))`, "Add a machine, the cloud unsaid")
    assert.deepEqual(await commands(), ["mako-host join", "mako-host"])
    await pressNamed("[data-add-machine-sheet]", "Docker")
    await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines, the cloud unsaid")
    assert.deepEqual(await commands(), ['docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL="$MAKO_CLOUD_URL" mako-device', "docker logs -f mako-device"])
    assert.match(await evaluate(`document.querySelector('[data-add-machine-sheet]').innerText`), /Set MAKO_CLOUD_URL to your Mako cloud's address first\./)
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].some((line) => /[<>]/.test(line.textContent))`), false, "nothing a shell reads as a redirection")
    await both(`${prefix}-add-machine-cloud-unsaid`)
  }

  if (parts.has("phone")) {
    await pointer(true)
    window.setContentSize(390, 844)
    await devices("touch", "web-phone", "sheet")
    console.log("Phone: the account's devices, a removal asked with what stops, a machine added from a sheet and said as it joins, a wait that runs out, a removal that fails in the sheet")
  }

  if (parts.has("widths")) {
    // A phone's widths, measured: every fact inside its column, clear of Remove and of the screen's edge; the Mako
    // version whole; a name whole beside its chip.
    await pointer(true)
    for (const width of [393, 320]) {
      window.setContentSize(width, 1400)
      await open("touch")
      await until(`document.querySelectorAll('${DEVICES} [data-device-name]').length >= 6`, `the devices at ${width}`)
      await settle()
      const rows = await evaluate(`[...document.querySelectorAll('${DEVICES} [data-device-row]')].map((row) => {
        const box = (node) => node.getBoundingClientRect()
        const name = row.querySelector('[data-device-name]')
        const facts = row.querySelector('[data-device-facts]')
        const spans = [...facts.querySelectorAll('span')]
        const remove = [...row.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Remove')
        const standing = row.querySelector('[data-device-health] span:last-child')
        return {
          standing: standing.textContent,
          standingCut: standing.scrollWidth - standing.clientWidth,
          standingRight: box(standing).right,
          name: name.textContent,
          nameWidth: name.clientWidth,
          nameCut: name.scrollWidth - name.clientWidth,
          column: box(facts).right,
          furthest: Math.max(...spans.map((span) => box(span).right)),
          last: spans.at(-1).textContent,
          lastLeft: box(spans.at(-1)).left,
          lastRight: box(spans.at(-1)).right,
          remove: remove ? box(remove).left : null,
          screen: innerWidth,
        }
      })`)
      assert.equal(rows.length, 6)
      for (const row of rows) {
        const said = `${row.name} at ${width}: ${JSON.stringify(row)}`
        assert.ok(row.furthest <= row.column + 0.5, `a fact runs past its column: ${said}`)
        assert.ok(row.furthest <= (row.remove ?? row.screen) + 0.5, `a fact runs into Remove or off the screen: ${said}`)
        assert.ok(row.lastLeft >= 0 && row.lastRight <= row.screen, `the last fact is whole on screen: ${said}`)
        assert.ok(row.nameWidth > 0 && row.nameCut <= 0, `the name is whole: ${said}`)
        assert.ok(row.standingCut <= 0 && row.standingRight <= (row.remove ?? row.screen) + 0.5, `its health and what runs there are whole: ${said}`)
      }
      assert.deepEqual(rows.filter((row) => row.last.startsWith("Mako ")).map((row) => row.name).sort(), ["Ada's MacBook Pro", "build-box", "gpu-rig", "nas"], "each device that says its Mako shows it last, whole")
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, "nothing runs off the screen sideways")
      await both(`web-phone-${width}-devices`)
    }
    console.log("Phone at 393 and 320 wide: every fact in its column, clear of Remove, the Mako version and each name whole")
  }

  if (parts.has("marks")) {
    // A phone's list and Thread on a machine of the person's own: a server where a Mac's laptop stands.
    await pointer(true)
    window.setContentSize(390, 844)
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

    // A laptop's browser on a Thread that runs on a machine of the person's own: the rail's row and the strip above
    // the Thread wear the server, and the strip says its name.
    await pointer(false)
    window.setContentSize(1280, 800)
    await window.loadURL(`${new URL("scripts/web-desk.html", base).href}?thread=busy&machine`)
    await until(`Boolean(document.querySelector('[data-thread-screen] [data-place]'))`, "the Thread's strip")
    assert.equal(await evaluate(`document.querySelector('[data-thread-screen] [data-place]').dataset.place`), "machine", "the strip wears the server")
    assert.match(await evaluate(`document.querySelector('[data-thread-screen] [data-place]').parentElement.innerText`), /^build-box/)
    assert.equal(await evaluate(`document.querySelectorAll('[data-thread-row] [data-elsewhere="machine"]').length > 0`), true, "the rail's rows wear it")
    assert.equal(await evaluate(`document.querySelectorAll('[data-thread-row] [data-elsewhere="device"], [data-thread-screen] [data-place="device"]').length`), 0, "nothing wears a laptop")
    await both("web-desk-thread-machine", true)
    console.log("Laptop: a machine's rail rows and its Thread's strip wear the server")
  }

  if (parts.has("tablet")) {
    await pointer(true)
    window.setContentSize(1180, 820)
    await devices("touch", "web-tablet", "dialog")
    console.log("Tablet: the touch rows, Add a machine a dialog")
  }

  if (parts.has("laptop")) {
    await pointer(false)
    window.setContentSize(1280, 800)
    await devices("desk", "web-desk", "dialog")
    console.log("Laptop: the same devices in the desk's form, Add a machine a dialog")
  }
  clearTimeout(watchdog)
}
