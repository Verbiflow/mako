import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { existsSync, openSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

/**
 * The Windows installer as a person meets it, on a disposable Windows machine (the release workflow's runner): installed
 * silently for this user, launched, its window and its host looked for, its login item, `mako:` scheme and power
 * helper checked, measured idle, closed, and uninstalled with nothing of it left behind but the person's data.
 *
 *   node scripts/smoke-windows-install.mjs <Mako-Setup-x64.exe> [--evidence <directory>] [--require-host]
 *
 * What needs the host (the window, which shows only once its host answers; the host's process and `/health`; a second
 * launch handing over; closing the window leaving the host) is reported, and required with `--require-host`: until the
 * host runs on Windows (on main it refuses its folder and listens on a Unix socket), the desktop shows "Mako could not
 * attach to its shared host" instead.
 * Writes `<evidence>/smoke.json` with the installer's size, the install and uninstall times, the cold start, and idle
 * memory and CPU.
 */
const run = promisify(execFile)
const args = process.argv.slice(2)
const installer = resolve(args[0] ?? "")
assert.equal(process.platform, "win32", "This installs Mako on this Windows machine; run it on a disposable one")
assert.ok(args[0] && existsSync(installer), "Usage: node scripts/smoke-windows-install.mjs <installer.exe> [--evidence <directory>] [--require-host]")
const evidence = resolve(args.includes("--evidence") ? args[args.indexOf("--evidence") + 1] : "smoke-evidence")
const requireHost = args.includes("--require-host")
await mkdir(evidence, { recursive: true })
const local = process.env.LOCALAPPDATA
const appData = process.env.APPDATA
assert.ok(local && appData, "LOCALAPPDATA and APPDATA are a Windows user's")
const installDirectory = join(local, "Programs", "Mako")
const executable = join(installDirectory, "Mako.exe")
const report = { installer, installerBytes: (await stat(installer)).size, checks: {} }
/** `needsHost`: a check that can pass only once the host runs on Windows; reported, and required with `--require-host`. */
const check = (name, ok, detail, needsHost = false) => {
  report.checks[name] = { ok, needsHost, ...(detail !== undefined && { detail }) }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`)
}

/** One PowerShell script, passed encoded so nothing in it is quoted twice. */
async function powershell(script, timeout = 60_000) {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout, maxBuffer: 16 * 2 ** 20 })
  return stdout.trim()
}
/** Every Mako.exe running, with its command line, working set and CPU so far. */
async function makoProcesses() {
  const text = await powershell(`
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'Mako.exe'"
    @($procs | ForEach-Object {
      $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($p) { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; command = $_.CommandLine; workingSet = $p.WorkingSet64; private = $p.PrivateMemorySize64; cpuMs = $p.TotalProcessorTime.TotalMilliseconds; window = [int64]$p.MainWindowHandle; title = $p.MainWindowTitle } }
    }) | ConvertTo-Json -Depth 3 -Compress`)
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}
const registryValue = (key, name) => powershell(`(Get-ItemProperty -Path '${key}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'`)
const registryKey = (key) => powershell(`Test-Path '${key}'`).then((text) => text === "True")
const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
const SCHEME_KEY = "HKCU:\\Software\\Classes\\mako"
/** Where each Chromium browser looks for native-messaging hosts under HKCU\Software. */
const BROWSER_HOSTS = ["Google\\Chrome", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser", "Chromium", "Vivaldi", "TheBrowserCompany\\Arc"]

try {
  assert.ok(!existsSync(executable), `Mako is already installed at ${installDirectory}: run this on a machine without it`)

  // Installed as a person double-clicking it would, without the clicks: per user, no administrator.
  let began = performance.now()
  await run(installer, ["/S"], { timeout: 300_000 })
  report.installMs = Math.round(performance.now() - began)
  check("installed per user", existsSync(executable) && existsSync(join(installDirectory, "resources", "app.asar")), installDirectory)
  const feed = await readFile(join(installDirectory, "resources", "app-update.yml"), "utf8").catch(() => "")
  check("update feed", /provider: github/.test(feed) && /repo: mako/.test(feed), feed.trim().split("\n").join("; "))
  const uninstall = (await powershell(`Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Mako*' } | Select-Object -First 1 -ExpandProperty UninstallString`)).trim()
  check("in Installed apps", uninstall.length > 0, uninstall)
  // Reported, not required: a build without signing credentials is unsigned on purpose.
  report.signature = await powershell(`$s = Get-AuthenticodeSignature '${executable}'; "$($s.Status) $($s.SignerCertificate.Subject)"`)
  console.log(`signature: ${report.signature}`)
  report.installedBytes = Number(await powershell(`(Get-ChildItem -Recurse -File '${installDirectory}' | Measure-Object -Sum Length).Sum`))

  // Cold start: launched, until its window is on screen, and until its host answers.
  began = performance.now()
  const output = openSync(join(evidence, "desktop-output.log"), "w")
  const app = spawn(executable, [], { detached: true, stdio: ["ignore", output, output], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1", MAKO_RUNTIME_TRACE: "1" } })
  app.once("exit", (code, signal) => { report.firstDesktopExit = { code, signal, afterMs: Math.round(performance.now() - began) } })
  app.unref()
  const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      $w = Get-Process -Name Mako -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($w -and $w.MainWindowTitle -eq 'Mako') { Write-Output ("window " + $w.MainWindowTitle); exit 0 }
      if ($w -and $w.MainWindowTitle -ne $last) { $last = $w.MainWindowTitle; [Console]::Error.WriteLine("a window: " + $last) }
      Start-Sleep -Milliseconds 100
    }
    Write-Output "timeout"`], { stdio: ["ignore", "pipe", "inherit"] })
  const shown = await new Promise((done) => createInterface({ input: watcher.stdout }).once("line", (line) => done(line)))
  report.coldStartWindowMs = Math.round(performance.now() - began)
  check("window shows", shown === "window Mako", shown, true)

  // The host: Mako.exe again, as Node, on the bundled host entry; then its /health on the transport the desktop uses.
  let host
  for (let tries = 0; tries < 100 && !host; tries++) {
    host = (await makoProcesses()).find((entry) => /dist-electron[\\/]host[\\/]entry\.js/.test(entry.command ?? ""))
    if (!host) await delay(200)
  }
  report.hostProcessMs = Math.round(performance.now() - began)
  check("host process starts", Boolean(host), host?.command, true)
  const health = await hostHealth(began)
  report.hostHealthMs = health.ms
  check("host answers health", health.ok, health.detail, true)
  if (requireHost) assert.ok(health.ok, `The host never answered: ${health.detail}`)

  await delay(2_000)
  await powershell(`
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save('${join(evidence, "window.png")}')`).catch((error) => console.warn(`screenshot: ${error.message}`))

  // What the first launch registered: the login item, hidden at sign-in, and the `mako:` scheme.
  const login = await registryValue(RUN_KEY, "Mako")
  check("login item", login.includes("Mako.exe") && login.includes("--at-login"), login)
  const scheme = await registryValue(`${SCHEME_KEY}\\shell\\open\\command`, "(default)")
  check("mako: scheme", scheme.includes("Mako.exe"), scheme)

  // A second launch hands over to the first and leaves: one window still.
  const second = spawn(executable, ["mako://thread/smoke"], { stdio: "ignore" })
  const secondExit = await Promise.race([new Promise((done) => second.once("exit", done)), delay(20_000).then(() => "running")])
  await delay(1_000)
  const windows = (await makoProcesses()).filter((entry) => entry.window !== 0)
  check("second launch hands over", secondExit !== "running" && windows.length === 1, { exit: secondExit, windows: windows.length }, true)

  // The power helper the host runs while agents work: Electron's powerSaveBlocker, held and let go.
  report.keepAwake = await keepAwake()
  check("keep-awake helper", report.keepAwake.ok, report.keepAwake)

  // Idle: thirty seconds settled, then CPU over ten more, across every Mako.exe.
  await delay(30_000)
  const first = await makoProcesses()
  await delay(10_000)
  const second2 = await makoProcesses()
  const cpuMs = second2.reduce((sum, entry) => sum + entry.cpuMs, 0) - first.reduce((sum, entry) => sum + entry.cpuMs, 0)
  report.idle = {
    processes: second2.length,
    workingSetMB: Math.round(second2.reduce((sum, entry) => sum + entry.workingSet, 0) / 2 ** 20),
    privateMB: Math.round(second2.reduce((sum, entry) => sum + entry.private, 0) / 2 ** 20),
    cpuPercentOfOneCore: Number(((cpuMs / 10_000) * 100).toFixed(2)),
    byProcess: second2.map((entry) => ({ pid: entry.pid, role: role(entry.command), workingSetMB: Math.round(entry.workingSet / 2 ** 20), command: (entry.command ?? "").slice(0, 240) })),
  }
  console.log(`idle: ${JSON.stringify(report.idle)}`)

  // Closing the window closes the desktop; its host stays for agents, as "Quit and keep agents running" leaves it.
  const desktop = (await makoProcesses()).find((entry) => entry.window !== 0)
  await powershell(`Get-Process -Name Mako | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`)
  let left = []
  for (let tries = 0; tries < 75; tries++) {
    left = await makoProcesses()
    if (!left.some((entry) => entry.pid === desktop?.pid)) break
    await delay(200)
  }
  check("closing the window closes the desktop", Boolean(desktop) && !left.some((entry) => entry.pid === desktop?.pid), { desktop: desktop?.pid }, true)
  check("its host stays", left.some((entry) => role(entry.command) === "host"), left.map((entry) => `${entry.pid} ${role(entry.command)}`), true)

  // Browser control's native-messaging registrations, made here as browser control would where it hasn't: the
  // uninstaller removes every one, and the wrapper and manifest files beside them.
  const nativeHosts = BROWSER_HOSTS.map((browser) => `HKCU:\\Software\\${browser}\\NativeMessagingHosts\\dev.mako.browser`)
  const bin = join(process.env.USERPROFILE ?? "", ".mako", "bin")
  await powershell(`
    New-Item -ItemType Directory -Force -Path '${bin}' | Out-Null
    Set-Content -Path '${join(bin, "mako-browser-host-smoke.cmd")}' -Value '@echo off'
    Set-Content -Path '${join(bin, "dev.mako.browser-smoke.json")}' -Value '{}'
    ${nativeHosts.map((key) => `if (-not (Test-Path '${key}')) { New-Item -Force -Path '${key}' | Out-Null; Set-ItemProperty -Path '${key}' -Name '(default)' -Value '${join(bin, "dev.mako.browser-smoke.json")}' }`).join("\n    ")}`)
  check("native-messaging registrations present before uninstall", (await Promise.all(nativeHosts.map(registryKey))).every(Boolean))

  // Uninstalled silently: the app, its processes (the host's too), its login item and scheme; the person's data stays.
  began = performance.now()
  await run(join(installDirectory, "Uninstall Mako.exe"), ["/S"], { timeout: 300_000 })
  // The uninstaller copies itself out and returns before its copy has finished.
  for (let tries = 0; tries < 150 && existsSync(executable); tries++) await delay(200)
  report.uninstallMs = Math.round(performance.now() - began)
  check("app removed", !existsSync(executable))
  check("no Mako.exe left running", (await makoProcesses()).length === 0)
  check("login item removed", !(await registryValue(RUN_KEY, "Mako")))
  check("mako: scheme removed", !(await registryKey(SCHEME_KEY)))
  const remaining = []
  for (const key of nativeHosts) if (await registryKey(key)) remaining.push(key)
  check("native-messaging registrations removed", remaining.length === 0, remaining)
  check("native-messaging files removed", !existsSync(join(bin, "mako-browser-host-smoke.cmd")) && !existsSync(join(bin, "dev.mako.browser-smoke.json")))
  check("person's data kept", existsSync(join(appData, "Mako")))
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  console.error(report.error)
} finally {
  // The app's and its host's logs, for what a failed start said.
  // A desktop that left without a word: what Windows recorded of it.
  await powershell(`Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddHours(-1) } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Mako' } | Select-Object -First 10 TimeCreated, Id, ProviderName, Message | Format-List | Out-File '${join(evidence, "application-events.txt")}'`).catch(() => undefined)
  await powershell(`Get-ChildItem -Recurse -File '${join(appData, "mako-ui-desktop", "Crashpad")}' -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-File '${join(evidence, "crashpad.txt")}'`).catch(() => undefined)
  for (const [folder, prefix] of [[join(appData, "Mako"), "data"], [join(appData, "mako-ui-desktop"), "desktop"]])
    await powershell(`Get-ChildItem -Recurse -File -Include *.log, *.json '${folder}' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'logs|crashes' } | ForEach-Object { Copy-Item $_.FullName (Join-Path '${evidence}' ('${prefix}-' + $_.Directory.Name + '-' + $_.Name)) }`).catch(() => undefined)
  await writeFile(join(evidence, "smoke.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ installerMB: +(report.installerBytes / 2 ** 20).toFixed(1), installedMB: report.installedBytes && +(report.installedBytes / 2 ** 20).toFixed(1), installMs: report.installMs, coldStartWindowMs: report.coldStartWindowMs, hostProcessMs: report.hostProcessMs, hostHealthMs: report.hostHealthMs, idle: report.idle && { workingSetMB: report.idle.workingSetMB, privateMB: report.idle.privateMB, cpu: report.idle.cpuPercentOfOneCore }, uninstallMs: report.uninstallMs }))
}
const failed = Object.entries(report.checks).filter(([, result]) => !result.ok && (requireHost || !result.needsHost))
if (report.error || failed.length) {
  console.error(`Failed: ${[...failed.map(([name]) => name), ...(report.error ? ["error"] : [])].join(", ")}`)
  process.exit(1)
}

function role(command = "") {
  if (/--keep-awake/.test(command)) return "keep-awake"
  if (/dist-electron[\\/]host[\\/]entry\.js/.test(command)) return "host"
  if (/--type=/.test(command)) return command.match(/--type=([\w-]+)/)?.[1] ?? "child"
  return "desktop"
}

/** The host's `/health`, asked the way the desktop asks it (`probeRuntime`), until it answers or a minute passes. */
async function hostHealth(began) {
  const connection = new URL("../packages/host/dist/transport/connection.js", import.meta.url)
  const service = new URL("../packages/host/dist/transport/service.js", import.meta.url)
  if (!existsSync(connection) || !existsSync(service)) return { ok: false, detail: "this checkout's host isn't built" }
  const { probeRuntime } = await import(connection.href)
  const { runtimeDataRoot, runtimeLocation } = await import(service.href)
  const socket = runtimeLocation(runtimeDataRoot(appData, {})).socket
  let last = "no answer"
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await delay(500)) {
    try {
      const probe = await probeRuntime(socket, { timeoutMs: 2_000 })
      if (probe.state === "ready") return { ok: true, ms: Math.round(performance.now() - began), detail: `${socket}: ready, version ${probe.info.version ?? "?"}` }
      last = `${socket}: ${probe.state}`
    } catch (error) {
      last = `${socket}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { ok: false, detail: last }
}

/** `Mako.exe --keep-awake`, as the host runs it: says where the power comes from, holds, shows in powercfg, lets go, leaves. */
async function keepAwake() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const helper = spawn(executable, ["--keep-awake"], { stdio: ["pipe", "pipe", "pipe"], env })
  const lines = []
  let stderr = ""
  helper.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000) })
  const waiting = new Set()
  createInterface({ input: helper.stdout }).on("line", (line) => {
    lines.push(line)
    for (const look of waiting) look()
  })
  const heard = (word, ms) => new Promise((done) => {
    const finish = (ok) => { clearTimeout(timer); waiting.delete(look); done(ok) }
    const look = () => { if (lines.some((line) => line.startsWith(word))) finish(true) }
    const timer = setTimeout(() => finish(false), ms)
    waiting.add(look)
    look()
  })
  const exited = new Promise((done) => helper.once("exit", (code) => done(code)))
  const power = await heard("power", 15_000)
  helper.stdin.write("hold idle Mako: 1 agent working\n")
  const holding = await heard("holding", 5_000)
  const requests = await powershell("powercfg /requests").catch((error) => error.message)
  const listed = /SYSTEM:[\s\S]*Mako/i.test(requests)
  helper.stdin.write("release\n")
  helper.stdin.end()
  const code = await Promise.race([exited, delay(10_000).then(() => "running")])
  if (code === "running") helper.kill()
  return { ok: power && holding && code === 0, power, holding, listedInPowercfg: listed, exit: code, lines, stderr: stderr.trim() }
}
