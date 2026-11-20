// Browser control on Windows, end to end against the machine's own Chrome and Edge (a hosted windows-latest runner has
// both). After `npm run build:control-runtime`, `tsgo -b tsconfig.electron.json` and `npm run build:browser-extension`:
//
//   node scripts/test-browser-windows.mjs [--json results.json]
//
//   1. Discovery: App Paths and install folders find Chrome and Edge, each with its version and user data; the
//      settings list shows each as a browser to set up.
//   2. Extension setup writes a launcher and manifest per browser and points HKCU's NativeMessagingHosts key for
//      Chrome and Edge at them.
//   3. Each browser, started with the Mako Browser extension, launches the native host through its registry key: the
//      host registers the profile with the browser's own executable, Mako connects to it, and page control (navigate,
//      observe, click, type, read, a dialog) runs over native messaging. No console window opens for the host.
//   4. The machine browser on Windows: Chrome headless in Mako's profile, its capture extension loaded over the
//      DevTools pipe, attached over CDP, page control, then closed with its whole process tree.
//   5. Removing the setup deletes the registry keys and launchers it wrote.
//
// The tab's live video through the capture extension is `scripts/test-machine-tab-video.mjs` with
// MAKO_TEST_BROWSER_EXECUTABLE set; this script prints the latencies each step took.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { BrowserService } from "../packages/control-runtime/dist/browser-service.js"
import { BrowserCommandSchema, BrowserTargetSchema } from "../packages/control-runtime/dist/contracts/browser-control.js"
import { extensionBrowsers } from "../packages/control-runtime/dist/browser-extension-registration.js"
import { parseAppPaths } from "../packages/control-runtime/dist/browser-installed-windows.js"
import {
  InstalledBrowsers,
  MACHINE_BROWSER_ID,
  MachineBrowser,
  localBrowsers,
  windowsInstalledChromium,
  windowsMachineChromium,
  writeMachineCaptureExtension,
} from "../packages/control-runtime/dist/desktop.js"
import { prepareBrowserExtension, removeBrowserExtension } from "../packages/host/dist/control/browser-extension-setup.js"
import { windowsLauncher } from "../packages/host/dist/control/browser-extension-windows.js"

assert.equal(process.platform, "win32", "this checks Windows")
const run = promisify(execFile)
const repo = resolve(fileURLToPath(import.meta.url), "../..")
const output = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined
const results = { steps: {}, latencies: {} }
const ms = (started) => Math.round(performance.now() - started)
const wait = (delay) => new Promise((done) => setTimeout(done, delay))
async function until(read, what, timeout = 30_000) {
  for (const deadline = Date.now() + timeout; ; await wait(50)) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
  }
}
const powershell = async (script) => (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 4 << 20 })).stdout.trim()
/** Every process whose command line names `text`, as WMI reports it. */
async function processesNaming(text) {
  const out = await powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${text.replaceAll("'", "''")}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`)
  return out ? out.split(/\r?\n/).filter((line) => !/powershell/i.test(line)) : []
}

// 1. Discovery.
assert.deepEqual(
  Object.fromEntries(parseAppPaths([
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe",
    "    (Standard)    REG_EXPAND_SZ    \"%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe\"",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\notes.exe",
    "    (Default)    REG_SZ    notes.exe",
  ].join("\r\n"), { LOCALAPPDATA: "C:\\Users\\a b\\AppData\\Local" })),
  {
    "chrome.exe": ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    "brave.exe": ["C:\\Users\\a b\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  },
  "App Paths' default values, localized, quoted or with variables, name each executable"
)
let started = performance.now()
const installed = await windowsInstalledChromium()
results.latencies.discoveryMs = ms(started)
results.steps.discovery = installed.map(({ browser, executable, version, userData, profiles }) => ({ product: browser.product, executable, version, userData, profiles }))
for (const product of ["Google Chrome", "Microsoft Edge"]) {
  const found = installed.find(({ browser }) => browser.product === product)
  assert.ok(found, `${product} is found: ${JSON.stringify(results.steps.discovery)}`)
  assert.match(found.version ?? "", /^\d+\.\d+\.\d+\.\d+$/, `${product}'s version is read`)
  assert.ok(existsSync(found.executable))
}
started = performance.now()
const listed = await new InstalledBrowsers().list()
results.latencies.settingsListMs = ms(started)
for (const product of ["Google Chrome", "Microsoft Edge"])
  assert.ok(listed.some((browser) => browser.product === product && browser.setupRequired && browser.transport === "extension"), `the settings list offers ${product}`)
const chrome = installed.find(({ browser }) => browser.product === "Google Chrome").executable
const edge = installed.find(({ browser }) => browser.product === "Microsoft Edge").executable
console.log(`discovery: ${installed.map(({ browser, version }) => `${browser.product} ${version}`).join(", ")} in ${results.latencies.discoveryMs} ms`)

// A launcher names paths with spaces and percent signs, and switches to UTF-8 only for a path outside ASCII.
const launcher = windowsLauncher({ node: "C:\\Program Files\\Mako\\Mako.exe", entry: "C:\\a%b\\entry.js", product: "Google Chrome", application: "C:\\x.exe", userData: "C:\\Users\\Zoë\\Data" })
assert.match(launcher, /^@echo off\r\nchcp 65001 >nul\r\n/)
assert.match(launcher, /\r\n"C:\\Program Files\\Mako\\Mako\.exe" "C:\\a%%b\\entry\.js" %\*\r\n$/)
assert.doesNotMatch(windowsLauncher({ node: "C:\\n.exe", entry: "C:\\e.js", product: "Microsoft Edge", application: "C:\\x.exe" }), /chcp/)

// 2. Extension setup: the native host is Electron as Node, as a packaged Mako's own executable runs it.
const electron = join(repo, "node_modules", "electron", "dist", "electron.exe")
assert.ok(existsSync(electron), "Electron's binary is installed")
assert.ok(existsSync(join(repo, "dist-electron", "browser-native-host-entry.js")), "the native host is built")
const home = homedir()
await removeBrowserExtension(home)
started = performance.now()
const setup = await prepareBrowserExtension(repo, electron, home)
results.latencies.setupMs = ms(started)
const keys = {}
for (const [product, vendor] of [["Google Chrome", "Google\\Chrome"], ["Microsoft Edge", "Microsoft\\Edge"]]) {
  const { stdout } = await run("reg", ["query", `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\dev.mako.browser`, "/ve"])
  const manifestPath = /REG_SZ\s+(.+?)\s*$/m.exec(stdout)?.[1]
  assert.ok(manifestPath?.startsWith(join(home, ".mako", "bin")), `${product}'s key names Mako's manifest: ${stdout}`)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  assert.equal(manifest.name, "dev.mako.browser")
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${setup.extensionId}/`])
  assert.match(manifest.path, /\.cmd$/)
  const text = await readFile(manifest.path, "utf8")
  assert.ok(text.includes(`MAKO_BROWSER_PRODUCT=${product}`), text)
  keys[product] = { manifestPath, launcher: manifest.path }
}
results.steps.setup = { directory: setup.directory, extensionId: setup.extensionId, keys }
console.log(`setup: registry keys for Chrome and Edge in ${results.latencies.setupMs} ms`)

// 3. Each browser with the extension, through its own registry key.
const fixtureSaves = []
const page = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/save") {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    fixtureSaves.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.end("ok")
    return
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Windows fixture</title>
    <h1>Mako on Windows</h1>
    <input aria-label="Proof" style="position:absolute;left:0;top:60px;width:200px;height:40px">
    <button style="position:absolute;left:0;top:120px">Save</button>
    <script>window.trusted=false;document.querySelector('input').oninput=e=>window.trusted=e.isTrusted;
    document.querySelector('button').onclick=()=>{if(confirm('Save this value?'))fetch('/save',{method:'POST',body:JSON.stringify({value:document.querySelector('input').value})})}</script>`)
})
await new Promise((done) => page.listen(0, "127.0.0.1", done))
const origin = `http://127.0.0.1:${page.address().port}`
const registrations = join(home, ".mako", "browser-extension")

/** Starts a browser on a fresh profile with the extension: Edge by its flag, Chrome (which ignores it) over the pipe. */
async function startWithExtension(executable, profile, viaPipe) {
  const args = [
    `--user-data-dir=${profile}`,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    ...(viaPipe ? ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging"] : [`--load-extension=${setup.directory}`]),
    "about:blank",
  ]
  const child = spawn(executable, args, { stdio: viaPipe ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"], windowsHide: true })
  child.stderr.resume()
  if (viaPipe) {
    const reply = new Promise((done) => {
      let text = ""
      child.stdio[4].on("data", (chunk) => {
        text += chunk
        if (text.includes("\0")) done(JSON.parse(text.slice(0, text.indexOf("\0"))))
      })
    })
    child.stdio[3].write(`${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: setup.directory } })}\0`)
    const loaded = await reply
    assert.equal(loaded.result?.id, setup.extensionId, `the extension loads: ${JSON.stringify(loaded)}`)
  }
  return child
}

const endTree = (pid) => run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {})

for (const [product, executable, viaPipe] of [["Microsoft Edge", edge, false], ["Google Chrome", chrome, true]]) {
  const profile = await mkdtemp(join(tmpdir(), "mako-windows-extension-"))
  const before = new Set(await readdir(registrations).catch(() => []))
  const launched = performance.now()
  const child = await startWithExtension(executable, profile, viaPipe)
  const name = await until(async () => (await readdir(registrations).catch(() => [])).find((file) => file.endsWith(".json") && !before.has(file)), `${product}'s native host to register`)
  const registeredMs = ms(launched)
  const registration = JSON.parse(await readFile(join(registrations, name), "utf8"))
  assert.equal(registration.applicationPath?.toLowerCase(), executable.toLowerCase(), "the host names the browser that started it")
  assert.equal(registration.product, product)
  // The host runs as Electron's Node under the hidden cmd.exe the browser started: neither has a window.
  // When each started: the browser's cmd.exe, the host in it, and the registration it wrote once the extension said hello.
  const windows = await powershell(`$h=Get-CimInstance Win32_Process -Filter "ProcessId=${registration.pid}"; $c=Get-CimInstance Win32_Process -Filter "ProcessId=$($h.ParentProcessId)"; $hp=Get-Process -Id $h.ProcessId; $cp=Get-Process -Id $c.ProcessId; "$($h.Name) $($hp.MainWindowHandle) $($c.Name) $($cp.MainWindowHandle) $($cp.StartTime.ToUniversalTime().ToString('o')) $($hp.StartTime.ToUniversalTime().ToString('o'))"`)
  assert.match(windows, /^electron\.exe 0 cmd\.exe 0 /, `the host and its cmd.exe have no window: ${windows}`)
  const [cmdStarted, hostStarted] = windows.split(" ").slice(4).map(Date.parse)
  const registeredAt = (await stat(join(registrations, name))).mtimeMs
  const host = { cmdToHostMs: Math.round(hostStarted - cmdStarted), hostToRegisteredMs: Math.round(registeredAt - hostStarted) }

  // Mako's own discovery: the connected profile takes the place of the browser to set up.
  started = performance.now()
  const found = await localBrowsers(new InstalledBrowsers())
  const listMs = ms(started)
  const connected = found.find((browser) => browser.id === registration.id)
  assert.ok(connected, `the extension's profile is listed: ${JSON.stringify(found.map(({ id, name }) => ({ id, name })))}`)
  assert.equal(connected.applicationPath.toLowerCase(), executable.toLowerCase())
  assert.ok(!found.some((browser) => browser.setupRequired && browser.applicationPath?.toLowerCase() === executable.toLowerCase()), "the set-up entry gives way to the connected profile")
  assert.ok((await extensionBrowsers()).some((browser) => browser.id === registration.id))

  const service = new BrowserService(() => found)
  const timings = []
  const command = async (input) => {
    const at = performance.now()
    try {
      return await service.execute("windows", BrowserCommandSchema.parse(input), AbortSignal.timeout(30_000))
    } finally {
      timings.push({ action: input.action, ms: ms(at) })
    }
  }
  try {
    await command({ action: "connect", browser: registration.id })
    const target = BrowserTargetSchema.parse(await command({ action: "open", browser: registration.id, disposition: "window" }))
    const navigated = await command({ action: "navigate", target, url: origin })
    assert.ok(!navigated.navigation?.fault, JSON.stringify(navigated))
    const view = await command({ action: "observe", target })
    assert.ok(view.nodes.some((node) => node.role === "heading" && node.name === "Mako on Windows"), "observe reads the page")
    const textbox = view.nodes.find((node) => node.role === "textbox").ref
    await command({ action: "click", target, at: { ref: textbox } })
    await command({ action: "type", target, ref: textbox, text: "東京 🐟 windows", clear: true })
    const typed = await command({ action: "evaluate", target, expression: '({ value: document.querySelector("input").value, trusted: window.trusted })' })
    assert.deepEqual(typed.result.value, { value: "東京 🐟 windows", trusted: true })
    await command({ action: "dialog", target, auto: "accept" })
    const count = fixtureSaves.length
    await command({ action: "click", target, at: { ref: view.nodes.find((node) => node.role === "button" && node.name === "Save").ref } })
    await until(() => fixtureSaves.length > count, "the page's save")
    assert.deepEqual(fixtureSaves.at(-1), { value: "東京 🐟 windows" })
    const shot = await command({ action: "screenshot", target })
    assert.ok(JSON.stringify(shot).length > 1000, "a screenshot comes back")
    // A round trip through native messaging: Mako to the host's socket, the host to the extension and back.
    const samples = []
    for (let i = 0; i < 25; i++) {
      const at = performance.now()
      await command({ action: "evaluate", target, expression: "1" })
      samples.push(performance.now() - at)
    }
    samples.sort((a, b) => a - b)
    await command({ action: "close", target })
    const key = product === "Google Chrome" ? "chrome" : "edge"
    results.latencies[`${key}Extension`] = {
      launchToRegisteredMs: registeredMs,
      ...host,
      discoveryWithProfileMs: listMs,
      actions: timings.slice(0, 11),
      evaluateRoundTripMs: { p50: Math.round(samples[12] * 10) / 10, p95: Math.round(samples[23] * 10) / 10 },
    }
    console.log(`${product}: native host registered ${registeredMs} ms after the browser's launch (cmd.exe to host ${host.cmdToHostMs} ms, host start to registered ${host.hostToRegisteredMs} ms); ${timings.slice(0, 11).map(({ action, ms }) => `${action} ${ms}`).join(", ")} ms; evaluate p50 ${samples[12].toFixed(1)} ms`)
  } finally {
    service.close()
    // The browser process alone, as when it quits or crashes: what it started notices on its own.
    child.kill()
  }
  try {
    // With the browser gone, the host's pipe closes, and it removes its registration and exits.
    await until(() => !existsSync(join(registrations, name)), `${product}'s registration to be removed`)
    await until(async () => (await processesNaming(profile)).length === 0, `${product}'s processes to end`)
    await until(() => { try { process.kill(registration.pid, 0); return false } catch { return true } }, "the native host to exit")
  } finally {
    if (child.exitCode === null && child.signalCode === null) await endTree(child.pid)
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10 })
}
results.steps.extension = "passed"

// 4. The machine browser: Chrome (or Edge) headless in Mako's profile, attached over CDP.
const machineExecutable = windowsMachineChromium()
assert.equal(machineExecutable?.toLowerCase(), chrome.toLowerCase(), "the machine browser is Chrome where it's installed")
const script = await readFile(join(repo, "packages/host/dist/control/machine-capture.page.mjs"), "utf8")
for (const [product, executable] of [["Google Chrome", chrome], ["Microsoft Edge", edge]]) {
  const root = await mkdtemp(join(tmpdir(), "mako machine browser "))
  const profile = join(root, "machine browser")
  const machine = new MachineBrowser({
    executable,
    profile,
    extensionLoading: "pipe",
    captureExtension: () => writeMachineCaptureExtension(join(root, "capture"), script),
  })
  const service = new BrowserService(() => [machine.definition])
  const timings = []
  const command = async (input) => {
    const at = performance.now()
    try {
      return await service.execute("windows", BrowserCommandSchema.parse(input), AbortSignal.timeout(60_000))
    } finally {
      timings.push({ action: input.action, ms: ms(at) })
    }
  }
  try {
    started = performance.now()
    await command({ action: "connect", browser: MACHINE_BROWSER_ID })
    const attachMs = ms(started)
    const { navigation, ...opened } = await command({ action: "open", browser: MACHINE_BROWSER_ID, url: origin })
    assert.ok(!navigation?.fault)
    const target = BrowserTargetSchema.parse(opened)
    const tabs = await command({ action: "tabs", browser: MACHINE_BROWSER_ID })
    const { key: captureKey } = JSON.parse(await readFile(join(root, "capture", "manifest.json"), "utf8"))
    const captureId = createHash("sha256").update(Buffer.from(captureKey, "base64")).digest("hex").slice(0, 32).replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    assert.ok(tabs.every((tab) => !tab.url.startsWith(`chrome-extension://${captureId}/`)), "the capture extension's pages are no tabs")
    const view = await command({ action: "observe", target })
    const textbox = view.nodes.find((node) => node.role === "textbox").ref
    await command({ action: "click", target, at: { ref: textbox } })
    await command({ action: "type", target, ref: textbox, text: "machine", clear: true })
    const typed = await command({ action: "evaluate", target, expression: 'document.querySelector("input").value' })
    assert.equal(typed.result.value, "machine")
    await command({ action: "navigate", target, url: `${origin}/again` })
    results.latencies[`machine ${product}`] = { connectAndLaunchMs: attachMs, actions: timings.slice(1) }
    console.log(`machine browser ${product}: launched and attached over CDP in ${attachMs} ms; ${timings.slice(1).map(({ action, ms }) => `${action} ${ms}`).join(", ")} ms`)
  } finally {
    service.close()
    machine.close()
  }
  await until(async () => (await processesNaming(profile)).length === 0, `every ${product} process of the machine profile to end`, 15_000)
  await rm(root, { recursive: true, force: true, maxRetries: 10 })
}
results.steps.machineBrowser = "passed"

// 5. Removal.
await removeBrowserExtension(home)
for (const vendor of ["Google\\Chrome", "Microsoft\\Edge"])
  await assert.rejects(run("reg", ["query", `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\dev.mako.browser`, "/ve"]), `${vendor}'s key is gone`)
for (const { launcher, manifestPath } of Object.values(keys)) {
  assert.ok(!existsSync(launcher))
  assert.ok(!existsSync(manifestPath))
}
results.steps.removal = "passed"
page.close()
if (output) await writeFile(output, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results.latencies, null, 2))
console.log("Windows browser control passed")
