import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { literal } from "./lib/page-code.mjs"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * Settings › Devices and Settings › Account against the production components
 * and the fixture desk. Devices: every device of the account, this Mac first,
 * each with its kind, system, Mako, health (online, quiet since, never
 * connected, needs Mako's update) and how it joined; Remove says what stops
 * before it removes. Add a machine shows the lines to run and turns into the
 * machine that joined as the account says so, with no toast beside it. A rail
 * row on a machine of the person's own wears a server, apart from a Mac's
 * laptop and the cloud. Account: a Mac signed out because its sign-in was used
 * from somewhere else says so; the browsers signed in to the account are named
 * and placed, and signed out one at a time or all, each asked first.
 * Screenshots of each, dark and light, stay in the printed directory, or in
 * the directory given as the first argument.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = testScratch("mako-account-devices-ui-")
  const evidence = args[0] ? resolve(args[0]) : process.env.MAKO_TEST_EVIDENCE ? join(process.env.MAKO_TEST_EVIDENCE, "account-devices") : root
  await mkdir(evidence, { recursive: true })
  const server = await uiVite({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-account-devices-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_EVIDENCE: evidence, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
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
  console.log(`UI evidence: ${evidence}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const evidence = process.env.MAKO_UI_TEST_EVIDENCE
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 1240, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 1280, 1240)
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Account devices UI verification exceeded its 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  let showToasts = false
  const settle = async () => {
    // The fixture desk's own toasts, such as its deliberately broken plugin, aren't what's shown here, but for the one a step looks at.
    if (!showToasts) await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** The whole window, and a crop around `around` when given. */
  const capture = async (name, around) => {
    await settle()
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
    if (!around) return
    const rect = await evaluate(`(() => {
      const nodes = ${literal(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 24
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    if (rect) await writeFile(join(evidence, `${name}-crop.png`), (await page.capturePage(rect)).toPNG())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${literal(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  const both = async (name, around) => {
    await capture(name, around)
    await theme("light")
    await capture(`${name}-light`, around)
    await theme("dark")
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const openSettings = async (query, section) => {
    await window.loadURL(`${base}?mock${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: ${literal(section)} })), true`)
  }
  const openAccount = (query) => openSettings(query, "account")
  const press = (selector) => evaluate(`(() => { const node = document.querySelector(${literal(selector)}); if (!node) throw new Error('Missing ' + ${literal(selector)}); node.click(); return true })()`)
  const DEVICES = '[data-testid="account-devices"]'
  /** A device's row as it reads, by its name. */
  const deviceRow = (name) => evaluate(`(() => { const label = [...document.querySelectorAll('${DEVICES} [data-device-name]')].find((each) => each.textContent === ${literal(name)}); return label ? label.closest('[data-device-row]').innerText.replace(/\\n+/g, '\\n') : null })()`)
  const pressIn = (name, label) => evaluate(`(() => { const row = [...document.querySelectorAll('${DEVICES} [data-device-name]')].find((each) => each.textContent === ${literal(name)}).closest('[data-device-row]'); [...row.querySelectorAll('button')].find((each) => each.innerText.trim() === ${literal(label)}).click(); return true })()`)

  // 1. Settings › Devices: every device of the account, this Mac first, each with its kind, system, Mako, health and how it joined.
  await openSettings("&cloud=signed-in&invited", "devices")
  await until(`document.querySelectorAll('${DEVICES} [data-device-joined]').length >= 6`, "the devices")
  const lines = await evaluate(`[...document.querySelectorAll('[data-device-joined]')].map((line) => line.textContent)`)
  assert.ok(lines.some((line) => /^Joined .+ from San Francisco, United States, through the browser$/.test(line)), JSON.stringify(lines))
  assert.ok(lines.some((line) => /^Joined .+ from Frankfurt, Germany, with a code you approved$/.test(line)), JSON.stringify(lines))
  const names = await evaluate(`[...document.querySelectorAll('${DEVICES} [data-device-name]')].map((each) => each.textContent)`)
  assert.equal(names[0], "Ada's MacBook Pro", "this Mac first")
  assert.match(await deviceRow("Ada's MacBook Pro"), /^Ada's MacBook Pro\nThis Mac\nMac · macOS 26\.0 · Mako 0\.4\.0\nOnline now/)
  assert.match(await deviceRow("build-box"), /^build-box\nLinux machine · x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now\nJoined .+ from Frankfurt, Germany, with a code you approved/)
  assert.match(await deviceRow("gpu-rig"), /\nLinux machine · x64 · Debian 13 · Mako 0\.4\.0\nQuiet since (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}[:.]\d{2}/)
  assert.match(await deviceRow("nas"), /^nas\nNeeds Mako's update\nLinux machine · arm64 · Alpine 3\.22 · Mako 0\.1\.37\nOnline now/)
  assert.match(await deviceRow("Studio"), /\nMac · macOS 15\.5 · Mako 0\.3\.9\nQuiet since /)
  assert.match(await deviceRow("ada-terminal"), /\nTerminal · Linux\nNever connected/)
  assert.deepEqual(
    await evaluate(`Object.fromEntries([...document.querySelectorAll('${DEVICES} [data-device-row]')].map((each) => [each.querySelector('[data-device-name]').textContent, each.dataset.deviceFamily]))`),
    { "Ada's MacBook Pro": "mac", "build-box": "machine", "gpu-rig": "machine", nas: "machine", Studio: "mac", "ada-terminal": "terminal" },
    "each kind its own mark"
  )
  // The section's own title says Devices, so the list doesn't say it again: Add a machine stands alone above it.
  assert.match(await evaluate(`document.querySelector('${DEVICES}').innerText`), /^Add a machine\n/)
  assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-note]').textContent`), "Removing a device signs it out within seconds, wherever it is.")
  await both("devices", [DEVICES])

  // Remove asks first, and says what stops: the device's sign-in, wherever it is.
  await pressIn("gpu-rig", "Remove")
  await until(`Boolean(document.querySelector('${DEVICES} [data-device-stops]'))`, "the confirmation")
  assert.match(await evaluate(`document.querySelector('${DEVICES} [data-device-stops]').textContent`), /^gpu-rig is signed out within seconds and can't be reached until it joins again\.$/)
  await both("device-remove-confirm", [DEVICES])
  await pressIn("gpu-rig", "Remove")
  await until(`![...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'gpu-rig')`, "the device removed")

  // Add a machine: the lines the guide gives, for the host and for a container, and what happens next.
  await press(`${DEVICES} [data-add-machine]`)
  await until(`Boolean(document.querySelector('[data-add-machine-sheet]'))`, "Add a machine")
  const commands = () => evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].map((each) => each.textContent)`)
  assert.deepEqual(await commands(), ["mako-host join --cloud http://127.0.0.1:8787", "mako-host"])
  assert.match(await evaluate(`document.querySelector('[data-add-machine-sheet]').innerText`), /watch and steer its Threads, and start new ones there[\s\S]*It prints a page and a code[\s\S]*approve it once the code matches[\s\S]*Waiting for a machine to join\s+Close$/)
  assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').dataset.machineWaiting`), "waiting")
  await both("add-machine", ["[data-machine-sheet]"])
  await evaluate(`([...document.querySelectorAll('[data-add-machine-sheet] button')].find((each) => each.innerText.trim() === 'Docker').click(), true)`)
  await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines")
  assert.deepEqual(await commands(), ["docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL=http://127.0.0.1:8787 mako-device", "docker logs -f mako-device"])
  // The container's long line wraps inside its box: nothing of it lies under Copy or past the edge.
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-machine-command] pre')].every((line) => line.scrollWidth <= line.clientWidth)`), true, "no line is cut")
  await both("add-machine-docker", ["[data-machine-sheet]"])

  // A machine joins while the sheet waits: the sheet says so as the account does, and no toast says it again.
  await evaluate(`(globalThis.makoMockAccount.join("render-box"), true)`)
  await until(`Boolean(document.querySelector('[data-machine-joined]'))`, "the joined machine")
  assert.match(await evaluate(`document.querySelector('[data-machine-sheet]').innerText`), /^render-box joined[\s\S]*render-box is a device of your account[\s\S]*A machine on Linux x64 · Ubuntu 24\.04, from Frankfurt, Germany, with a code you approved\. It's in your devices now\./)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.innerText.includes('joined your account'))`), false, "the sheet says it, not a toast as well")
  await both("add-machine-joined", ["[data-machine-sheet]"])
  await evaluate(`([...document.querySelectorAll('[data-machine-sheet] button')].find((each) => each.innerText.trim() === 'Done').click(), true)`)
  await until(`!document.querySelector('[data-machine-sheet]') && [...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'render-box')`, "the machine in the list")
  assert.match(await deviceRow("render-box"), /^render-box\nLinux machine · x64 · Ubuntu 24\.04 · Mako 0\.4\.0\nOnline now/)
  await both("devices-after-join", [DEVICES])

  // No machine comes: past a code's life the sheet stops saying it waits, and says how to try again.
  await openSettings("&cloud=signed-in&invited", "devices")
  await until(`document.querySelectorAll('${DEVICES} [data-device-joined]').length >= 6`, "the devices again")
  await press(`${DEVICES} [data-add-machine]`)
  await until(`document.querySelector('[data-machine-waiting]')?.dataset.machineWaiting === 'waiting'`, "the wait")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-machine-waiting] .shimmer-text'))`), true, "it shimmers while a code can still be confirmed")
  await evaluate(`(globalThis.makoMockAccount.lapse(), true)`)
  await until(`document.querySelector('[data-machine-waiting]')?.dataset.machineWaiting === 'lapsed'`, "the wait given up")
  assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').textContent`), "No machine yet. A code lasts 10 minutes, so run the join line again for a new one.")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-machine-sheet] .shimmer-text'))`), false, "nothing shimmers once nothing is on its way")
  await both("add-machine-no-machine", ["[data-machine-sheet]"])
  await evaluate(`([...document.querySelectorAll('[data-add-machine-sheet] button')].find((each) => each.innerText.trim() === 'Docker').click(), true)`)
  // In a container the code's end stopped it, and its name is taken: the words name the line that starts it again,
  // never the run line above, which can't run twice. The host's words stay.
  await until(`document.querySelector('[data-machine-command] pre').textContent.startsWith('docker run')`, "the container's lines, the wait given up")
  assert.equal(await evaluate(`document.querySelector('[data-machine-waiting]').textContent`), "No machine yet. A code lasts 10 minutes, so run docker start mako-device for a new one.")
  assert.equal(await evaluate(`document.querySelector('[data-machine-waiting] code').textContent`), "docker start mako-device", "set as a line to run")
  assert.match((await commands())[0], /--name mako-device /, "the container it starts is the one the run line named")
  await both("add-machine-no-machine-docker", ["[data-machine-sheet]"])

  // A machine that joins late still turns the sheet into what joined. Removing it fails: said in the sheet, where
  // Remove was pressed, with the machine still there, and not behind it.
  await evaluate(`(globalThis.makoMockAccount.join("render-box"), true)`)
  await until(`Boolean(document.querySelector('[data-machine-joined]'))`, "the late machine")
  await evaluate(`(globalThis.makoMockAccount.failRemovals(true), true)`)
  const pressInSheet = (label) => evaluate(`([...document.querySelectorAll('[data-machine-sheet] button')].find((each) => each.innerText.trim() === ${literal(label)}).click(), true)`)
  await pressInSheet("Not yours? Remove")
  await until(`Boolean(document.querySelector('[data-machine-sheet] [data-machine-remove-failed]'))`, "the failed removal, in the sheet")
  assert.equal(await evaluate(`document.querySelector('[data-machine-remove-failed]').textContent`), "render-box is still on your account: Mako Cloud couldn't be reached. Try again in a moment.")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-machine-joined]'))`), true, "the sheet still shows what joined")
  assert.equal(await evaluate(`Boolean(document.querySelector('${DEVICES} [data-device-remove-failed]'))`), false, "and the failure isn't said behind it as well")
  await both("add-machine-remove-failed", ["[data-machine-sheet]"])
  await evaluate(`(globalThis.makoMockAccount.failRemovals(false), true)`)
  await pressInSheet("Not yours? Remove")
  await until(`!document.querySelector('[data-machine-sheet]') && ![...document.querySelectorAll('${DEVICES} [data-device-name]')].some((each) => each.textContent === 'render-box')`, "the machine removed")

  // This Mac alone: nothing to remove, so the line under the list says what a machine is for.
  await openSettings("&cloud=signed-in&invited&devices=one", "devices")
  await until(`document.querySelectorAll('${DEVICES} [data-device-name]').length === 1`, "this Mac alone")
  assert.equal(await evaluate(`document.querySelector('${DEVICES} [data-devices-note]').textContent`), "Add a machine of your own, and Threads can run there while you watch and steer them from here.")
  await both("devices-one", [DEVICES])

  // A rail row on a machine of the person's own wears a server: a Mac's a laptop, the cloud's a cloud.
  {
    await window.loadURL(`${base}?mock&cloud=signed-in&invited&events&app=rail`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 300, theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('[data-thread-row]')) && Boolean(globalThis.makoMockHost)`, "the rail and the fixture's host")
    const now = Date.now()
    const listed = (id, title, elsewhere, extra) => ({
      session: { id, harness: "codex", cwd: "/Users/you/api", title, status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
      revision: 0,
      createdAt: now - 20 * 60_000,
      movedAt: now - 4 * 60_000,
      elsewhere,
      ...extra,
    })
    await evaluate(`(globalThis.makoMockHost.emit(${literal({
      type: "live-listed",
      summaries: [
        listed("7a1c3e5f-2b4d-4f6a-8c0e-1a3b5c7d9e01", "Rebuild the search index", "build-box", { elsewhereKind: "runtime" }),
        listed("7a1c3e5f-2b4d-4f6a-8c0e-1a3b5c7d9e02", "Bisect the upload timeout", "Studio", { elsewhereKind: "desktop" }),
        listed("7a1c3e5f-2b4d-4f6a-8c0e-1a3b5c7d9e03", "Reproduce the flaky upload", "a cloud machine", {}),
      ],
    })}), true)`)
    const mark = (title) => evaluate(`(() => { const row = [...document.querySelectorAll('[data-thread-row]')].find((each) => each.innerText.includes(${literal(title)})); return row ? { place: row.querySelector('[data-elsewhere]')?.dataset.elsewhere ?? null, tip: row.dataset.tip ?? null } : null })()`)
    await until(`[...document.querySelectorAll('[data-thread-row]')].some((each) => each.innerText.includes('Rebuild the search index'))`, "the machine's row")
    assert.deepEqual(await mark("Rebuild the search index"), { place: "machine", tip: "Rebuild the search index · on build-box" })
    assert.equal((await mark("Bisect the upload timeout")).place, "device")
    assert.equal((await mark("Reproduce the flaky upload")).place, "cloud")
    await evaluate(`([...document.querySelectorAll('[data-thread-row]')].filter((each) => /Rebuild the search index|Bisect the upload timeout|Reproduce the flaky upload/.test(each.innerText)).forEach((each) => each.setAttribute('data-place-row', '')), true)`)
    await both("rail-machine", ["[data-place-row]"])

    // Opened, its composer says where it runs: the machine's name under the same server, and no way to move it yet.
    await evaluate(`([...document.querySelectorAll('[data-thread-row]')].find((each) => each.innerText.includes('Rebuild the search index')).click(), true)`)
    await until(`Boolean(document.querySelector('[data-run-place="device"]'))`, "the open Thread's place")
    // Its name folds away in a narrow composer, so it's read as written, and from the chip's tip.
    assert.equal(await evaluate(`document.querySelector('[data-run-place="device"]').textContent.trim()`), "build-box")
    assert.equal(await evaluate(`document.querySelector('[data-run-place="device"]').title`), "Runs on build-box")
    assert.equal(await evaluate(`document.querySelector('[data-run-place="device"] [data-place]').dataset.place`), "machine")
    assert.equal(await evaluate(`document.querySelector('[data-run-place="device"]').tagName`), "SPAN", "it says where, and offers no move")
    await both("thread-machine", ['[data-run-place="device"]', "[data-place-row]"])
  }

  // Account no longer lists the devices: they're Settings › Devices.
  await openAccount("&cloud=signed-in&invited")

  // 2. The browsers signed in to the account: named, where each signed in and was last used, signed out when asked twice.
  await until(`document.querySelectorAll('[data-browser-name]').length === 3`, "the browsers")
  const browsers = () => evaluate(`[...document.querySelectorAll('[data-browser-name]')].map((name) => name.closest('.flex.items-center.gap-3').innerText.replace(/\\n+/g, '\\n'))`)
  const rows = await browsers()
  assert.match(rows[0], /^Chrome on macOS\nUsed now from San Francisco, United States\nSigned in .+ from San Francisco, United States, with GitHub/, rows[0])
  assert.match(rows[2], /^Firefox on Windows\nLast used 3 ?h(?:r|ours?)? ago from Osaka, Japan\nSigned in .+ from Tokyo, Japan, with GitHub/, rows[2])
  await evaluate(`document.querySelector('[data-testid="account-browsers"]').scrollIntoView({ block: 'center' }), true`)
  await both("browsers", ['[data-testid="account-browsers"]'])
  const click = (scope, label) => evaluate(`(() => { const button = [...document.querySelectorAll('${scope} button')].find((each) => each.innerText.trim() === ${literal(label)}); button.click(); return true })()`)
  await evaluate(`(() => { const row = [...document.querySelectorAll('[data-testid="account-browsers"] .flex.items-center.gap-3')].find((each) => each.innerText.startsWith('Firefox')); row.setAttribute('data-firefox', ''); return true })()`)
  await click("[data-firefox]", "Sign out")
  await until(`document.querySelector('[data-firefox]').innerText.includes('It will be signed out at once')`, "the confirmation")
  await both("browser-confirm", ['[data-testid="account-browsers"]'])
  await click("[data-firefox]", "Sign out")
  await until(`!document.querySelector('[data-firefox]') && document.querySelectorAll('[data-browser-name]').length === 2`, "one signed out")
  await click('[data-testid="account-browsers"]', "Sign out all")
  await until(`document.querySelectorAll('[data-testid="account-browsers"] .text-caution').length === 2`, "every row says it goes")
  await both("browsers-confirm-all", ['[data-testid="account-browsers"]'])
  await click('[data-testid="account-browsers"]', "Sign out 2 browsers")
  await until(`document.querySelector('[data-testid="account-browsers"]').innerText.includes('No browser is signed in to your account.')`, "none left")
  await both("browsers-none", ['[data-testid="account-browsers"]'])

  // 3. Signed out because the sign-in was used from somewhere else: said, with Sign in.
  await openAccount("&cloud=reused")
  await until(`document.body.innerText.includes('used from somewhere else')`, "the reused notice")
  assert.match(await evaluate(`document.querySelector('[role="dialog"] main').innerText`), /This Mac was signed out[\s\S]*used from somewhere else[\s\S]*Sign in/)
  await both("signed-out-reused", ['[role="dialog"] main'])
  // 4. A device joins while this Mac is open: said at once, with Remove.
  await window.loadURL(`${base}?mock&cloud=signed-in&invited&joined`)
  // Other fixture toasts can precede this one; wait for and read the same device's alert.
  const joinedToast = `[...document.querySelectorAll('[data-sonner-toast]')].find((node) => node.querySelector('[data-title]')?.textContent === 'render-box joined your account')`
  await until(`Boolean(${joinedToast})`, "the joined alert")
  const alert = await evaluate(`(() => { const node = ${joinedToast}; node.setAttribute('data-device-joined-toast', ''); return node.innerText })()`)
  await writeFile(join(evidence, "joined-toasts.json"), JSON.stringify(await evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].map(node => ({ joined: node.hasAttribute('data-device-joined-toast'), words: node.innerText }))`), null, 2))
  assert.match(alert, /A machine on Linux x64 · Ubuntu 24\.04, from Frankfurt, Germany, with a code you approved\. If it isn't yours, remove it\./)
  assert.match(alert, /Remove/)
  showToasts = true
  await both("device-joined", ['[data-device-joined-toast]'])
  console.log("Account devices UI: every device with its kind, health and joining, removal asked with what stops, a machine added and said as it joins, a machine's rail row marked, the browsers named, placed and signed out one or all, a reused sign-in's sign-out said, a device that joins said at once")
  clearTimeout(watchdog)
  app.exit(0)
}
