import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { existsSync, openSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { delimiter, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

/**
 * The Windows installer as a person meets it, on a disposable Windows machine (the release workflow's runner): installed
 * silently for this user, launched, its window and its host looked for, its login item, `mako:` scheme and power
 * helper checked, measured idle, closed, and uninstalled with nothing of it left behind but the person's data.
 *
 * With `--require-host` it is also used as a person and an agent use it. A Thread on a stand-in for a harness's CLI
 * (`windows-host/computer-stand-in.mjs`, a `grok.cmd` on PATH) runs the task's own `mako-control.cmd`, which reaches
 * Local Control and, through the driver shipped beside Mako.exe (which must prove itself to the host), observes a
 * fixture window, sets its field, clicks its button, records it to a video with no FFmpeg on PATH and takes an
 * Appshot; closing the Thread ends everything the harness started. In the window itself, over its DevTools protocol:
 * a Thread's row is clicked, its reply read on screen, a message typed into the composer and sent, and its reply
 * read. Then `mako-host stop` ends the host through its own stop, and the app, launched again, reads back what was
 * written.
 *
 *   node scripts/smoke-windows-install.mjs <Mako-Setup-x64.exe> [--evidence <directory>] [--require-host]
 *
 * What needs the host (the window, which shows only once its host answers; the host's process, its helper and
 * `/health`; a second launch handing over; the link proofs; closing the window leaving the host) is required with
 * `--require-host`, as the release workflow runs it; without it those are reported only, for a tree whose host can't
 * start.
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

  // What the Thread below needs, made before the app starts so its host inherits it: a stand-in harness on PATH, in
  // this user's profile (where the host trusts a program it finds), a fixture window, and the agent's program.
  const stage = requireHost ? await stageThread() : undefined
  const debugPort = await freePort()

  // Cold start: launched, until its window is on screen, and until its host answers.
  began = performance.now()
  const output = openSync(join(evidence, "desktop-output.log"), "w")
  const appEnv = { ...process.env, ...stage?.env, ELECTRON_ENABLE_LOGGING: "1", MAKO_RUNTIME_TRACE: "1" }
  // Its window's DevTools protocol, on this machine only, for the checks made in the window itself.
  const app = spawn(executable, [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"], { detached: true, stdio: ["ignore", output, output], env: appEnv })
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
  // The host's native security helper (#1117), which it runs from beside Mako.exe.
  check("mako-windows.exe beside Mako.exe", existsSync(join(installDirectory, "mako-windows.exe")), installDirectory, true)
  check("mako-video.exe beside Mako.exe", existsSync(join(installDirectory, "mako-video.exe")), installDirectory)
  check("cua-driver.exe beside Mako.exe", ["cua-driver.exe", "LICENSE-Cua.md", "THIRD-PARTY-NOTICES-cua-driver.txt"].every((name) => existsSync(join(installDirectory, name))), installDirectory)
  const health = await hostHealth(began)
  report.hostHealthMs = health.ms
  check("host answers health", health.ok, health.detail, true)
  if (requireHost) assert.ok(health.ok, `The host never answered: ${health.detail}`)

  // Computer control on the installed app: the host lists the windows on screen and takes an Appshot of Mako's own,
  // through the driver it ships beside Mako.exe and no other.
  report.appshot = await hostAppshot()
  check("host takes an Appshot", report.appshot.ok, report.appshot, true)

  // A Thread, as an agent uses the installed app; then one in the window, as a person does.
  if (stage) {
    report.thread = await installedThread(stage).catch((error) => ({ checks: { "a Thread on the installed app": { ok: false, detail: error instanceof Error ? error.stack : String(error) } } }))
    for (const [name, result] of Object.entries(report.thread.checks)) check(name, result.ok, result.detail, true)
    report.window = await windowThread(stage, debugPort).catch((error) => ({ checks: { "a Thread in the window": { ok: false, detail: error instanceof Error ? error.stack : String(error) } } }))
    for (const [name, result] of Object.entries(report.window.checks)) check(name, result.ok, result.detail, true)
  }

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
  // After `--`, Chromium reads no switch: a link can't pass one to Mako.
  check("mako: scheme", scheme.includes("Mako.exe") && /(?:"--"|--)\s+"%1"$/.test(scheme.trim()), scheme)

  // A second launch hands over to the first and leaves: one window still.
  const second = spawn(executable, ["mako://thread/smoke"], { stdio: "ignore" })
  const secondExit = await Promise.race([new Promise((done) => second.once("exit", done)), delay(20_000).then(() => "running")])
  await delay(1_000)
  const windows = (await makoProcesses()).filter((entry) => entry.window !== 0)
  check("second launch hands over", secondExit !== "running" && windows.length === 1, { exit: secondExit, windows: windows.length }, true)

  // `mako://open` links, as a web page would send them through Windows: a share, a WebDAV share, a device path, a
  // missing folder and a file are refused with no question and no connection; a local folder is asked about, and
  // opens only on Open.
  report.links = await projectLinks()
  for (const [name, result] of Object.entries(report.links.checks)) check(name, result.ok, result.detail, true)

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
    byProcess: second2.map((entry) => ({ pid: entry.pid, role: role(entry.command), workingSetMB: Math.round(entry.workingSet / 2 ** 20), privateMB: Math.round(entry.private / 2 ** 20), command: (entry.command ?? "").slice(0, 240) })),
    // What Mako runs beside Mako.exe: the computer-use driver once something used the computer, and its helpers.
    helpers: await helperProcesses(),
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

  // The host asked to stop, where Windows has no signal to send: its own stop runs, it exits, and nothing of Mako's
  // is left running. Launched again, the app's new host reads the Thread the first one wrote.
  if (stage) {
    report.stop = await hostStop(stage, appEnv).catch((error) => ({ checks: { "mako-host stop": { ok: false, detail: error instanceof Error ? error.stack : String(error) } } }))
    for (const [name, result] of Object.entries(report.stop.checks)) check(name, result.ok, result.detail, true)
  }

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
  check("no driver left running", !(await powershell("@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue).Count")).trim().replace(/^0$/, ""))
  check("login item removed", !(await registryValue(RUN_KEY, "Mako")))
  check("mako: scheme removed", !(await registryKey(SCHEME_KEY)))
  const remaining = []
  for (const key of nativeHosts) if (await registryKey(key)) remaining.push(key)
  check("native-messaging registrations removed", remaining.length === 0, remaining)
  check("native-messaging files removed", !existsSync(join(bin, "mako-browser-host-smoke.cmd")) && !existsSync(join(bin, "dev.mako.browser-smoke.json")))
  check("person's data kept", existsSync(join(appData, "Mako")))

  // DLL planting: the installer run from a Downloads folder beside DLLs a download could leave there, each a real x86
  // DLL that logs its own load. None may load, and the install must still work.
  report.dllPlanting = await dllPlanting()
  check("installer loads no DLL from its own folder", report.dllPlanting.ok, report.dllPlanting)
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

/** The question a linked folder raises (`confirmLinkedProject`): found, or answered by its button. */
async function linkDialog(answer) {
  const text = await powershell(`
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $mako = @(Get-Process -Name Mako -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $root = [Windows.Automation.AutomationElement]::RootElement
    $isDialog = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
    # A dialog with a parent window is that window's child in UI Automation, not the desktop's.
    $dialogs = @($root.FindAll([Windows.Automation.TreeScope]::Children, $isDialog))
    foreach ($top in $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
      if ($mako -contains $top.Current.ProcessId) { $dialogs += @($top.FindAll([Windows.Automation.TreeScope]::Children, $isDialog)) }
    }
    foreach ($dialog in $dialogs) {
      if ($mako -notcontains $dialog.Current.ProcessId) { continue }
      # A task dialog's text isn't always a Text control: every named part of it, and its Open button.
      $parts = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      $message = (@($dialog.Current.Name) + ($parts | ForEach-Object { $_.Current.Name } | Where-Object { $_ })) -join ' | '
      if (-not ($parts | Where-Object { $_.Current.Name -eq 'Open' })) { continue }
      ${answer ? `Add-Type -AssemblyName System.Windows.Forms
      Add-Type -Name Front -Namespace Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);'
      $named = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '${answer}')
      $button = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants, $named)
      if (-not $button) { Write-Output "no ${answer}: $message"; exit 0 }
      $kind = $button.Current.ControlType.ProgrammaticName
      $how = $null
      try { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'invoked' } catch { }
      if (-not $how) {
        # A task dialog's buttons aren't always invokable: from the keyboard instead, the dialog in front.
        [void][Win32.Front]::SetForegroundWindow([System.IntPtr]$dialog.Current.NativeWindowHandle)
        Start-Sleep -Milliseconds 300
        try { $button.SetFocus(); Start-Sleep -Milliseconds 200; [System.Windows.Forms.SendKeys]::SendWait(' '); $how = 'pressed' }
        catch { [System.Windows.Forms.SendKeys]::SendWait('${answer === "Cancel" ? "{ESC}" : "+{TAB}{ENTER}"}'); $how = 'keyed' }
      }
      Write-Output "$how $kind ${answer}"
      exit 0` : ""}
      Write-Output $message
      exit 0
    }`)
  return text || undefined
}

/** Whether `token` appears in any file of Mako's data under 5 MB: where an opened project's folder is recorded. */
async function inMakoData(token) {
  const root = join(appData, "Mako")
  const stack = [root]
  while (stack.length) {
    const folder = stack.pop()
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && (await stat(path).catch(() => ({ size: Infinity }))).size < 5 * 2 ** 20 && (await readFile(path).catch(() => Buffer.alloc(0))).includes(token)) return path
    }
  }
  return undefined
}

async function projectLinks() {
  const checks = {}
  const record = (name, ok, detail) => { checks[name] = { ok, detail } }
  const send = (path) => powershell(`Start-Process 'mako://open?path=${encodeURIComponent(path)}'`)
  // A WebDAV server's port, listened on: a link that reached for the share would connect here.
  const connections = []
  const server = createServer((socket) => { connections.push(Date.now()); socket.destroy() })
  await new Promise((done) => server.listen(8080, "127.0.0.1", done))
  const webClient = await powershell("Start-Service WebClient -ErrorAction SilentlyContinue; (Get-Service WebClient -ErrorAction SilentlyContinue).Status").catch(() => "")
  const token = `mako-link-project-${randomUUID().slice(0, 8)}`
  const folder = join(process.env.USERPROFILE ?? "C:\\", token)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, "notes.txt"), "")
  const desktopLog = join(appData, "mako-ui-desktop", "logs", "desktop.log")
  const refusals = async () => ((await readFile(desktopLog, "utf8").catch(() => "")).match(/a link's folder was refused/g) ?? []).length
  try {
    const before = await refusals()
    const smb = async () => Number(await powershell("@(Get-NetTCPConnection -RemotePort 445 -ErrorAction SilentlyContinue).Count").catch(() => "-1"))
    const smbBefore = await smb()
    const refused = ["\\\\127.0.0.1@8080\\dav\\x", "//127.0.0.1@8080/dav", "\\\\127.0.0.1\\c$", "\\\\?\\UNC\\127.0.0.1\\c$", "\\\\?\\C:\\Windows", join(folder, "missing"), join(folder, "notes.txt")]
    for (const path of refused) await send(path)
    await delay(5_000)
    record("refused links ask nothing", !(await linkDialog()), refused)
    record("refused links are refused", (await refusals()) - before === refused.length, { refused: (await refusals()) - before, of: refused.length })
    const smbAfter = await smb()
    record("refused links connect to nothing", connections.length === 0 && smbAfter === smbBefore, { webDav: connections.length, webClient, smbBefore, smbAfter })

    // Written the long way round: the question shows the folder it really is.
    await send(`${folder}\\..\\${token}\\.`)
    let question
    for (let tries = 0; tries < 50 && !question; tries++) {
      question = await linkDialog()
      if (!question) await delay(200)
    }
    record("a local folder is asked about", Boolean(question && /Open/.test(question) && /Cancel/.test(question)), question)
    record("the question shows the resolved folder", Boolean(question?.includes(`Open ${folder} as a project`)) && !question.includes(".."), question)
    // A second link while the question is open is dropped, not stacked.
    await send(folder)
    await delay(3_000)
    record("a link during the question is dropped", /a link's folder was dropped/.test(await readFile(desktopLog, "utf8").catch(() => "")))
    const cancelled = await linkDialog("Cancel")
    await delay(3_000)
    record("Cancel opens nothing", cancelled?.endsWith("Cancel") && !(await linkDialog()) && !/a linked folder opens as a project/.test(await readFile(desktopLog, "utf8").catch(() => "")) && !(await inMakoData(token)))

    await send(folder)
    for (let tries = 0; tries < 50 && !(await linkDialog()); tries++) await delay(200)
    const pressed = await linkDialog("Open")
    const agreed = async () => /a linked folder opens as a project/.test(await readFile(desktopLog, "utf8").catch(() => ""))
    let opened = false
    for (let tries = 0; tries < 30 && !opened; tries++) {
      opened = await agreed()
      if (!opened) await delay(500)
    }
    record("Open opens it", opened && !(await linkDialog()), { pressed, opened, recordedIn: await inMakoData(token) })

    // The control: the same shares reached directly do connect (WebDAV only where Windows's WebDAV client runs), so
    // the counts above would have seen a link that reached them.
    await powershell("Test-Path '\\\\127.0.0.1\\c$' | Out-Null; Test-Path '\\\\127.0.0.1@8080\\dav\\x' | Out-Null", 60_000).catch(() => undefined)
    await delay(1_000)
    Object.assign(checks["refused links connect to nothing"].detail, { controlWebDav: connections.length, controlSmb: await smb() })
  } finally {
    server.close()
  }
  return { checks }
}


async function dllPlanting() {
  /** The names Windows looks up beside an executable before System32 when a program doesn't guard its loads. */
  const PLANTED = ["version", "userenv", "uxtheme", "cryptbase", "profapi", "apphelp", "propsys", "dwmapi", "cryptsp", "oleacc", "setupapi", "shfolder", "textshaping", "mpr", "netapi32", "winmm", "iphlpapi", "secur32", "sspicli", "wininet", "msimg32", "rsaenh", "wsock32", "ntmarta", "nsi", "dbghelp", "riched20", "comctl32"]
  const vcvars = (await powershell(`& "\${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\\Auxiliary\\Build\\vcvars32.bat'`).catch(() => "")).split("\n")[0]?.trim()
  if (!vcvars) return { ok: false, detail: "no MSVC on this machine to build the planted DLL" }
  const work = join(process.env.USERPROFILE ?? "", "Downloads", `mako-dll-${randomUUID().slice(0, 8)}`)
  await mkdir(work, { recursive: true })
  const source = join(work, "planted.c")
  await writeFile(source, `#include <windows.h>
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
  if (reason == DLL_PROCESS_ATTACH) {
    char name[MAX_PATH], log[MAX_PATH + 32];
    DWORD written;
    HANDLE file;
    GetModuleFileNameA(module, name, MAX_PATH);
    GetTempPathA(MAX_PATH, log);
    lstrcatA(log, "mako-planted-dll.log");
    file = CreateFileA(log, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_ALWAYS, 0, 0);
    if (file != INVALID_HANDLE_VALUE) { WriteFile(file, name, lstrlenA(name), &written, 0); WriteFile(file, "\\r\\n", 2, &written, 0); CloseHandle(file); }
  }
  return TRUE;
}
`)
  await run("cmd.exe", ["/d", "/s", "/c", `""${vcvars}" >nul && cl /nologo /LD "${source}" /Fe"${join(work, "planted.dll")}" /Fo"${join(work, "planted.obj")}" kernel32.lib"`], { cwd: work, timeout: 120_000, windowsVerbatimArguments: true })
  const log = join(process.env.TEMP ?? "", "mako-planted-dll.log")
  await writeFile(log, "")
  const planted = await readFile(join(work, "planted.dll"))
  for (const name of PLANTED) await writeFile(join(work, `${name}.dll`), planted)
  const copy = join(work, "Mako-Setup-x64.exe")
  await writeFile(copy, await readFile(installer))
  let installed = false
  try {
    await run(copy, ["/S"], { cwd: work, timeout: 300_000 })
    installed = existsSync(executable)
  } finally {
    if (existsSync(join(installDirectory, "Uninstall Mako.exe"))) {
      await run(join(installDirectory, "Uninstall Mako.exe"), ["/S"], { timeout: 300_000 }).catch(() => undefined)
      for (let tries = 0; tries < 150 && existsSync(executable); tries++) await delay(200)
    }
  }
  const loaded = (await readFile(log, "utf8")).split(/\r?\n/).filter(Boolean)
  return { ok: installed && loaded.length === 0, installed, loaded, planted: PLANTED.length }
}

function role(command = "") {
  if (/--keep-awake/.test(command)) return "keep-awake"
  if (/dist-electron[\\/]host[\\/]entry\.js/.test(command)) return "host"
  // The host's own children, each Mako.exe as Node on one script.
  if (/watcher-child-main\.js/.test(command)) return "host: file watcher"
  if (/git-helper-main\.js/.test(command)) return "host: git helper"
  if (/sessions[\\/]dist[\\/]daemon-main\.js/.test(command)) return "host: session catalog reader"
  if (/terminals[\\/]daemon\.js/.test(command)) return "host: terminal daemon"
  if (/desktop-session-worker\.js/.test(command)) return "host: Local Control worker"
  if (/usage-worker|catalog-worker/.test(command)) return "host: worker"
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
  let last = "no answer"
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await delay(500)) {
    // Read each time: every start of the host draws a new pipe name.
    const socket = runtimeLocation(runtimeDataRoot(appData, {})).socket
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

/** The host's own Appshot calls, as a window makes them, and where the driver that served them runs from. */
async function hostAppshot() {
  const connection = new URL("../packages/host/dist/transport/connection.js", import.meta.url)
  const service = new URL("../packages/host/dist/transport/service.js", import.meta.url)
  try {
    const { invokeRuntime } = await import(connection.href)
    const { runtimeDataRoot, runtimeLocation } = await import(service.href)
    const socket = runtimeLocation(runtimeDataRoot(appData, {})).socket
    const client = randomUUID()
    let windows = []
    // The driver starts on the first ask; the window may take a moment to be listed.
    for (let tries = 0; tries < 30 && !windows.some((entry) => /Mako/i.test(`${entry.app ?? ""} ${entry.title ?? ""}`)); tries++) {
      windows = await invokeRuntime(socket, client, "mako:appshot-windows", [])
      if (!windows.length) await delay(1_000)
    }
    const target = windows.find((entry) => /Mako/i.test(`${entry.app ?? ""} ${entry.title ?? ""}`)) ?? windows[0]
    if (!target) return { ok: false, detail: "the host listed no window" }
    const shot = await invokeRuntime(socket, client, "mako:appshot-capture", [{ pid: target.pid, windowId: target.windowId }])
    const bytes = JSON.stringify(shot ?? null).length
    const drivers = (await powershell("@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }) -join '|'")).split("|").filter(Boolean)
    const shipped = join(installDirectory, "cua-driver.exe").toLowerCase()
    return {
      ok: bytes > 10_000 && drivers.length > 0 && drivers.every((path) => path.toLowerCase() === shipped),
      windows: windows.length,
      target: { app: target.app, title: target.title },
      shotKeys: Object.keys(shot ?? {}),
      shotBytes: bytes,
      drivers,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
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

/** A TCP port nothing listens on, as the system picks one. */
function freePort() {
  return new Promise((done) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/** The programs Mako runs that aren't Mako.exe, with what each holds. */
async function helperProcesses() {
  const text = await powershell(`@(Get-Process -Name cua-driver, mako-video, mako-windows -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; workingSetMB = [math]::Round($_.WorkingSet64 / 1MB); privateMB = [math]::Round($_.PrivateMemorySize64 / 1MB) } }) | ConvertTo-Json -Compress`).catch(() => "")
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

// Declared as functions: the checks above run before this part of the file is reached.
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(read, done, label, timeoutMs = 30_000) {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s: ${label}`)
  }
}

/**
 * What a Thread on the installed app needs, in this user's profile: a `grok.cmd` that runs the stand-in harness, a
 * project, a fixture window, the program the agent runs through `mako-control.cmd`, and the environment the app (and
 * so its host and its harness) starts with. No folder of that PATH holds an FFmpeg.
 */
async function stageThread() {
  const repo = resolve(import.meta.dirname, "..")
  const root = join(process.env.USERPROFILE, `mako-smoke-${randomUUID().slice(0, 8)}`)
  const bin = join(root, "bin")
  const project = join(root, "project")
  await mkdir(bin, { recursive: true })
  await mkdir(project, { recursive: true })
  await writeFile(join(project, "notes.txt"), "the smoke's project\n")
  await writeFile(join(bin, "grok.cmd"), `@echo off\r\n"${process.execPath}" "${join(repo, "scripts", "windows-host", "computer-stand-in.mjs")}" %*\r\n`)
  const fixtureState = join(root, "fixture.json")
  const fixture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "fixtures", "win-control-fixture.ps1"), "-Title", "Mako smoke fixture", "-State", fixtureState], { stdio: "ignore" })
  const fixtureRead = async () => JSON.parse(await readFile(fixtureState, "utf8").catch(() => "null"))
  const window = await until(fixtureRead, (state) => state?.hwnd, "the fixture window", 60_000)
  const program = join(root, "computer-program.js")
  // Observe, record while setting the field and pressing the button, stop the recording, take an Appshot.
  await writeFile(program, `const win = control.window({pid: ${window.pid}, window_id: ${window.hwnd}});
const view = await win.observe();
const field = view.nodes.find(n => n.role === 'TextField' && n.name === 'Proof');
const recording = await win.record({fps: 30});
await win.setValue(field.ref, 'smoke-proof');
const again = await win.observe();
await win.click(again.nodes.find(n => n.role === 'Button' && n.name === 'Verify proof').ref);
await win.expect({role: 'TextField', name: 'Proof', value: 'smoke-proof'}, {timeoutMs: 5000});
for (let i = 0; i < 4; i++) { const now = await win.observe(); await win.setValue(now.nodes.find(n => n.role === 'TextField' && n.name === 'Proof').ref, 'recorded ' + i); await new Promise(r => setTimeout(r, 300)) }
let receipt = await recording.stop();
for (let i = 0; i < 150 && ['recording', 'finalizing'].includes(receipt.status); i++) { await new Promise(r => setTimeout(r, 200)); receipt = await recording.status() }
const shot = await win.appshot();
return {observed: view.nodes.length, recording: {status: receipt.status, video: receipt.video ?? null, error: receipt.error ?? null, durationMs: receipt.durationMs ?? null}, appshot: Object.keys(shot)};
`)
  const { GROK_VERSIONS } = await import(new URL("../packages/host/dist/harnesses/grok/versions.js", import.meta.url).href)
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
  const withoutFfmpeg = (process.env[pathKey] ?? "").split(delimiter).filter((folder) => folder && !existsSync(join(folder, "ffmpeg.exe")))
  const env = {
    [pathKey]: [bin, ...withoutFfmpeg].join(delimiter),
    MAKO_PROOF_GROK_VERSION: GROK_VERSIONS.tested,
    MAKO_PROOF_COMPUTER_PROGRAM: program,
    MAKO_PROOF_COMPUTER_RESULT: join(root, "computer-result.json"),
    MAKO_PROOF_CONTROL_CLI: join(repo, "packages", "control-runtime", "dist", "control-cli.js"),
    MAKO_PROOF_GRANDCHILD_FILE: join(root, "grandchild.pid"),
    // A turn of the stand-in: two and a half seconds of words.
    MEASURE_STREAM_MS: "2500",
  }
  return { repo, root, project, fixture, fixtureRead, env, pathKey, path: env[pathKey] }
}

/** The headless client against the installed app's host, which it finds by the app's own data. */
function makoClient(stage) {
  const env = { ...process.env, ...stage.env }
  for (const key of ["MAKO_DATA_ROOT", "MAKO_PROFILE", "MAKO_WEB_SOCKET", "ELECTRON_RUN_AS_NODE"]) delete env[key]
  return async (...words) => {
    const { stdout } = await run(process.execPath, [join(stage.repo, "packages", "client", "dist", "cli.js"), "--json", ...words], { env, maxBuffer: 64 * 2 ** 20, timeout: 240_000 })
    return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  }
}

async function hostCall(method, callArgs = [], timeoutMs = 60_000) {
  const { invokeRuntime } = await import(new URL("../packages/host/dist/transport/connection.js", import.meta.url).href)
  const { runtimeDataRoot, runtimeLocation } = await import(new URL("../packages/host/dist/transport/service.js", import.meta.url).href)
  return invokeRuntime(runtimeLocation(runtimeDataRoot(appData, {})).socket, randomUUID(), method, callArgs, 1, { timeoutMs })
}

/**
 * A Thread on the stand-in harness, started by the headless client on the installed host: the agent's own
 * `mako-control.cmd` reaches Local Control, uses the computer through the shipped driver, and records the window.
 */
async function installedThread(stage) {
  const checks = {}
  const record = (name, ok, detail) => { checks[name] = { ok, detail } }
  const mako = makoClient(stage)
  const lines = await mako("start", "grok", "Use the computer", "--cwd", stage.project)
  const started = lines[0]
  record("a Thread runs on the stand-in harness, found on PATH as grok.cmd", started?.kind === "started" && lines.at(-1)?.status === "completed", { first: started?.kind, last: lines.at(-1) })
  const outcome = JSON.parse(await readFile(stage.env.MAKO_PROOF_COMPUTER_RESULT, "utf8").catch(() => '{"error":"the stand-in harness wrote no result"}'))
  let value
  try {
    value = JSON.parse(outcome.stdout ?? "null")?.at?.(-1)?.value
  } catch {
    value = undefined
  }
  record("the agent's mako-control.cmd reaches Local Control", !outcome.error && /mako-control\.cmd$/i.test(outcome.launcher ?? "") && Boolean(value), { launcher: outcome.launcher, error: outcome.error, stderr: String(outcome.stderr ?? "").slice(0, 600), stdout: String(outcome.stdout ?? "").slice(0, 600) })
  const state = await stage.fixtureRead()
  const drivers = (await powershell("@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }) -join '|'")).split("|").filter(Boolean)
  const shipped = join(installDirectory, "cua-driver.exe").toLowerCase()
  record("the agent uses the computer through the installed driver", state?.verified === "smoke-proof" && state.presses >= 1 && Array.isArray(value?.appshot) && drivers.length > 0 && drivers.every((path) => path.toLowerCase() === shipped), { verified: state?.verified, presses: state?.presses, observed: value?.observed, appshot: value?.appshot, drivers })
  const driver = await hostCall("mako:computer-driver").catch((error) => ({ error: error.message }))
  const release = Number(/\+mako\.(\d+)/.exec(driver.version ?? "")?.[1] ?? 0)
  const hostLog = await readFile(join(appData, "Mako", "logs", "host.log"), "utf8").catch(() => "")
  record("the driver proves itself to the host", release >= 31 && !/driver predates the proof handshake/.test(hostLog), { version: driver.version, detail: driver.detail ?? driver.error })
  const video = value?.recording?.video
  const bytes = video ? (await stat(video).catch(() => ({ size: 0 }))).size : 0
  const head = video && bytes ? (await readFile(video)).subarray(4, 8).toString("latin1") : ""
  const ffmpeg = await run("where.exe", ["ffmpeg"], { env: { ...process.env, [stage.pathKey]: stage.path } }).then((found) => found.stdout.trim(), () => "")
  record("a window is recorded to a video with no FFmpeg on PATH", value?.recording?.status === "finished" && bytes > 2_000 && head === "ftyp" && ffmpeg === "", { recording: value?.recording, bytes, box: head, ffmpegOnPath: ffmpeg || "none" })
  // Closing the Thread ends the harness and everything it started (its job object).
  const grandchild = Number(await readFile(stage.env.MAKO_PROOF_GRANDCHILD_FILE, "utf8").catch(() => "0"))
  const ran = grandchild > 0 && alive(grandchild)
  await hostCall("mako:live-close", [started.conversationId])
  const gone = await until(async () => !alive(grandchild), Boolean, "the harness's grandchild to end", 20_000).catch(() => false)
  record("closing the Thread ends the harness's whole tree", ran && gone, { grandchild, ranBefore: ran, goneAfter: gone })
  return { checks, conversation: started.conversationId, computer: value }
}

/**
 * The same, in the window: over its DevTools protocol a Thread is started as the window starts one, its row in the
 * rail clicked with the mouse, its reply read on screen, then a message typed into the composer and sent with its
 * Send button, and that turn's reply read on screen.
 */
async function windowThread(stage, port) {
  const checks = {}
  const record = (name, ok, detail) => { checks[name] = { ok, detail } }
  const { default: WebSocket } = await import("ws")
  const target = await until(async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((reply) => reply.json(), () => [])).find((item) => item.type === "page" && item.url.startsWith("mako-app:")), Boolean, "the window's page on its DevTools port", 60_000)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.once("open", done); socket.once("error", fail) })
  let counter = 0
  const waiting = new Map()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString())
    const settle = waiting.get(message.id)
    if (!settle) return
    waiting.delete(message.id)
    settle(message)
  })
  const command = (method, params = {}) => new Promise((done, fail) => {
    const id = ++counter
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`Timed out: ${method}`)) }, 60_000)
    waiting.set(id, (message) => { clearTimeout(timer); message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails).slice(0, 800))
    return response.result.value
  }
  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const click = async (element, label) => {
    const point = await until(() => evaluate(`(() => { const e = ${element}; if (!e || e.disabled) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; const x = r.x + r.width / 2, y = r.y + r.height / 2; return e.contains(document.elementFromPoint(x, y)) ? { x, y } : null })()`), Boolean, `clickable ${label}`, 30_000)
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await delay(120)
    for (const type of ["mousePressed", "mouseReleased"]) await command("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const shot = async (name) => writeFile(join(evidence, name), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64")).catch(() => undefined)
  try {
    await until(() => evaluate("Boolean(window.mako && document.querySelector('.composer-input'))").catch(() => false), Boolean, "the window's bridge and composer", 60_000)
    const id = randomUUID()
    const first = randomUUID()
    await evaluate(`window.mako.liveStart("grok", ${JSON.stringify(stage.project)}, ${JSON.stringify({ conversationId: id, title: "Smoke in the window", initialRequest: { id: first, text: "Say it in the window", attachments: [] } })}).then(() => true)`)
    const snapshot = () => evaluate(`window.mako.liveSnapshot(${JSON.stringify(id)})`)
    const completed = (requestId) => until(snapshot, (snap) => snap?.requests?.find((request) => request.id === requestId)?.status === "completed", "the turn to complete", 120_000)
    await completed(first)
    const row = q(`[data-conversation-id="${id}"]`)
    // The row may sit under a collapsed group: every "More" in the rail is pressed until it shows.
    await until(async () => {
      if (await evaluate(`Boolean(${row})`)) return true
      await evaluate(`[...document.querySelectorAll('button')].filter(b => /^(More|Show more)/.test(b.textContent.trim()) && b.getClientRects().length).forEach(b => b.click())`)
      return false
    }, Boolean, "the Thread's row in the rail", 60_000)
    await click(row, "the Thread's row")
    const onScreen = q(`[data-live-conversation="${id}"]`)
    // In a window this narrow the side panel opens over the Thread: its "Workbench" button, pressed, gives the Thread
    // back. Only a Thread that is laid out (it has a box on screen) counts as shown.
    const shown = `(() => { const e = ${onScreen}; return Boolean(e && e.getClientRects().length && e.getBoundingClientRect().width > 100) })()`
    const back = `[...document.querySelectorAll('.companion-panel button')].find(b => b.textContent.trim() === 'Workbench')`
    const covered = await evaluate(`Boolean(${back}) && !${shown}`)
    if (covered) await click(back, "the side panel's Workbench button")
    await until(() => evaluate(shown), Boolean, "the Thread on screen", 30_000)
    const text = () => evaluate(`${shown} ? ${onScreen}.innerText : ""`)
    const firstText = await until(text, (shown) => /the host reads each update/.test(shown), "the first reply on screen", 30_000).catch(() => text())
    record("a Thread's row is clicked and its reply shows in the window", /the host reads each update/.test(firstText) && /Say it in the window/.test(firstText), firstText.replace(/\s+/g, " ").slice(0, 200))
    await shot("window-thread-1.png")

    // Typed and sent as a person would: the composer focused, the text inserted, the Send button pressed.
    const typed = "Again, typed in the window"
    await until(() => evaluate("Boolean(document.querySelector('.composer-input:not([readonly])'))"), Boolean, "a writable composer", 30_000)
    await evaluate("document.querySelector('.composer-input').focus()")
    await command("Input.insertText", { text: typed })
    await until(() => evaluate(`document.querySelector('.composer-input')?.value === ${JSON.stringify(typed)}`), Boolean, "the composer's text", 10_000)
    await click(q('button[aria-label="Send"]'), "Send")
    const sent = await until(snapshot, (snap) => snap?.requests?.find((request) => request.text?.includes(typed)), "the composer's request", 30_000)
    const request = sent.requests.find((entry) => entry.text?.includes(typed))
    await completed(request.id)
    const secondText = await until(text, (shown) => shown.includes(typed) && (shown.match(/the host reads each update/g) ?? []).length >= 2, "the second reply on screen", 30_000).catch(() => text())
    record("a message typed in the composer is sent and answered in the window", secondText.includes(typed) && (secondText.match(/the host reads each update/g) ?? []).length >= 2, secondText.replace(/\s+/g, " ").slice(-200))
    await shot("window-thread-2.png")
    await evaluate(`window.mako.liveClose(${JSON.stringify(id)}).then(() => true)`).catch(() => undefined)
    return { checks, conversation: id, sidePanelCoveredTheThread: covered }
  } catch (error) {
    await shot("window-thread-failed.png")
    throw error
  } finally {
    socket.close()
  }
}

/**
 * `mako-host stop` on the installed app's host: it exits through its own stop and nothing of Mako's is left running;
 * the app launched again starts a host that reads back the Thread the first one wrote.
 */
async function hostStop(stage, appEnv) {
  const checks = {}
  const record = (name, ok, detail) => { checks[name] = { ok, detail } }
  const env = { ...process.env }
  for (const key of ["MAKO_DATA_ROOT", "MAKO_PROFILE", "MAKO_WEB_SOCKET", "ELECTRON_RUN_AS_NODE"]) delete env[key]
  const before = (await makoProcesses()).find((entry) => role(entry.command) === "host")
  const stopped = await run(process.execPath, [join(stage.repo, "packages", "host", "dist", "mako-host.js"), "stop", "--now", "--timeout", "90"], { env, timeout: 120_000 }).then((result) => ({ code: 0, said: result.stdout.trim() }), (error) => ({ code: error.code ?? 1, said: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() }))
  let left = []
  for (let tries = 0; tries < 50; tries++) {
    left = await makoProcesses()
    if (!left.length) break
    await delay(200)
  }
  const log = await readFile(join(appData, "Mako", "logs", "host.log"), "utf8").catch(() => "")
  const ends = (log.match(/lifecycle stopped/g) ?? []).length
  record("mako-host stop ends the host through its own stop", stopped.code === 0 && /stopped/.test(stopped.said) && ends >= 1 && !/lifecycle shutdown failed/.test(log), { ...stopped, host: before?.pid, stoppedInLog: ends })
  record("nothing of Mako's is left running after it", left.length === 0 && (await helperProcesses()).length === 0, { left: left.map((entry) => `${entry.pid} ${role(entry.command)}`), helpers: await helperProcesses() })
  // Launched again: a new host, which reads what the first one wrote.
  const output = openSync(join(evidence, "desktop-output-2.log"), "w")
  const again = spawn(executable, [], { detached: true, stdio: ["ignore", output, output], env: appEnv })
  again.unref()
  const health = await hostHealth(performance.now())
  const history = health.ok && report.thread?.conversation ? await makoClient(stage)("history", report.thread.conversation).catch((error) => [{ kind: "error", text: error.message }]) : []
  record("launched again, the app reads the Thread it wrote", health.ok && history.some((line) => line.kind === "user") && history.filter((line) => line.kind === "text").map((line) => line.text).join("").includes("the host reads each update"), { health: health.detail, lines: history.length, error: history.find((line) => line.kind === "error")?.text })
  stage.fixture.kill()
  await rm(stage.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  return { checks }
}
