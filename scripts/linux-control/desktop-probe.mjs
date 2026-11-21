// Mako's computer control on a Linux desktop, through the path the host takes: the host's embedded driver
// (`CuaEmbedded`, started as on a person's desktop, with no test-only driver flags), the broker, a task session and
// the `mako-control` CLI an agent runs, plus the video helper for live video. One desktop per run, started by
// `desktop-session.sh` (X11, Sway or GNOME, in a container by `run-desktop.sh`); it writes a JSON line per operation with its time, then a summary, to
// $MAKO_EVIDENCE/desktop-<session>.json.
//
//   MAKO_DESKTOP=x11|sway|gnome MAKO_EVIDENCE=/evidence MAKO_CUA_EMBEDDED=… node desktop-probe.mjs
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { ControlCliProbe } from "../lib/control-cli-probe.mjs"

const run = promisify(execFile)
const kind = process.env.MAKO_DESKTOP
assert.ok(["x11", "sway", "gnome", "kde", "kde6"].includes(kind), "MAKO_DESKTOP is x11, sway, gnome, kde or kde6")
const evidence = process.env.MAKO_EVIDENCE ?? "/tmp/evidence"
const repo = new URL("../..", import.meta.url).pathname
const work = join(homedir(), "mako-desktop-probe")
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })
await mkdir(evidence, { recursive: true })
// The host's own module, bundled (README.md): the gate and environment a person's desktop gets.
assert.ok(process.env.MAKO_CUA_EMBEDDED, "MAKO_CUA_EMBEDDED names the bundled cua-embedded module")
const { CuaEmbedded } = await import(process.env.MAKO_CUA_EMBEDDED)
const { readMp4 } = await import(new URL("../../packages/control-runtime/dist/mp4.js", import.meta.url).href)
// Video never goes through FFmpeg: the run proves it with none to find.
assert.equal(await run("sh", ["-c", "command -v ffmpeg ffprobe"]).then(() => "found", () => "none"), "none", "no FFmpeg on PATH")
const { linuxDesktop, VideoHelper, helperWindowSource, videoHelperExecutable } = await import("@mako/control-runtime/desktop")

const report = { desktop: kind, session: linuxDesktop(), operations: [], numbers: {} }
// The session script logs in as a person would (XDG_SESSION_TYPE): without it the host would drive nothing here.
assert.ok(report.session, "the probe runs in a desktop session the host recognizes")
const log = (entry) => {
  report.operations.push(entry)
  console.log(JSON.stringify(entry))
}
/** Times one operation; a failure is recorded with its message and stops the run unless `optional`. */
async function step(name, fn, { optional = false, observe } = {}) {
  const started = performance.now()
  try {
    const value = await fn()
    log({ name, ok: true, ms: Math.round(performance.now() - started), detail: value ?? null })
    return value
  } catch (error) {
    log({ name, ok: false, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) })
    if (!optional) throw error
    // An action whose outcome is unknown holds the task until it observes again, as an agent must.
    await (observe ?? afterFailure)?.().catch(() => undefined)
    return undefined
  }
}
let afterFailure
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
async function until(fn, ms = 15_000) {
  const deadline = Date.now() + ms
  let last
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`Timed out: ${last?.message ?? "condition not reached"}`)
    await delay(50)
  }
}
/**
 * Waits until the wall clock's minute has `seconds` left: the panel's clock repaints when the minute turns (it was
 * the one frame in a still screen's last seconds, on 2026-11-21), and a stillness measure must not straddle that.
 */
const clockHolds = async (seconds) => {
  const left = 60 - (Date.now() / 1000) % 60
  if (left < seconds + 1) await delay((left + 0.5) * 1000)
}
const cpuSeconds = async (pid) => {
  const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" ")
  return (Number(fields[11]) + Number(fields[12])) / 100
}

// The fixture app and the terminal are installed as desktop entries, as an app the person has is.
const applications = join(homedir(), ".local/share/applications")
await mkdir(applications, { recursive: true })
const fixtureState = join(work, "fixture.json")
// Exec= as the desktop entry spec quotes it: a title with a space in quotes, and a field code the launch drops.
await writeFile(join(applications, "mako-fixture.desktop"), `[Desktop Entry]\nType=Application\nName=Mako Fixture\nExec=python3 "${repo}scripts/linux-control/fixture.py" "Mako fixture" "${fixtureState}" %U\n`)
// Terminals: xterm (X11 itself, or XWayland under Sway) and foot (native Wayland). Each writes the line it's typed.
const terminals = [
  { name: "xterm", title: "Mako xterm", command: (title, out) => `xterm -T "${title}" -e sh -c 'read line; echo "$line" > ${out}; sleep 60'` },
  ...(kind !== "x11" ? [{ name: "foot", title: "Mako foot", command: (title, out) => `foot --title "${title}" sh -c 'read line; echo "$line" > ${out}; sleep 60'` }] : []),
]
for (const terminal of terminals) {
  terminal.out = join(work, `${terminal.name}.txt`)
  await writeFile(join(work, `${terminal.name}.sh`), `#!/bin/sh\nexec ${terminal.command(terminal.title, terminal.out)}\n`, { mode: 0o755 })
  await writeFile(join(applications, `mako-${terminal.name}.desktop`), `[Desktop Entry]\nType=Application\nName=${terminal.title}\nExec=${join(work, `${terminal.name}.sh`)}\n`)
}

const cua = new CuaEmbedded()
const probe = new ControlCliProbe({ name: `linux-desktop-${kind}` })
let helper
try {
  const socket = await step("driver: start the embedded driver as the host does", async () => {
    const path = await cua.ensure(join(work, "cua"), "dev.mako.test", process.env)
    assert.ok(path, "The host's gate starts a driver on a Linux desktop")
    return path
  })
  await probe.start({ native: { socket }, env: { ...process.env } })
  const cli = async (args, input) => {
    const child = spawn(probe.session.launch.command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (bytes) => (stdout += bytes))
    child.stderr.on("data", (bytes) => (stderr += bytes))
    child.stdin.end(input ?? "")
    const code = await new Promise((done) => child.once("close", done))
    if (code !== 0) throw new Error(`mako-control ${args[0]} exited ${code}: ${stderr || stdout}`)
    return JSON.parse(stdout)
  }
  const program = async (source) => {
    const blocks = await cli(["exec", "--source-file", "-"], source)
    const result = blocks.filter((block) => block.type === "result").at(-1)
    return result?.value
  }

  // Launch through the app's desktop entry, then its window.
  const launched = await step("launch: GTK app by its desktop entry name", () => program(`return await control.native('launch_app',{name:'Mako Fixture'})`))
  const fixture = await until(() => read(fixtureState))
  const window = await step("windows: list and find the GTK app's window", async () => {
    const found = await until(async () => (await cli(["windows", "--pid", String(fixture.pid)])).windows.find((w) => w.title.startsWith("Mako fixture")))
    const all = await program(`return await control.native('list_windows',{})`)
    return { window_id: found.window_id, bounds: found.bounds, kind: found.kind, total: all.windows.length, backend: all.backend, titles: all.windows.map((w) => w.title) }
  })
  const target = { kind: "window", pid: fixture.pid, window_id: window.window_id }
  const targetFile = join(work, "target.json")
  await writeFile(targetFile, JSON.stringify(target))
  afterFailure = () => cli(["observe", "--target-file", targetFile])
  report.launch = { pid: launched?.pid ?? null, fixturePid: fixture.pid }

  await step("screenshot: the GTK window", async () => {
    const shot = await cli(["shot", "--target-file", targetFile, "--overwrite", "--output", join(evidence, `${kind}-window.png`)])
    assert.ok(shot.width > 100 && shot.height > 100, JSON.stringify(shot))
    assert.equal(shot.bytes, (await stat(shot.path)).size)
    return { width: shot.width, height: shot.height, bytes: shot.bytes }
  }, { optional: true })
  await step("accessibility: observe the GTK window's tree", async () => {
    const view = await cli(["observe", "--target-file", targetFile])
    assert.ok(view.nodes.length > 0)
    return { nodes: view.nodes.length }
  }, { optional: true })
  const text = `Linux ${kind}: 東京 é`
  await step("type: set the GTK text field and click Save (accessibility)", async () => {
    await program(`state.w=control.window(${JSON.stringify(target)});await state.w.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(text)});await state.w.locator({role:'Button',name:'Save'}).click();return true`)
    const saved = await until(async () => {
      const current = await read(fixtureState)
      return current.saves >= 1 ? current : null
    })
    assert.equal(saved.entry, text)
    return { saves: saved.saves, entry: saved.entry }
  }, { optional: true })
  await step("focus: bring the GTK window to the front", () =>
    program(`return await control.native('bring_to_front',{pid:${fixture.pid},window_id:${window.window_id},foreground:true})`),
    { optional: true }
  )
  await step("click: a pointer click on the GTK Save button (foreground, window pixels)", async () => {
    const before = (await read(fixtureState)).saves
    const node = await program(`const w=control.window(${JSON.stringify(target)});const v=await w.observe({match:{role:'Button',name:'Save'}});return v.nodes.find((n)=>n.name==='Save')`)
    const box = node?.box ?? node?.bounds ?? node?.frame
    const x = box ? box.x + box.width / 2 : window.bounds.width / 2
    const y = box ? box.y + box.height / 2 : window.bounds.height - 16
    await program(`return await control.native('click',{pid:${fixture.pid},window_id:${window.window_id},x:${Math.round(x)},y:${Math.round(y)},delivery_mode:'foreground',foreground:true})`)
    const after = await until(async () => ((await read(fixtureState)).saves > before ? read(fixtureState) : null))
    return { savesBefore: before, savesAfter: after.saves, at: { x: Math.round(x), y: Math.round(y) }, fromBox: Boolean(box), nodeKeys: Object.keys(node ?? {}) }
  }, { optional: true })
  await step("clipboard: write then read back", async () => {
    const value = `mako clipboard ${kind} ${Date.now()}`
    await program(`return await control.native('clipboard_write',{text:${JSON.stringify(value)}})`)
    const back = await program(`return await control.native('clipboard_read',{include_text:true})`)
    const text = back?.text ?? back?.content?.find?.((block) => block.type === "text")?.text
    assert.ok(JSON.stringify(back).includes(value), JSON.stringify(back))
    return { value, read: text ?? back }
  }, { optional: true })

  // An X11 app under XWayland on a Wayland desktop: the same GTK fixture with GDK's X11 backend.
  if (kind !== "x11") {
    const xState = join(work, "xwayland.json")
    await writeFile(join(applications, "mako-xwayland.desktop"), `[Desktop Entry]\nType=Application\nName=Mako XWayland Fixture\nExec=env GDK_BACKEND=x11 python3 "${repo}scripts/linux-control/fixture.py" "Mako XWayland fixture" "${xState}"\n`)
    await step("xwayland: launch, list, type and save in an X11 GTK app", async () => {
      await program(`return await control.native('launch_app',{name:'Mako XWayland Fixture'})`)
      const state = await until(() => read(xState))
      const found = await until(async () => (await cli(["windows", "--pid", String(state.pid)])).windows.find((w) => w.title.startsWith("Mako XWayland fixture")))
      const xTarget = { kind: "window", pid: state.pid, window_id: found.window_id }
      await program(`const w=control.window(${JSON.stringify(xTarget)});await w.locator({role:'TextArea',name:'Exact text'}).setValue('xwayland');await w.locator({role:'Button',name:'Save'}).click();return 1`)
      const saved = await until(async () => ((await read(xState)).saves >= 1 ? read(xState) : null))
      await writeFile(join(work, "xwayland-target.json"), JSON.stringify(xTarget))
      return { window_id: found.window_id, entry: saved.entry, saves: saved.saves }
    }, { optional: true })
    await step("xwayland: screenshot of the X11 GTK app's window", async () => {
      const shot = await cli(["shot", "--target-file", join(work, "xwayland-target.json"), "--overwrite", "--output", join(evidence, "sway-xwayland-window.png")])
      return { width: shot.width, height: shot.height }
    }, { optional: true })
  }

  // Terminals: no accessibility text, so keys to the focused window.
  for (const terminal of terminals) {
    const term = await step(`launch: ${terminal.name} by its desktop entry name`, () => program(`return await control.native('launch_app',{name:${JSON.stringify(terminal.title)}})`), { optional: true })
    const termWindow = await step(`windows: find the ${terminal.name} window`, () =>
      until(async () => {
        const all = await program(`return await control.native('list_windows',{pid:${term?.pid ?? 0}})`)
        return all.windows.find((w) => w.title.startsWith(terminal.title))
      }).catch(async (error) => {
        const all = await program(`return await control.native('list_windows',{})`)
        throw new Error(`${error.message}; windows: ${JSON.stringify(all.windows.map((w) => [w.title, w.pid, w.window_id]))}`)
      }), { optional: true })
    if (!termWindow) continue
    const termTarget = join(work, `${terminal.name}-target.json`)
    await writeFile(termTarget, JSON.stringify({ kind: "window", pid: termWindow.pid, window_id: termWindow.window_id }))
    await step(`type: keys into ${terminal.name} once it's focused (foreground)`, async () => {
      const address = { pid: termWindow.pid, window_id: termWindow.window_id }
      await program(`return await control.native('bring_to_front',{...${JSON.stringify(address)},foreground:true})`)
      await program(`await control.native('type_text',{...${JSON.stringify(address)},text:'typed by mako',delivery_mode:'foreground',foreground:true});return await control.native('press_key',{...${JSON.stringify(address)},key:'Return',delivery_mode:'foreground',foreground:true})`)
      const typed = await until(async () => (await readFile(terminal.out, "utf8")).trim())
      assert.equal(typed, "typed by mako")
      return { typed, launchedPid: term?.pid ?? null, window_id: termWindow.window_id }
    }, { optional: true, observe: () => cli(["observe", "--target-file", termTarget]) })
    // A terminal's blinking cursor is real damage; it would be counted as the idle screen's frames below.
    await program(`return await control.native('kill_app',{pid:${termWindow.pid}})`).catch(() => process.kill(termWindow.pid))
  }

  // Live video: the helper the host starts for a window preview when no desktop app is attached.
  const executable = videoHelperExecutable()
  assert.ok(executable, "the video helper is built")
  const source = helperWindowSource(window.window_id, linuxDesktop())
  report.liveVideoSource = source
  const { Mp4Writer } = await import(new URL("../../packages/control-runtime/dist/mp4.js", import.meta.url).href)
  if (kind === "gnome") {
    // After foreground input on GNOME: the driver's Shell helper used to leave its agent cursor floating at 30 fps for
    // ever. Its cursor now holds still at rest, and the embedded daemon (--no-overlay) shows none.
    // Closing the terminals above animates for a moment: the measure starts once that's over.
    await delay(2000)
    // MAKO_STILL_LOOPS=N repeats it, a foreground click before each, to hold a stray repaint to a count.
    const rounds = 1 + Number(process.env.MAKO_STILL_LOOPS ?? 0)
    report.numbers.agentCursorIdle = await step(`live video: GNOME stays still after foreground input${rounds > 1 ? `, ${rounds} times` : ""}`, async () => {
      const seen = []
      for (let round = 0; round < rounds; round++) {
        if (round > 0) {
          await program(`await control.native('bring_to_front',{pid:${fixture.pid},window_id:${window.window_id},foreground:true});return await control.native('click',{pid:${fixture.pid},window_id:${window.window_id},x:${Math.round(window.bounds.width / 2)},y:${window.bounds.height - 16},delivery_mode:'foreground',foreground:true})`).catch(() => undefined)
          await cli(["observe", "--target-file", targetFile]).catch(() => undefined)
          await delay(1500)
        }
        await clockHolds(7)
        // Its units kept as an MP4 beside the evidence, so what changed can be seen frame by frame.
        const path = join(evidence, `gnome-after-input${round ? `-${round}` : ""}.mp4`)
        await rm(path, { force: true })
        const mp4 = new Mp4Writer(path, 1000 / 30)
        const opened = performance.now()
        let writing = Promise.resolve()
        const times = []
        const still = new VideoHelper(executable, source, { fps: 30 }, {
          unit: (packet) => {
            const at = performance.now() - opened
            times.push(at)
            writing = writing.then(() => mp4.add(packet, at))
          },
          ended: () => {},
        })
        await delay(6000)
        still.close()
        await still.exited
        await writing
        await mp4.finish()
        // The windows the terminals left, or the click's own feedback, repaint for a moment; then nothing moves. The
        // floating cursor redrew at 20 to 26 fps for as long as it was up.
        const settled = times.filter((at) => at > 3000).length
        assert.equal(settled, 0, `the screen kept changing in round ${round}: ${times.length} frames in 6 s, ${settled} in its last 3 s (${path})`)
        seen.push(times.length)
        if (round > 0) await rm(path, { force: true })
      }
      return { rounds, frames: seen, lastThreeSeconds: 0, seconds: 6 }
    }, { optional: true })
  }
  await step("live video: first frame, idle cost, frames under activity, its units as MP4", async () => {
    const units = []
    let ended
    const opened = performance.now()
    // The helper's units, as a recording's encoder writes them, into Mako's MP4 writer.
    const mp4Path = join(evidence, `${kind}-helper.mp4`)
    await rm(mp4Path, { force: true })
    const mp4 = new Mp4Writer(mp4Path, 1000 / 30)
    let writing = Promise.resolve()
    helper = new VideoHelper(executable, source, { fps: 30 }, {
      unit: (packet) => {
        const at = performance.now()
        units.push({ at, key: packet.kind === "key", bytes: packet.data.byteLength, lag: Date.now() - packet.capturedAt })
        writing = writing.then(() => mp4.add(packet, at - opened))
      },
      ended: (reason) => (ended = reason),
    })
    await until(() => units.length > 0 || ended, 60_000)
    if (ended && !units.length) throw new Error(ended)
    const first = Math.round(units[0].at - opened)
    const pid = Number((await run("pgrep", ["-n", "-x", "mako-video"])).stdout.trim())
    await delay(1000)
    await clockHolds(6)
    const idleFrom = units.length
    const idleCpu = await cpuSeconds(pid)
    await delay(5000)
    const idle = { frames: units.length - idleFrom, cpuSeconds: +((await cpuSeconds(pid)) - idleCpu).toFixed(3), seconds: 5 }
    const busyFrom = units.length
    const busyCpu = await cpuSeconds(pid)
    const started = performance.now()
    const toFrame = []
    for (let i = 0; i < 10; i++) {
      const sent = performance.now()
      await program(`const w=control.window(${JSON.stringify(target)});await w.locator({role:'TextArea',name:'Exact text'}).setValue('frame ${i}');return 1`)
      const shown = await until(() => units.find((unit) => unit.at > sent), 3000).catch(() => undefined)
      if (shown) toFrame.push(shown.at - sent)
    }
    const busySeconds = (performance.now() - started) / 1000
    const busy = { frames: units.length - busyFrom, cpuSeconds: +((await cpuSeconds(pid)) - busyCpu).toFixed(3), seconds: +busySeconds.toFixed(1) }
    helper.close()
    await helper.exited
    await writing
    await mp4.finish()
    const video = await readMp4(mp4Path)
    const median = (values) => (values.length ? Math.round([...values].sort((a, b) => a - b)[values.length >> 1]) : null)
    return {
      firstFrameMs: first,
      keyFirst: units[0].key,
      idle,
      busy,
      totalUnits: units.length,
      encodeLagMs: median(units.map((unit) => unit.lag)),
      actionToFrameMs: median(toFrame),
      mp4: { codec: video.codec, width: video.width, height: video.height, frames: video.packets.length, seconds: video.duration },
    }
  }, { optional: true })

  if (source?.kind === "portal")
    await step("live video: a second portal session restores the person's answer; its idle buffers", async () => {
      const consent = join(evidence, `${kind}-consent.jsonl`)
      const answers = async () => (await readFile(consent, "utf8").catch(() => "")).split("\n").filter(Boolean).length
      const before = await answers()
      const token = (await readFile(source.restore, "utf8").catch(() => "")).length > 0
      // The helper itself, so its summary says what PipeWire sent and what it skipped as undamaged.
      await clockHolds(10)
      const opened = performance.now()
      const child = spawn(executable, ["portal", "--types", source.types, "--restore", source.restore, ...(source.still ? ["--still", "screenshot"] : []), "--cursor", "embedded", "--fps", "30"], { stdio: ["pipe", "pipe", "pipe"] })
      let first
      let stderr = ""
      child.stdout.once("data", () => (first = performance.now()))
      child.stderr.on("data", (bytes) => (stderr += bytes))
      // On wlroots a still screen's first picture is the Screenshot portal's: nothing on screen changes here.
      await until(() => first, 10_000)
      await delay(6000)
      child.stdin.end()
      await new Promise((done) => child.once("close", done))
      const summary = JSON.parse(stderr.trim().split("\n").at(-1))
      return { tokenKept: token, firstFrameMs: Math.round(first - opened), stillScreenshot: stderr.includes("Screenshot portal"), cursor: /cursor (\w+)/.exec(stderr)?.[1] ?? null, dialogsAnsweredBefore: before, dialogsAnsweredAfter: await answers(), idleSixSeconds: summary }
    }, { optional: true })

  if (source?.kind === "portal" && source.still)
    await step("live video: a still screen's first frame from the Screenshot portal", async () => {
      // Taken whatever the stream sent, to prove the path a lost or withheld first frame falls back on.
      const child = spawn(executable, ["portal", "--types", source.types, "--restore", source.restore, "--still", "screenshot-always", "--fps", "30"], { stdio: ["pipe", "pipe", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (bytes) => (stderr += bytes))
      await until(() => /Screenshot portal/.test(stderr), 30_000).catch(() => undefined)
      child.stdin.end()
      await new Promise((done) => child.once("close", done))
      const took = /first frame from the Screenshot portal in (\d+) ms/.exec(stderr)
      assert.ok(took, stderr.trim().split("\n").slice(-3).join("; "))
      return { screenshotMs: Number(took[1]) }
    }, { optional: true })

  const recording = await step("record: start a recording of the GTK window", async () => {
    const capabilities = await program(`return await control.window(${JSON.stringify(target)}).capabilities()`)
    const fps = Math.min(15, capabilities.recording.maxFps)
    const receipt = await cli(["record", "start", "--target-file", targetFile, "--directory", join(work, "recordings"), "--fps", String(fps)])
    await writeFile(join(work, "recording.json"), JSON.stringify(receipt))
    return receipt
  }, { optional: true })
  for (let i = 0; i < 6; i++) {
    await program(`const w=control.window(${JSON.stringify(target)});await w.locator({role:'TextArea',name:'Exact text'}).setValue('recorded ${i}');return 1`)
    await delay(300)
  }
  // A pointer action while recording: the driver's journal records where it landed, and finishing draws it in.
  const clicked = await program(`await control.native('bring_to_front',{pid:${fixture.pid},window_id:${window.window_id},foreground:true});return await control.native('click',{pid:${fixture.pid},window_id:${window.window_id},x:${Math.round(window.bounds.width / 2)},y:${window.bounds.height - 16},delivery_mode:'foreground',foreground:true})`).then(() => true, (error) => String(error.message).slice(0, 300))
  await delay(500)
  if (recording) await step("record: stop and read the MP4 back", async () => {
    const done = await cli(["record", "stop", "--input", join(work, "recording.json"), "--wait"])
    assert.equal(done.status, "finished", JSON.stringify(done))
    // Read back by Mediabunny, as Mako reads its recordings: no FFmpeg anywhere in the run.
    const video = await readMp4(done.video)
    assert.ok(video && video.duration > 0 && video.packets.length > 0, JSON.stringify(video))
    await run("cp", [done.video, join(evidence, `${kind}-recording.mp4`)])
    const turns = (await readdir(done.directory)).filter((name) => name.startsWith("turn-")).length
    // Pointer events in the timeline mean the video was re-encoded with them drawn in: on Linux only the helper's
    // composite mode does that.
    const timeline = done.timeline ? JSON.parse(await readFile(done.timeline, "utf8")) : {}
    const pointers = Array.isArray(timeline.pointer) ? timeline.pointer.length : 0
    const journal = []
    for (const turn of (await readdir(done.directory)).filter((name) => name.startsWith("turn-"))) {
      const action = JSON.parse(await readFile(join(done.directory, turn, "action.json"), "utf8").catch(() => "{}"))
      journal.push([action.tool, action.pointer_dispatches?.length ?? null, action.result_error ?? null])
    }
    // Where the driver journals a pointer dispatch (X11; its Wayland input paths journal none), it is drawn in.
    const dispatched = journal.reduce((total, [, points]) => total + (points ?? 0), 0)
    assert.equal(pointers, dispatched, `every journaled pointer dispatch is in the timeline: ${JSON.stringify(journal)}`)
    if (kind === "x11" && clicked === true) assert.ok(pointers > 0, "the click is drawn into the video")
    return { codec: video.codec, width: video.width, height: video.height, frames: video.packets.length, seconds: video.duration, bytes: (await stat(done.video)).size, pointerClick: clicked, journalTurns: turns, pointersDrawn: pointers, id: recording.id }
  })
  // MAKO_FIRST_FRAME_LOOPS=N: on a still screen, N captures as they were (no fallback) and N with the Screenshot
  // portal's first frame, counting those that got no picture. It measures the lost first frame the fallback is for.
  const starts = Number(process.env.MAKO_FIRST_FRAME_LOOPS ?? 0)
  if (starts > 0 && source?.kind === "portal")
    await step(`live video: first frame on a still screen, ${starts} captures each way`, async () => {
      if (kind === "gnome") await run("gdbus", ["call", "--session", "--dest", "org.cua.WinRects", "--object-path", "/org/cua/WinRects", "--method", "org.cua.WinRects.HideCursor"]).catch(() => undefined)
      await delay(3000)
      const capture = (extra) => new Promise((done) => {
        const child = spawn(executable, ["portal", "--types", source.types, "--restore", source.restore, "--fps", "30", ...extra], { stdio: ["pipe", "pipe", "pipe"] })
        let stderr = ""
        child.stdout.resume()
        child.stderr.on("data", (bytes) => (stderr += bytes))
        setTimeout(() => child.stdin.end(), 1500)
        const kill = setTimeout(() => child.kill("SIGKILL"), 8000)
        child.once("close", () => {
          clearTimeout(kill)
          const last = stderr.trim().split("\n").at(-1) ?? ""
          done({ frames: last.startsWith("{") ? JSON.parse(last).frames : -1, screenshot: /Screenshot portal in/.test(stderr) })
        })
      })
      const count = async (extra) => {
        const result = { none: 0, screenshots: 0, failed: 0 }
        for (let i = 0; i < starts; i++) {
          const one = await capture(extra)
          if (one.frames === 0) result.none++
          if (one.frames < 0) result.failed++
          if (one.screenshot) result.screenshots++
        }
        return result
      }
      const asItWas = await count([])
      const withFallback = source.still ? await count(["--still", "screenshot"]) : null
      // What the host asks for must always bring a picture: the fallback where it uses one, the stream alone elsewhere.
      const used = withFallback ?? asItWas
      assert.equal(used.none + used.failed, 0, JSON.stringify({ asItWas, withFallback }))
      return { captures: starts, asItWas, withFallback }
    }, { optional: true })

  // MAKO_RECORD_LOOPS=N: the same recording N more times, each with a value change and a foreground click, to hold
  // an intermittent failure to a count. Every failure keeps the receipt's error, which carries the helper's own words.
  const loops = Number(process.env.MAKO_RECORD_LOOPS ?? 0)
  if (loops > 0)
    await step(`record: ${loops} recordings in a row`, async () => {
      const failures = []
      const frames = []
      for (let i = 0; i < loops; i++) {
        try {
          const receipt = await cli(["record", "start", "--target-file", targetFile, "--directory", join(work, "recordings"), "--fps", "15"])
          await writeFile(join(work, "loop.json"), JSON.stringify(receipt))
          await program(`const w=control.window(${JSON.stringify(target)});await w.locator({role:'TextArea',name:'Exact text'}).setValue('loop ${i}');return 1`)
          await program(`await control.native('bring_to_front',{pid:${fixture.pid},window_id:${window.window_id},foreground:true});return await control.native('click',{pid:${fixture.pid},window_id:${window.window_id},x:${Math.round(window.bounds.width / 2)},y:${window.bounds.height - 16},delivery_mode:'foreground',foreground:true})`).catch(() => undefined)
          await cli(["observe", "--target-file", targetFile]).catch(() => undefined)
          const done = await cli(["record", "stop", "--input", join(work, "loop.json"), "--wait"])
          const video = done.status === "finished" ? await readMp4(done.video) : undefined
          if (!video?.packets.length) throw new Error(JSON.stringify(done))
          frames.push(video.packets.length)
        } catch (error) {
          failures.push({ run: i, error: String(error.message).slice(0, 700) })
        }
      }
      assert.equal(failures.length, 0, JSON.stringify(failures))
      return { recordings: loops, failures: 0, frames }
    }, { optional: true })
} finally {
  await writeFile(join(evidence, `desktop-${kind}.json`), JSON.stringify(report, null, 2))
  helper?.close()
  await probe.close().catch(() => undefined)
  cua.stop()
}
const failed = report.operations.filter((operation) => !operation.ok).map((operation) => operation.name)
// What each desktop is known not to do yet (README.md's coverage): failing there is recorded, not a regression, and
// one that starts passing is named so the list shrinks.
const unsupported = {
  x11: [],
  gnome: [],
  sway: [
    "xwayland: screenshot of the X11 GTK app's window",
    "windows: find the foot window",
  ],
  kde: [
    "screenshot: the GTK window",
    "focus: bring the GTK window to the front",
    "click: a pointer click on the GTK Save button (foreground, window pixels)",
    "xwayland: screenshot of the X11 GTK app's window",
    "type: keys into xterm once it's focused (foreground)",
    "windows: find the foot window",
    "live video: first frame, idle cost, frames under activity, its units as MP4",
    "live video: a second portal session restores the person's answer; its idle buffers",
    "record: start a recording of the GTK window",
  ],
}
unsupported.kde6 = unsupported.kde
const known = unsupported[kind]
const regressions = failed.filter((name) => !known.includes(name))
const nowPassing = known.filter((name) => report.operations.some((operation) => operation.name === name && operation.ok))
console.log(JSON.stringify({ desktop: kind, passed: report.operations.length - failed.length, failed, regressions, nowPassing }))
// The fixture apps and terminals the driver launched outlive the probe; the session's end takes them.
process.exit(regressions.length ? 1 : 0)
