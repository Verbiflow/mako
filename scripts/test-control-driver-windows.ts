// Mako's computer control on Windows, end to end without the host: the host's own embedded-driver owner
// (`CuaEmbedded`) starts the shared native driver on a named pipe, the host's `DriverBroker` leases it, and the
// person's Appshots and a task's control session go through that broker as they do in the host. A Windows Forms fixture
// (scripts/fixtures/win-control-fixture.ps1) writes what it receives to a file, so every check reads what the window
// got rather than what the driver said; Notepad and, where installed, Calculator are driven as well. It measures the
// latency of each operation and what an idle driver costs.
//
//   npm run build:control-runtime && npx tsx scripts/test-control-driver-windows.ts --driver <cua-driver.exe> [--json out.json]
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { z } from "zod"
import { CuaEmbedded } from "../packages/host/src/control/cua-embedded.js"
import { findExecutable, resolveExecutable } from "../packages/host/src/base/executable.js"
import { computerPermissions } from "../packages/host/src/control/computer-permissions.js"
import { CuaDriverVersions } from "../packages/host/src/control/cua-driver-version.js"
import { Appshots } from "../packages/host/src/control/appshots.js"
import { DriverBroker } from "../packages/control-runtime/src/driver-broker.js"
import { exchange, parseReply } from "../packages/control-runtime/src/driver-daemon.js"
import { connect, createServer } from "node:net"
import { readMp4 } from "../packages/control-runtime/src/mp4.js"
import { daemonAnswers } from "../packages/control-runtime/src/driver-daemon.js"
import { driverPath as reportedPath } from "../packages/control-runtime/src/native-recording.js"
import type { ComputerDriverClient } from "../packages/control-runtime/src/computer-driver-client.js"
import type { JsonObject, JsonValue } from "../packages/control-runtime/src/json.js"
import { controlSessionProbe } from "./lib/control-session-probe.js"

const run = promisify(execFile)
const { values } = parseArgs({ options: { driver: { type: "string" }, "video-helper": { type: "string" }, json: { type: "string" } } })
assert.equal(process.platform, "win32", "This checks the Windows driver on Windows")
assert.ok(values.driver, "--driver <path to cua-driver.exe>")
// The host finds the driver the way it finds any program on Windows: on PATH or in the user's own folders, and only
// where no other account could have put it. A folder in this user's profile is one; the build's folder on the runner's
// work drive is not, so the driver is copied to the profile's temporary folder and found there.
const driverFolder = await realpath(await mkdtemp(join(tmpdir(), "mako-win-driver-")))
const driverPath = join(driverFolder, "cua-driver.exe")
await copyFile(resolve(values.driver), driverPath)
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
process.env[pathKey] = `${driverFolder}${delimiter}${process.env[pathKey] ?? ""}`
// Video comes from Mako's video helper, by its whole path (the host sets MAKO_VIDEO_HELPER for a packaged app), and
// never from FFmpeg: no folder on PATH holds one while this runs, so nothing here or in the driver can reach it.
assert.ok(values["video-helper"], "--video-helper <path to mako-video.exe>")
process.env.MAKO_VIDEO_HELPER = resolve(values["video-helper"])
process.env[pathKey] = (process.env[pathKey] ?? "").split(delimiter).filter((folder) => folder && !existsSync(join(folder, "ffmpeg.exe")) && !existsSync(join(folder, "ffmpeg"))).join(delimiter)

const root = await mkdtemp(join(tmpdir(), "mako-win-control-"))
interface CheckOutcome {
  ok: boolean
  ms: number
  detail?: JsonValue
  error?: string
}
interface Results {
  checks: Record<string, CheckOutcome>
  latency: Record<string, JsonValue>
  idle?: JsonValue
  driver?: JsonValue
}
const results: Results = { checks: {}, latency: {} }
/** What a check found, as the JSON written to the results file. */
const json = <T,>(value: T): JsonValue => Json.parse(JSON.parse(JSON.stringify(value ?? null)))
const children: ChildProcess[] = []
const ms = (since: number) => Math.round(performance.now() - since)
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!
const p90 = (list: number[]) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * 0.9))]!
const until = async <T>(read: () => Promise<T | undefined | null | false>, what: string, timeout = 10_000): Promise<T> => {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}${last instanceof Error ? ` (${last.message})` : ""}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** What the fixture had received when a check failed, for its record. */
let diagnose: (() => Promise<object>) | undefined
async function check(name: string, body: () => Promise<object | undefined | void>): Promise<void> {
  const since = performance.now()
  try {
    const detail = await body()
    results.checks[name] = { ok: true, ms: ms(since), detail: json(detail ?? undefined) }
    console.log(`ok   ${name} (${ms(since)} ms)`)
  } catch (error) {
    const fixture = await diagnose?.().catch((failure: Error) => ({ unreadable: failure.message }))
    results.checks[name] = { ok: false, ms: ms(since), error: error instanceof Error ? error.stack ?? error.message : String(error), detail: json({ fixture }) }
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const FixtureState = z.object({
  pid: z.number(),
  hwnd: z.number(),
  dpi: z.number(),
  active: z.boolean(),
  input: z.string(),
  verified: z.string(),
  presses: z.number(),
  checked: z.boolean(),
  topIndex: z.number(),
  selected: z.number(),
  client: z.object({ left: z.number(), top: z.number() }),
  mouse: z.array(z.string()),
  keys: z.array(z.string()),
  typed: z.string(),
})
type FixtureState = z.infer<typeof FixtureState>

async function startFixture(title: string, activate = false) {
  const state = join(root, `${title.replaceAll(" ", "-")}.json`)
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/fixtures/win-control-fixture.ps1"), "-Title", title, "-State", state, ...(activate ? ["-Activate"] : [])],
    { stdio: ["ignore", "inherit", "inherit"] }
  )
  children.push(child)
  const read = async () => FixtureState.parse(JSON.parse(await readFile(state, "utf8")))
  const first = await until(() => read(), `${title} started`, 60_000)
  return { title, state, read, pid: first.pid, hwnd: first.hwnd }
}

/** The foreground window, asked of Windows itself, not of the driver under test. */
async function foreground(): Promise<number> {
  const script = `Add-Type -Name F -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'; [W.F]::GetForegroundWindow().ToInt64()`
  return Number((await run("powershell.exe", ["-NoProfile", "-Command", script])).stdout.trim())
}

/** CPU seconds, working set and threads of a process, from Windows' own counters. */
async function processSample(pid: number) {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", `Get-Process -Id ${pid} | Select-Object @{n='cpu';e={$_.TotalProcessorTime.TotalMilliseconds}},@{n='ws';e={$_.WorkingSet64}},@{n='private';e={$_.PrivateMemorySize64}},@{n='threads';e={$_.Threads.Count}},@{n='handles';e={$_.HandleCount}} | ConvertTo-Json -Compress`])
  return Sample.parse(JSON.parse(stdout))
}

const Window = z.looseObject({
  pid: z.number(),
  window_id: z.number(),
  title: z.string().nullable().optional(),
  is_on_screen: z.boolean().optional(),
  z_index: z.number().nullable().optional(),
  focused: z.boolean().nullable().optional(),
  bounds: z.looseObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
})
const Element = z.looseObject({ element_index: z.number().optional(), element_token: z.string().optional(), role: z.string(), label: z.string().nullable().optional(), value: z.unknown().optional(), value_exact: z.boolean().optional(), frame: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional() })
const Windows = z.array(Window)
const Elements = z.array(Element)
const Apps = z.array(z.looseObject({ pid: z.number(), name: z.string().optional(), active: z.boolean().optional() }))
const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional()
const Scale = z.number().optional()
const Pid = z.number()
const TextBlock = z.object({ type: z.literal("text"), text: z.string() })
const ImageBlock = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
const Structured = z.record(z.string(), z.json())
const Sample = z.object({ cpu: z.number(), ws: z.number(), private: z.number(), threads: z.number(), handles: z.number() })
const Rates = z.array(z.number())
const Json = z.json()
const RecordingReceipt = z.looseObject({ status: z.string(), video: z.string().optional(), error: z.string().nullable() })

const cua = new CuaEmbedded()
let broker: DriverBroker | undefined
let client: ComputerDriverClient | undefined
let exitCode = 0
try {
  // The host's permission readout on Windows: nothing to grant.
  await check("permissions need no grant", async () => {
    const permissions = computerPermissions({ packaged: false, appRoot: process.cwd() }, undefined, undefined)
    assert.deepEqual(permissions, { supported: false, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" })
    return permissions
  })

  // Mako's driver is its own build: the host never runs upstream's updater over it.
  await check("the host refuses to run upstream's updater over Mako's driver", async () => {
    const versions = new CuaDriverVersions()
    const status = await versions.status(driverPath)
    assert.match(status.version ?? "", /\+mako\./, `Mako's build: ${status.detail}`)
    await assert.rejects(versions.update(driverPath), /signed Mako driver package/)
    return { version: status.version }
  })

  const holder = await startFixture("Mako foreground holder", true)
  const fixture = await startFixture("Mako control fixture")
  diagnose = async () => {
    const state = await fixture.read()
    const errors = await readFile(`${fixture.state}.errors`, "utf8").catch(() => "")
    return { input: state.input, verified: state.verified, mouse: state.mouse.slice(-30), keys: state.keys.slice(-12), typed: state.typed.slice(-40), topIndex: state.topIndex, foreground: await foreground(), errors: errors.slice(0, 3000) }
  }
  await new Promise((done) => setTimeout(done, 500))
  console.log("fixture", fixture.pid, fixture.hwnd, "holder", holder.pid, holder.hwnd, "foreground", await foreground())

  // A person's own driver settings in the host's environment: none may reach Mako's daemon. These two would each open
  // a loopback TCP listener beside its pipe.
  const [mcpPort, envelopePort] = [47_811, 47_812]
  Object.assign(process.env, { CUA_DRIVER_RS_MCP_HTTP_PORT: String(mcpPort), CUA_DRIVER_ENVELOPE_HTTP_PORT: String(envelopePort), CUA_DRIVER_RS_MCP_HTTP_TOKEN: "x".repeat(32), CUA_TELEMETRY_ENABLED: "1" })
  let since = performance.now()
  const socket = await cua.ensure(join(root, "cua"), "dev.mako.windows-control-test")
  results.latency.daemonStartMs = ms(since)
  assert.ok(socket, "the driver started")
  assert.ok(socket.startsWith("\\\\.\\pipe\\"), `the driver listens on a named pipe: ${socket}`)
  const daemonPid = cua.pid()
  assert.ok(daemonPid)
  // As the host wires it: the broker is given the daemon's endpoint, its key and its process's end.
  broker = new DriverBroker({ socket: async () => socket, daemon: () => cua.address(), program: (name) => findExecutable(name), own: () => [] })
  client = await broker.connect({ kind: "appshots", label: "windows test" }, { parallel: true })
  const tools = (await client.listTools()).map((tool) => tool.name).sort()
  results.driver = { socket, pid: daemonPid, tools, started: await processSample(daemonPid) }
  console.log("tools", tools.join(" "))
  const driver = client

  const call = async (name: string, args: JsonObject, timeout = 30_000) => {
    const start = performance.now()
    const result = await driver.callTool(name, args, { timeout })
    const elapsed = ms(start)
    const text = result.content.map((block) => (TextBlock.safeParse(block).data?.text ?? "")).join("\n")
    if (result.isError) throw new Error(`${name} refused: ${text.slice(0, 800)}${"element_token" in args ? `; elements: ${JSON.stringify(elements.slice(0, 8).map((element) => [element.element_index, element.role, element.label, element.actions]))}` : ""}`)
    const images = result.content.flatMap((block) => ImageBlock.safeParse(block).data ?? [])
    return { data: Structured.parse(result.structuredContent ?? {}), text, images, ms: elapsed }
  }
  const timed = async (label: string, runs: number, body: () => Promise<object>) => {
    await body()
    const list: number[] = []
    for (let index = 0; index < runs; index++) {
      const start = performance.now()
      await body()
      list.push(ms(start))
    }
    results.latency[label] = { median: median(list), p90: p90(list), min: Math.min(...list), runs: list }
    console.log(`latency ${label}: median ${median(list)} ms, p90 ${p90(list)} ms`)
  }
  const target = { pid: fixture.pid, window_id: fixture.hwnd }
  const pngSize = (base64: string) => {
    const bytes = Buffer.from(base64, "base64")
    if (bytes.subarray(1, 4).toString("latin1") === "PNG") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" }
    return { format: "jpeg", bytes: bytes.length }
  }

  await check("list_apps names the fixture and the active app", async () => {
    const { data } = await call("list_apps", {})
    const apps = Apps.parse(data.apps)
    assert.ok(apps.some((app) => app.pid === fixture.pid), "fixture is listed")
    return { count: apps.length, active: apps.filter((app) => app.active).map((app) => [app.pid, app.name]), fixture: apps.find((app) => app.pid === fixture.pid) }
  })

  let fixtureWindow: z.infer<typeof Window> | undefined
  await check("list_windows: the fixture's HWND, title, visibility and focus", async () => {
    const { data } = await call("list_windows", { pid: fixture.pid })
    const windows = Windows.parse(data.windows)
    fixtureWindow = windows.find((window) => window.window_id === fixture.hwnd)
    assert.ok(fixtureWindow, `HWND ${fixture.hwnd} listed: ${JSON.stringify(windows)}`)
    assert.equal(fixtureWindow.title, fixture.title)
    assert.equal(fixtureWindow.is_on_screen, true)
    return { window: fixtureWindow, keys: Object.keys(data) }
  })

  await check("list_windows leaves out cloaked and invisible windows", async () => {
    const { data } = await call("list_windows", {})
    const windows = Windows.parse(data.windows)
    // Every listed on-screen window is a real top-level window Windows says is visible and not cloaked.
    const onScreen = windows.filter((window) => window.is_on_screen)
    const script = `Add-Type -Name D -Namespace W -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int a, out int v, int s); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'; @(${onScreen.map((window) => window.window_id).join(",")}) | ForEach-Object { $c = 0; [void][W.D]::DwmGetWindowAttribute([IntPtr]$_, 14, [ref]$c, 4); "$_ $([W.D]::IsWindowVisible([IntPtr]$_)) $c" }`
    const rows = (await run("powershell.exe", ["-NoProfile", "-Command", script])).stdout.trim().split(/\r?\n/).filter(Boolean)
    const bad = rows.filter((row) => !row.endsWith(" True 0"))
    assert.deepEqual(bad, [], "an on-screen window is invisible or cloaked")
    return { listed: windows.length, onScreen: onScreen.length, titles: onScreen.map((window) => window.title).slice(0, 20) }
  })

  let elements: z.infer<typeof Elements> = []
  let windowBounds: { x: number; y: number; width: number; height: number } | undefined
  let scale = 1
  await check("get_window_state: UI Automation tree with tokens and a screenshot of the window", async () => {
    const state = await call("get_window_state", target)
    elements = Elements.parse(state.data.elements)
    windowBounds = Bounds.parse(state.data.window_bounds)
    scale = Scale.parse(state.data.screenshot_scale) ?? 1
    const field = elements.find((element) => element.role === "Edit" && element.label === "Proof")
    const button = elements.find((element) => element.role === "Button" && element.label === "Verify proof")
    assert.ok(field?.element_token && button?.element_token, `Proof field and button with tokens: ${JSON.stringify(elements.slice(0, 30))}`)
    // The field is empty: an exact value says so, as the Mac and Linux drivers do, rather than leaving it out.
    assert.equal(field.value, "", "the empty field's value is read as it is")
    assert.equal(field.value_exact, true, "the field's value is exact")
    assert.equal(state.images.length, 1, "one screenshot")
    const image = pngSize(state.images[0]!.data)
    return { elements: elements.length, roles: [...new Set(elements.map((element) => element.role))], image, scale, windowBounds, keys: Object.keys(state.data), field, button }
  })
  const token = (role: string, label: string) => {
    const found = elements.find((element) => element.role === role && element.label === label)?.element_token
    assert.ok(found, `${role} "${label}" has a token`)
    return found
  }
  const fresh = async () => {
    elements = Elements.parse((await call("get_window_state", { ...target, include_screenshot: false })).data.elements)
  }

  const front = await foreground()
  await check("set_value writes the field through UI Automation, in the background", async () => {
    await call("set_value", { ...target, element_token: token("Edit", "Proof"), value: "uia-proof" })
    await until(async () => (await fixture.read()).input === "uia-proof", "the field shows uia-proof")
    assert.equal(await foreground(), front, "the foreground window did not change")
  })

  await check("click on an element token invokes the button, in the background", async () => {
    await fresh()
    await call("click", { ...target, element_token: token("Button", "Verify proof") })
    const state = await until(async () => { const s = await fixture.read(); return s.presses === 1 && s }, "one press")
    assert.equal(state.verified, "uia-proof")
    assert.equal(await foreground(), front, "the foreground window did not change")
  })

  await check("click on a check box toggles it", async () => {
    await fresh()
    await call("click", { ...target, element_token: token("CheckBox", "Enabled") })
    await until(async () => (await fixture.read()).checked, "checked")
  })

  // Window-local screenshot pixels to the fixture's client pixels.
  const toClient = async (x: number, y: number) => {
    const state = await fixture.read()
    assert.ok(windowBounds)
    return { x: Math.round(windowBounds.x + x / scale - state.client.left), y: Math.round(windowBounds.y + y / scale - state.client.top) }
  }
  const canvasPoint = async (clientX: number, clientY: number) => {
    const state = await fixture.read()
    assert.ok(windowBounds)
    return { x: Math.round((state.client.left + clientX - windowBounds.x) * scale), y: Math.round((state.client.top + clientY - windowBounds.y) * scale) }
  }
  const near = (event: string | undefined, expected: { x: number; y: number }) => {
    const match = /:(-?\d+),(-?\d+)$/.exec(event ?? "")
    return match !== null && Math.abs(Number(match[1]) - expected.x) <= 2 && Math.abs(Number(match[2]) - expected.y) <= 2
  }

  await check("click at window pixels lands at that point, in the background", async () => {
    // Client pixels inside the canvas, which spans (240,84)–(620,464) of the client area.
    const point = await canvasPoint(300, 200)
    const before = (await fixture.read()).mouse.length
    const result = await call("click", { ...target, x: point.x, y: point.y })
    const state = await until(async () => { const s = await fixture.read(); return s.mouse.length >= before + 2 && s }, "press and release")
    const events = state.mouse.slice(before)
    assert.ok(events[0]?.startsWith("down:Left") && near(events[0], { x: 300, y: 200 }), `press at (300,200): ${events.join(" ")}`)
    assert.ok(events.some((event) => event.startsWith("up:Left")), "released")
    return { events, sent: point, expected: await toClient(point.x, point.y), foregroundUnchanged: (await foreground()) === front, result: result.data }
  })

  await check("double_click and right_click reach the canvas, in the background", async () => {
    const point = await canvasPoint(420, 330)
    const before = (await fixture.read()).mouse.length
    const cursor = (await call("get_cursor_position", {})).data
    const double = await call("double_click", { ...target, x: point.x, y: point.y })
    await until(async () => (await fixture.read()).mouse.slice(before).some((event) => event.startsWith("double:Left")), `a double click (driver: ${double.text})`)
    const middle = (await fixture.read()).mouse.length
    const right = await call("right_click", { ...target, x: point.x, y: point.y })
    const state = await until(async () => { const s = await fixture.read(); return s.mouse.slice(middle).some((event) => event.startsWith("up:Right")) && s }, `a right click (driver: ${right.text})`)
    // The holder covers the fixture: input sent through the system queue would have landed on the holder. And the
    // person's pointer stays where it was.
    assert.deepEqual((await call("get_cursor_position", {})).data, cursor, "the pointer did not move")
    return { events: state.mouse.slice(before), double: double.data, right: right.data, foregroundUnchanged: (await foreground()) === front }
  })

  await check("drag presses, moves and releases along the path, in the background", async () => {
    const from = await canvasPoint(270, 110)
    const to = await canvasPoint(580, 430)
    const before = (await fixture.read()).mouse.length
    const cursor = (await call("get_cursor_position", {})).data
    const dragged = await call("drag", { ...target, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y })
    const state = await until(async () => { const s = await fixture.read(); return s.mouse.slice(before).some((event) => event.startsWith("up:Left")) && s }, `a release (driver: ${dragged.text})`)
    const events = state.mouse.slice(before)
    const down = events.find((event) => event.startsWith("down:Left"))
    assert.ok(near(down, { x: 270, y: 110 }), `pressed at the start: ${events.join(" ")}`)
    assert.ok(events.filter((event) => event.startsWith("move:Left")).length >= 2, `moved with the button held: ${events.join(" ")}`)
    assert.ok(near(events.findLast((event) => event.startsWith("up:Left")), { x: 580, y: 430 }), `released at the end: ${events.join(" ")}`)
    assert.deepEqual((await call("get_cursor_position", {})).data, cursor, "the pointer did not move")
    return { count: events.length, first: down, last: events.at(-1), driver: dragged.data, foregroundUnchanged: (await foreground()) === front }
  })

  await check("scroll moves the list through UI Automation, in the background", async () => {
    await fresh()
    const list = elements.find((element) => element.role === "List" && element.label === "Items")
    assert.ok(list?.element_token && list.frame && windowBounds)
    const x = Math.round((list.frame.x + list.frame.w / 2 - windowBounds.x) * scale)
    const y = Math.round((list.frame.y + list.frame.h / 2 - windowBounds.y) * scale)
    // A posted wheel is one of the messages Windows Forms drops: the driver refuses it rather than report a scroll.
    const pixel = await call("scroll", { ...target, x, y, direction: "down", amount: 5 }).then((result) => result.text, (error: Error) => error.message)
    const result = await call("scroll", { ...target, element_token: list.element_token, direction: "down", amount: 5 })
    const state = await until(async () => { const s = await fixture.read(); return s.topIndex > 0 && s }, `the list scrolled (driver: ${result.text})`)
    return { topIndex: state.topIndex, result: result.data, pixelBackground: pixel.slice(0, 300), foregroundUnchanged: (await foreground()) === front }
  })

  await check("type_text types Unicode and press_key reaches the field, in the background", async () => {
    await fresh()
    await call("set_value", { ...target, element_token: token("Edit", "Proof"), value: "" })
    // A posted click puts the field's caret in its own window, which stays behind; keys then go to that control.
    const field = elements.find((element) => element.role === "Edit" && element.label === "Proof")
    assert.ok(field?.frame && windowBounds)
    await call("click", { ...target, x: Math.round((field.frame.x + 10 - windowBounds.x) * scale), y: Math.round((field.frame.y + field.frame.h / 2 - windowBounds.y) * scale) })
    const typed = await call("type_text", { ...target, text: "Hëllo, wörld ✓ 漢字 😀" })
    // The window gets every character, the emoji as its surrogate pair; the classic edit control keeps the BMP text.
    const landed = await until(async () => { const s = await fixture.read(); return s.typed.endsWith("Hëllo, wörld ✓ 漢字 😀") && s.input.startsWith("Hëllo, wörld ✓ 漢字") && s }, `Unicode text typed (driver: ${typed.text})`)
    assert.equal(await foreground(), front, "typing did not bring the window forward")
    await call("press_key", { ...target, key: "end" })
    const key = await call("press_key", { ...target, key: "backspace" })
    await until(async () => { const s = await fixture.read(); return s.input.length < landed.input.length && landed.input.startsWith(s.input) }, `backspace (driver: ${key.text})`)
    assert.equal(await foreground(), front, "keys did not bring the window forward")
    // Addressed to an element, the driver first gives it focus through UI Automation; recorded, not required.
    await fresh()
    await call("type_text", { ...target, element_token: token("Edit", "Proof"), text: "!" })
    const elementFocusFronted = (await foreground()) !== front
    if (elementFocusFronted) {
      await call("bring_to_front", { pid: holder.pid, window_id: holder.hwnd })
      await until(async () => (await foreground()) === holder.hwnd, "the holder is foreground again")
    }
    return { typed: typed.data, key: key.data, field: landed.input, received: landed.typed.slice(-24), elementFocusFronted }
  })

  await check("zoom returns a crop of the window", async () => {
    const { images } = await call("zoom", { ...target, x1: 0, y1: 0, x2: 200, y2: 120 })
    assert.equal(images.length, 1)
    return pngSize(images[0]!.data)
  })

  await check("get_desktop_state captures the whole display", async () => {
    const { images, data } = await call("get_desktop_state", {}, 60_000)
    assert.ok(images.length >= 1)
    return { image: pngSize(images[0]!.data), keys: Object.keys(data) }
  })

  await check("get_screen_size and get_cursor_position", async () => {
    const size = await call("get_screen_size", {})
    const cursor = await call("get_cursor_position", {})
    return { size: size.data, cursor: cursor.data }
  })

  await check("clipboard: text and an image, read back from Windows", async () => {
    await call("clipboard_write", { text: "mako clipboard ✓" })
    const text = (await run("powershell.exe", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])).stdout.trim()
    assert.equal(text, "mako clipboard ✓")
    const read = await call("clipboard_read", { include_text: true })
    const image = join(root, "clip.png")
    await run("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Drawing; $b = New-Object Drawing.Bitmap 32,24; $b.SetPixel(1,1,[Drawing.Color]::Red); $b.Save('${image}')`])
    await call("clipboard_write", { image_path: image })
    const contains = (await run("powershell.exe", ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); \"$($i.Width)x$($i.Height)\""])).stdout.trim()
    assert.equal(contains, "32x24")
    return { read: read.data }
  })

  await check("Appshots through the broker", async () => {
    const appshots = new Appshots({ connect: () => broker!.connect({ kind: "appshots", label: "appshots" }, { parallel: true }), warm: () => broker!.warm() })
    const start = performance.now()
    const shot = await appshots.capture({ pid: fixture.pid, windowId: fixture.hwnd })
    assert.ok(shot.image.data.length > 1000)
    assert.match(shot.text, /Verify proof/)
    return { ms: ms(start), bytes: shot.image.data.length, text: shot.text.slice(0, 400) }
  })

  await check("bring_to_front brings the fixture forward despite the foreground lock", async () => {
    if ((await foreground()) !== holder.hwnd) await call("bring_to_front", { pid: holder.pid, window_id: holder.hwnd })
    const before = await until(async () => { const window = await foreground(); return window === holder.hwnd && window }, "the holder is foreground")
    const result = await call("bring_to_front", target)
    await until(async () => (await foreground()) === fixture.hwnd, `the fixture is foreground (driver: ${result.text})`)
    return { before, after: fixture.hwnd, driver: result.data }
  })

  await check("foreground delivery: SendInput click, chords, wheel and drag to the frontmost fixture", async () => {
    await fresh()
    await call("set_value", { ...target, element_token: token("Edit", "Proof"), value: "select me" })
    const field = elements.find((element) => element.role === "Edit" && element.label === "Proof")
    assert.ok(field?.frame && windowBounds)
    const fx = Math.round((field.frame.x + 20 - windowBounds.x) * scale)
    const fy = Math.round((field.frame.y + field.frame.h / 2 - windowBounds.y) * scale)
    await call("click", { ...target, x: fx, y: fy, delivery_mode: "foreground" })
    await call("hotkey", { ...target, keys: ["ctrl", "a"], delivery_mode: "foreground" })
    await call("type_text", { ...target, text: "front", delivery_mode: "foreground" })
    await until(async () => (await fixture.read()).input === "front", "ctrl+a then typing replaced the text")
    const state = await fixture.read()
    assert.ok(state.keys.some((key) => key === "down:A+ctrl"), `the window saw ctrl+a: ${state.keys.slice(-8).join(" ")}`)
    const list = elements.find((element) => element.role === "List" && element.label === "Items")
    assert.ok(list?.frame)
    const top = state.topIndex
    await call("scroll", { ...target, x: Math.round((list.frame.x + list.frame.w / 2 - windowBounds.x) * scale), y: Math.round((list.frame.y + list.frame.h / 2 - windowBounds.y) * scale), direction: "down", amount: 3, delivery_mode: "foreground" })
    const scrolled = await until(async () => { const s = await fixture.read(); return s.topIndex > top && s }, "the wheel scrolled the list")
    const point = await canvasPoint(300, 150)
    const before = scrolled.mouse.length
    await call("drag", { ...target, from_x: point.x, from_y: point.y, to_x: point.x + 120, to_y: point.y + 80, delivery_mode: "foreground" })
    const dragged = await until(async () => { const s = await fixture.read(); return s.mouse.slice(before).some((event) => event.startsWith("up:Left")) && s }, "a foreground drag")
    return { keys: state.keys.slice(-6), topIndex: scrolled.topIndex, drag: dragged.mouse.slice(before).filter((event) => !event.startsWith("move")) }
  })

  // The control runtime: a task's session over a grant from the broker, using the public program API.
  await check("control session: discover, observe, set, click and verify through the public API", async () => {
    const grant = await broker!.grant("agent windows-test")
    const session = controlSessionProbe(grant, "windows-control-test")
    const exec = async (source: string) => {
      const result = await session.request({ method: "exec", arguments: { source } })
      const text = result.content.filter((block) => block.type === "text").map((block) => ("text" in block ? String(block.text) : ""))
      if ("isError" in result && result.isError) throw new Error(text.join("\n"))
      return text
    }
    try {
      // The fixture goes behind the holder again: the runtime's actions are background ones.
      await call("bring_to_front", { pid: holder.pid, window_id: holder.hwnd })
      const foregroundBefore = await until(async () => { const window = await foreground(); return window === holder.hwnd && window }, "the holder is foreground")
      const canvas = await canvasPoint(520, 420)
      const mouseBefore = (await fixture.read()).mouse.length
      const start = performance.now()
      const discovered = await exec(`const wins = await control.windows(${fixture.pid}); return wins`)
      const observed = await exec(`let win = control.window({pid:${fixture.pid}, window_id:${fixture.hwnd}}); state.win = {pid:${fixture.pid}, window_id:${fixture.hwnd}}; return await win.observe()`)
      const acted = await exec(`const win = control.window(state.win);
        const view = await win.observe();
        const field = view.nodes.find(n => n.role === 'TextField' && n.name === 'Proof');
        await win.setValue(field.ref, 'runtime-proof');
        const again = await win.observe();
        const button = again.nodes.find(n => n.role === 'Button' && n.name === 'Verify proof');
        await win.click(button.ref);
        await win.expect({role:'TextField', name:'Proof', value:'runtime-proof'}, {timeoutMs:5000});
        const appshot = await win.appshot();
        const shot = await win.screenshot();
        // Window pixels, in the background: the route Windows now offers.
        await win.click({x: ${canvas.x}, y: ${canvas.y}, view: shot.view});
        return {field: field.ref, button: button.ref, shot: Object.keys(shot), appshot: Object.keys(appshot), routes: (await win.capabilities()).routes.map(r => r.route + ':' + r.status)}`)
      await until(async () => { const s = await fixture.read(); return s.verified === "runtime-proof" && s }, "the runtime's press verified the value")
      const clicked = await until(async () => { const s = await fixture.read(); return s.mouse.slice(mouseBefore).some((event) => event.startsWith("up:Left") && near(event, { x: 520, y: 420 })) && s }, "the runtime's pixel click reached the canvas")
      assert.equal(await foreground(), foregroundBefore, "the runtime's background actions left the foreground alone")
      return { ms: ms(start), discovered: discovered.join("\n").slice(0, 600), observed: observed.join("\n").slice(0, 1500), acted, pixelClick: clicked.mouse.slice(mouseBefore) }
    } finally {
      await session.close()
      broker!.revoke("agent windows-test")
    }
  })

  // Notepad and Calculator, as they come with Windows.
  await check("launch_app Notepad, type into it and read the text back", async () => {
    const before = await foreground()
    const launched = await call("launch_app", { name: "notepad" }, 60_000)
    const pid = Pid.parse(launched.data.pid)
    const windows = await until(async () => { const w = Windows.parse((await call("list_windows", { pid })).data.windows).filter((window) => window.is_on_screen); return w.length > 0 && w }, "Notepad's window", 20_000)
    const window = windows[0]!
    const notepad = { pid, window_id: window.window_id }
    const launchedInBackground = (await foreground()) === before
    const editor = async () => Elements.parse((await call("get_window_state", { ...notepad, include_screenshot: false })).data.elements).find((element) => ["Document", "Edit"].includes(element.role) && element.element_token !== undefined)
    const empty = await editor()
    assert.ok(empty?.element_token, "Notepad's editor is in the tree")
    assert.equal(empty.value, "", "the empty editor reads as empty")
    // Posted characters: the driver reads the editor back and says whether they landed.
    const background = await call("type_text", { ...notepad, text: "bg" }).then((result) => ({ text: result.text.slice(0, 300), data: result.data }), (error: Error) => ({ refused: error.message.slice(0, 300) }))
    const afterBackground = (await editor())?.value
    await call("bring_to_front", notepad)
    await until(async () => (await foreground()) === window.window_id, "Notepad is foreground")
    const field = await editor()
    assert.ok(field?.element_token)
    await call("click", { ...notepad, element_token: field.element_token, delivery_mode: "foreground" })
    await call("hotkey", { ...notepad, keys: ["ctrl", "a"], delivery_mode: "foreground" })
    const typed = await call("type_text", { ...notepad, text: "Mako was here ✓", delivery_mode: "foreground" })
    const after = await until(async () => { const e = await editor(); return e?.value === "Mako was here ✓" && e }, `typed text in Notepad (driver: ${typed.text})`)
    await call("kill_app", { pid }).catch(() => undefined)
    return { pid, title: window.title, value: after.value, exact: after.value_exact, launchedInBackground, background, afterBackground, launch: launched.text.split("\n")[0] }
  })

  await check("Calculator (where Windows has it): press 7 + 8 = and read 15", async () => {
    const launched = await call("launch_app", { name: "Calculator" }, 60_000).catch((error: Error) => ({ failed: error.message }))
    if ("failed" in launched) return { skipped: `Calculator could not be launched here: ${launched.failed.slice(0, 300)}` }
    const pid = Pid.parse(launched.data.pid)
    const windows = await until(async () => { const w = Windows.parse((await call("list_windows", { pid })).data.windows).filter((window) => window.is_on_screen); return w.length > 0 && w }, "Calculator's window", 20_000)
    const target = { pid, window_id: windows[0]!.window_id }
    const press = async (name: RegExp) => {
      const list = Elements.parse((await call("get_window_state", { ...target, include_screenshot: false })).data.elements)
      const button = list.find((element) => element.role === "Button" && name.test(element.label ?? ""))
      assert.ok(button?.element_token, `button ${name}: ${JSON.stringify(list.filter((e) => e.role === "Button").map((e) => e.label))}`)
      await call("click", { ...target, element_token: button.element_token })
    }
    await press(/^(7|Seven)$/)
    await press(/^(Add|Plus)$/)
    await press(/^(8|Eight)$/)
    await press(/^Equals$/)
    let seen: unknown
    const display = await until(async () => {
      const list = Elements.parse((await call("get_window_state", { ...target, include_screenshot: false })).data.elements)
      seen = list.filter((element) => /display|result|15/i.test(`${element.label ?? ""} ${String(element.value ?? "")}`)).map((element) => [element.role, element.label, element.value])
      return list.find((element) => /\b15\b/.test(`${element.label ?? ""} ${String(element.value ?? "")}`) && /display|result/i.test(`${element.label ?? ""}`))
    }, "Calculator shows 15").catch((error: Error) => { throw new Error(`${error.message}: ${JSON.stringify(seen)}`) })
    await call("kill_app", { pid }).catch(() => undefined)
    return { display: display.label }
  })

  // UIPI: Windows drops input a process sends to a window of a higher integrity level, and PostMessage still returns
  // success. The fixture runs at the runner's High integrity; a copy of the driver labelled Low runs below it, as
  // Mako's driver runs below an elevated app on a person's machine.
  await check("UIPI: a driver below an elevated window refuses input to it instead of reporting success", async () => {
    const low = join(root, "cua-driver-low.exe")
    await copyFile(driverPath, low)
    await run("icacls", [low, "/setintegritylevel", "Low"])
    const pipe = `\\\\.\\pipe\\mako-cua-low-${process.pid}`
    const child = spawn(low, ["serve", "--no-overlay", "--socket", pipe], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_PERMISSION_MODE: "standard" } })
    children.push(child)
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000) })
    const ask = async (name: string, args: JsonObject) => parseReply(await exchange(pipe, { method: "call", name, args }, 30_000))
    try {
      await until(async () => (await ask("check_permissions", {})).ok, "the low-integrity driver answers", 20_000).catch((error: Error) => { throw new Error(`${error.message}; stderr: ${stderr}`) })
      const permissions = await ask("check_permissions", {})
      const point = await canvasPoint(500, 400)
      const before = (await fixture.read()).mouse.length
      const click = await ask("click", { ...target, x: point.x, y: point.y })
      const typed = await ask("type_text", { ...target, text: "uipi" })
      const state = await ask("get_window_state", { ...target, include_screenshot: true })
      await new Promise((done) => setTimeout(done, 500))
      const after = await fixture.read()
      assert.equal(after.mouse.length, before, "nothing reached the elevated window")
      const text = (reply: ReturnType<typeof parseReply>) => JSON.stringify(reply).slice(0, 500)
      assert.match(text(click), /UIPI|integrity/i, "the click is refused and says why")
      return { permissions: text(permissions), click: text(click), typed: text(typed), observe: text(state) }
    } finally {
      child.kill()
    }
  })

  // Recording a window: the driver's window video is Windows Graphics Capture and Media Foundation in the video
  // helper, written as fragmented MP4 by the driver, and read back here with Mediabunny, as Mako reads a recording.
  await check("no FFmpeg is reachable while recording", async () => {
    const found = await run("where.exe", ["ffmpeg"]).then((result) => result.stdout.trim(), () => "")
    assert.equal(found, "", `ffmpeg resolves to ${found}`)
    return { folders: process.env[pathKey]?.split(delimiter).length }
  })

  await check("start_recording records the window through the video helper; Mediabunny reads the MP4", async () => {
    const directory = join(root, "driver-recording")
    const id = "windows-recording-check"
    const started = await call("start_recording", { recording_id: id, output_dir: directory, record_video: true, capture_actions: false, window_target: target, fps: 30 })
    assert.equal(started.data.video_active, true, `video started: ${started.text}`)
    for (let index = 0; index < 6; index++) {
      await fresh()
      await call("set_value", { ...target, element_token: token("Edit", "Proof"), value: `frame ${index}` })
      await new Promise((done) => setTimeout(done, 300))
    }
    await new Promise((done) => setTimeout(done, 500))
    const stopped = await call("stop_recording", { recording_id: id }, 30_000)
    const path = String(stopped.data.last_video_path ?? "")
    // The driver names the file by its canonical, verbatim path (\\?\C:\…); the same file either way.
    assert.equal(await realpath(path), await realpath(join(directory, "recording.mp4")), `the video's path: ${stopped.text}`)
    const video = await readMp4(path)
    assert.ok(video, "Mediabunny reads the recording")
    assert.ok(video.codec?.startsWith("avc1."), `H.264: ${video.codec}`)
    assert.ok(video.packets.length >= 4, `the field's changes are frames: ${video.packets.length}`)
    assert.ok(video.duration >= 2, `the video lasts the recording: ${video.duration} s`)
    const pixels = { width: Number(video.width), height: Number(video.height) }
    assert.ok(Math.abs(pixels.width - (windowBounds?.width ?? 0)) <= 16 && Math.abs(pixels.height - (windowBounds?.height ?? 0)) <= 16, `the window's size: ${JSON.stringify(pixels)}`)
    return { ...pixels, frames: video.packets.length, seconds: video.duration, codec: video.codec, error: stopped.data.last_error ?? null }
  })

  await check("a task's recording through the public API, read back with Mediabunny", async () => {
    const grant = await broker!.grant("agent windows-recording")
    const session = controlSessionProbe(grant, "windows-recording-test")
    try {
      const result = await session.request({ method: "exec", arguments: { source: `const win = control.window({pid:${fixture.pid}, window_id:${fixture.hwnd}});
        await win.observe();
        const recording = await win.record({fps: 30});
        for (let i = 0; i < 4; i++) { const view = await win.observe(); await win.setValue(view.nodes.find(n => n.role === 'TextField' && n.name === 'Proof').ref, 'recorded ' + i); await new Promise(r => setTimeout(r, 300)) }
        let receipt = await recording.stop();
        // stop() returns while the video is finalized; status() says when it is done.
        for (let i = 0; i < 100 && ['recording', 'finalizing'].includes(receipt.status); i++) { await new Promise(r => setTimeout(r, 200)); receipt = await recording.status() }
        return {status: receipt.status, video: receipt.video, error: receipt.error ?? null, dimensions: receipt.dimensions, durationMs: receipt.durationMs}` } })
      const text = result.content.filter((block) => block.type === "text").map((block) => ("text" in block ? String(block.text) : ""))
      if ("isError" in result && result.isError) throw new Error(text.join("\n"))
      const receipt = RecordingReceipt.parse(JSON.parse(text.at(-1)!))
      assert.ok(receipt.status === "finished" && receipt.video, JSON.stringify(receipt))
      const video = await readMp4(receipt.video)
      assert.ok(video && video.packets.length >= 3 && video.duration > 1, `the task's video reads back: ${JSON.stringify(video && { frames: video.packets.length, seconds: video.duration })}`)
      return { ...receipt, frames: video.packets.length, seconds: video.duration }
    } finally {
      await session.close()
      broker!.revoke("agent windows-recording")
    }
  })

  await check("the daemon got none of the inherited driver settings and listens on no TCP port", async () => {
    const listeners = (await run("powershell.exe", ["-NoProfile", "-Command", `@(Get-NetTCPConnection -State Listen -OwningProcess ${daemonPid} -ErrorAction SilentlyContinue).Count`])).stdout.trim()
    assert.equal(listeners, "0", `the daemon's TCP listeners: ${listeners}`)
    for (const port of [mcpPort, envelopePort]) {
      const open = await new Promise<boolean>((done) => {
        const probe = connect({ host: "127.0.0.1", port })
        probe.once("connect", () => { probe.destroy(); done(true) })
        probe.once("error", () => done(false))
      })
      assert.equal(open, false, `nothing listens on 127.0.0.1:${port}`)
    }
    return { listeners: Number(listeners) }
  })

  await check("every connection has the daemon prove itself with the host's key", async () => {
    const address = cua.address()
    assert.ok(address?.key, "the host gave its daemon a key")
    assert.equal(await daemonAnswers(address.path, { key: address.key }), true, "the daemon answers the challenge")
    assert.equal(await daemonAnswers(address.path, { key: "0".repeat(64) }), false, "a wrong key is no proof")
    // What holds a pipe's name without the key, as a process that took the name first would: never spoken to.
    const impostor = `\\\\.\\pipe\\mako-cua-impostor-${process.pid}`
    let heard = ""
    const server = createServer((connection) => { connection.on("data", (chunk) => { heard += String(chunk); connection.write('{"ok":true,"result":{"proof":"00"}}\n') }); connection.on("error", () => undefined) })
    await new Promise<void>((done) => server.listen(impostor, done))
    try {
      assert.equal(await daemonAnswers(impostor, { key: address.key }), false, "an impostor on a pipe is refused")
      const impostorBroker = new DriverBroker({ socket: async () => impostor, daemon: () => ({ key: address.key }), own: () => [] })
      await assert.rejects(impostorBroker.connect({ kind: "appshots", label: "impostor" }), "the broker dispatches nothing to it")
      await impostorBroker.close()
      assert.ok(!/"call"|"list"|"metadata"|session_begin/.test(heard), `the impostor heard only challenges: ${heard.slice(0, 200)}`)
    } finally {
      server.close()
    }
    return { impostorHeard: heard.split("\n").filter(Boolean).length }
  })

  await check("launch_app by a bare name runs only an installed app or a program the host's lookup trusts", async () => {
    const ran = async (marker: string) => { await new Promise((done) => setTimeout(done, 1500)); return existsSync(marker) }
    const launch = (name: string) => call("launch_app", { name }).then((result) => `launched: ${result.text}`, (error: Error) => error.message)
    // A program in this user's own folder on PATH, which the host's lookup trusts: found there and run by whole path.
    const trustedMarker = join(root, "trusted-ran.txt")
    await writeFile(join(driverFolder, "mako-trusted-app.cmd"), `@echo ran> "${trustedMarker}"\r\n`)
    const trusted = await launch("mako-trusted-app")
    assert.ok(await ran(trustedMarker), `the trusted program ran: ${trusted}`)
    // A program of a name nothing trusted has, on PATH in a folder outside the profile: the host's lookup refuses the
    // folder, and the name never reaches the driver, whose own search would have found it.
    const outside = join(process.cwd(), "node_modules", ".tmp", `mako-untrusted-${process.pid}`)
    const untrustedMarker = join(root, "untrusted-ran.txt")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "mako-planted-app.cmd"), `@echo ran> "${untrustedMarker}"\r\n`)
    process.env[pathKey] = `${outside}${delimiter}${process.env[pathKey] ?? ""}`
    try {
      if (resolveExecutable("mako-planted-app")) return { trusted: trusted.slice(0, 120), untrusted: "this checkout is in a folder the lookup trusts; the refusal is not exercised here" }
      const planted = await launch("mako-planted-app")
      assert.match(planted, /no installed app is named/i, planted)
      assert.equal(await ran(untrustedMarker), false, "the planted program did not run")
      return { trusted: trusted.slice(0, 120), planted: planted.slice(0, 160) }
    } finally {
      process.env[pathKey] = (process.env[pathKey] ?? "").split(delimiter).filter((folder) => folder !== outside).join(delimiter)
      await rm(outside, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  await check("a recording path from the driver is taken only on a local drive", async () => {
    assert.equal(reportedPath.parse("\\\\?\\C:\\Users\\someone\\recording.mp4"), "C:\\Users\\someone\\recording.mp4")
    assert.equal(reportedPath.parse("C:\\plain\\recording.mp4"), "C:\\plain\\recording.mp4")
    assert.equal(reportedPath.safeParse("\\\\?\\UNC\\server\\share\\recording.mp4").success, false, "a verbatim network path is refused")
    assert.equal(reportedPath.safeParse("\\\\?\\GLOBALROOT\\Device\\x").success, false, "a device path is refused")
  })

  // The daemon's pipe: this host's process only. Another process of this user is closed on before a request is read,
  // and one below the daemon's integrity level cannot open the pipe at all.
  await check("only the host's own process is served on the driver's pipe", async () => {
    const script = "const s=require('net').connect(process.argv[1]);let said='';s.on('connect',()=>s.write(JSON.stringify({method:'metadata'})+'\\n'));s.on('data',d=>{said+=d});s.on('error',e=>{console.log('refused '+e.code);process.exit(0)});s.on('close',()=>{console.log(said?'answered':'closed unanswered');process.exit(0)});setTimeout(()=>{console.log(said?'answered':'silent');process.exit(0)},5000)"
    const own = parseReply(await exchange(socket, { method: "metadata" }, 10_000))
    assert.equal(own.ok, true, "the host's own process is answered")
    const other = (await run(process.execPath, ["-e", script, socket], { timeout: 30_000 })).stdout.trim()
    assert.match(other, /^(closed unanswered|refused \w+)$/, `another process of this user gets no answer: ${other}`)
    const low = join(root, "node-low.exe")
    await copyFile(process.execPath, low)
    await run("icacls", [low, "/setintegritylevel", "Low"])
    const below = (await run(low, ["-e", script, socket], { timeout: 30_000 })).stdout.trim()
    assert.match(below, /^refused (EPERM|EACCES)$/, `a low-integrity process cannot open it: ${below}`)
    return { other, below }
  })

  // Latency, warm, against the fixture in the background.
  await fresh()
  const canvas = await canvasPoint(200, 150)
  await timed("list_windows", 10, () => call("list_windows", { pid: fixture.pid }))
  await timed("screenshot (window, no tree)", 10, () => call("get_window_state", { ...target, include_accessibility_tree: false }))
  await timed("get_window_state (tree + screenshot)", 10, () => call("get_window_state", target))
  await timed("get_window_state (tree only)", 10, () => call("get_window_state", { ...target, include_screenshot: false }))
  await timed("zoom", 10, () => call("zoom", { ...target, x1: 0, y1: 0, x2: 200, y2: 120 }))
  await timed("click (window pixels)", 10, () => call("click", { ...target, x: canvas.x, y: canvas.y }))
  // A tree read replaces the window's snapshot: the token actions read it once more first.
  await fresh()
  await timed("click (element token)", 10, () => call("click", { ...target, element_token: token("Button", "Verify proof") }))
  await timed("set_value", 10, () => call("set_value", { ...target, element_token: token("Edit", "Proof"), value: "latency" }))
  await timed("type_text (10 characters)", 10, () => call("type_text", { ...target, element_token: token("Edit", "Proof"), text: "abcdefghij" }))
  await timed("press_key", 10, () => call("press_key", { ...target, key: "end" }))
  await timed("get_desktop_state (display)", 5, () => call("get_desktop_state", {}, 60_000))

  // Idle: nothing called for 90 s, the broker's lease still open. CPU time moves in 15.6 ms ticks on Windows, so the
  // driver's threads' context switches say more: how often anything in it wakes at all.
  await check("an idle driver costs nothing", async () => {
    await new Promise((done) => setTimeout(done, 3000))
    const before = await processSample(daemonPid)
    const host = process.cpuUsage()
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", `$s = Get-Counter -Counter '\\Thread(cua-driver*)\\Context Switches/sec' -SampleInterval 5 -MaxSamples 18; $s | ForEach-Object { ($_.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum } | ConvertTo-Json -Compress`], { timeout: 150_000 })
    const after = await processSample(daemonPid)
    const hostCpu = process.cpuUsage(host)
    const switches = Rates.parse(JSON.parse(stdout))
    const idle = {
      seconds: 90,
      driverCpuMs: after.cpu - before.cpu,
      contextSwitchesPerSecond: Math.round((switches.reduce((sum, value) => sum + value, 0) / switches.length) * 10) / 10,
      samples: switches.map((value) => Math.round(value * 10) / 10),
      driverWorkingSetMB: Math.round(after.ws / 1e6),
      driverPrivateMB: Math.round(after.private / 1e6),
      threads: after.threads,
      handles: after.handles,
      hostCpuMs: Math.round((hostCpu.user + hostCpu.system) / 1000),
    }
    results.idle = idle
    assert.ok(idle.driverCpuMs <= 50, `the idle driver used ${idle.driverCpuMs} ms of CPU in 90 s`)
    return idle
  })

  await check("stopping the host's driver ends the daemon", async () => {
    await client?.close()
    client = undefined
    await broker?.close()
    broker = undefined
    cua.stop()
    await until(async () => { try { await processSample(daemonPid); return false } catch { return true } }, "the daemon exited", 10_000)
  })
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await client?.close().catch(() => undefined)
  await broker?.close().catch(() => undefined)
  cua.stop()
  for (const child of children) child.kill()
  const failed = Object.entries(results.checks).filter(([, outcome]) => !outcome.ok).map(([name]) => name)
  if (failed.length) exitCode = 1
  console.log(failed.length ? `${failed.length} failed: ${failed.join("; ")}` : `all ${Object.keys(results.checks).length} checks passed`)
  if (values.json) await writeFile(values.json, JSON.stringify(results, null, 2))
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  await rm(driverFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  process.exit(exitCode)
}
