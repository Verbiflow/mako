import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { existsSync, openSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { randomUUID } from "node:crypto"
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
