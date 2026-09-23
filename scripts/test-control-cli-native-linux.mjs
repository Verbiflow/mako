// Run in the reviewed Linux acceptance image; mount fixture.py at /tmp/fixture.py.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
const run = promisify(execFile)
const root = process.env.MAKO_RUNTIME_ROOT ?? "/opt/mako-control"
const cli = join(root, "dist-electron/control-cli.js")
const directory = await mkdtemp("/tmp/mako-cli-native-")
const output = join(directory, "job")
const config = join(directory, "job.json")
let sessionFile
let stopped = false
let sequence = 0
async function command(args) {
  const result = await run(
    process.execPath,
    [cli, ...args, ...(sessionFile ? ["--session-file", sessionFile] : [])],
    { timeout: 45000, maxBuffer: 1024 * 1024 }
  )
  assert.equal(result.stderr, "")
  return JSON.parse(result.stdout)
}
async function program(source) {
  const path = join(directory, `program-${++sequence}.js`)
  await writeFile(path, source)
  return (await command(["exec", "--source-file", path])).at(-1)?.value
}
const read = async (file) => JSON.parse(await readFile(file, "utf8"))
async function until(fn) {
  const deadline = Date.now() + 20000
  let last
  for (;;) {
    const value = await fn().catch((error) => {
      last = error
      return null
    })
    if (value) return value
    assert.ok(
      Date.now() < deadline,
      `Acceptance deadline: ${last?.message ?? "condition not reached"}`
    )
    await delay(30)
  }
}
try {
  await writeFile(
    config,
    JSON.stringify({
      output,
      native: { driver: join(root, "native/cua-driver") },
      startupMs: 15000,
      shutdownMs: 10000,
    })
  )
  sessionFile = (await command(["session", "start", "--config", config]))
    .sessionFile
  const ready = await read(join(output, "ready.json"))
  const oracleFile = join(output, "fixture.json")
  await program(
    `return await control.command({language:'shell',source:${JSON.stringify(`python3 /tmp/fixture.py 'CLI native fixture' '${oracleFile}' >'${output}/fixture.log' 2>&1 &`)}})`
  )
  const oracle = await until(() => read(oracleFile))
  const window = await until(async () =>
    (await command(["windows", "--pid", String(oracle.pid)])).windows.find(
      (window) => window.title === "CLI native fixture"
    )
  )
  const target = {
    kind: "window",
    pid: oracle.pid,
    window_id: window.window_id,
  }
  const targetFile = join(directory, "target.json")
  await writeFile(targetFile, JSON.stringify(target))
  await program(
    `state.window=control.window(${JSON.stringify(target)});return await state.window.capabilities()`
  )
  const observation = await command(["observe", "--target-file", targetFile])
  assert.ok(observation.nodes.length > 0, JSON.stringify(observation))
  const text = "CLI native: 東京 🧪 é"
  await program(
    `await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(text)});await state.window.locator({role:'Button',name:'Save'}).click();return await state.window.expect({role:'TextArea',name:'Exact text',value:${JSON.stringify(text)}})`
  )
  const saved = await until(async () => {
    const current = await read(oracleFile)
    return current.saves === 1 ? current : null
  })
  assert.equal(saved.entry, text)
  const shot = await command([
    "shot",
    "--target-file",
    targetFile,
    "--output",
    join(directory, "native window.png"),
  ])
  assert.ok(shot.width > 100 && shot.height > 100)
  assert.equal(shot.bytes, (await stat(shot.path)).size)
  const smaller = await command([
    "shot",
    "--target-file",
    targetFile,
    "--max-side",
    "320",
    "--output",
    join(directory, "small native.png"),
  ])
  assert.equal(
    Math.max(smaller.width, smaller.height),
    320,
    "Explicit native capture size must be honored"
  )
  assert.equal(smaller.coordinates.units, "image pixels")
  // X11 raw pointer input remains foreground-only. A screenshot must not
  // silently turn that route into background input or claim a delivered click.
  const clickFile = join(directory, "pixel-click.json")
  await writeFile(
    clickFile,
    JSON.stringify({
      kind: "pointer",
      at: { x: 100, y: 100, view: smaller.view },
    })
  )
  await assert.rejects(
    command(["act", "--target-file", targetFile, "--input", clickFile]),
    (error) =>
      error.code === 2 && JSON.parse(error.stderr).outcome === "not-dispatched"
  )
  assert.equal((await read(oracleFile)).saves, 1)
  const captureOptions = join(directory, "capture.json")
  await writeFile(
    captureOptions,
    JSON.stringify({ options: { format: "jpeg", quality: 90, maxSide: 320 } })
  )
  const jpeg = await command([
    "shot",
    "--target-file",
    targetFile,
    "--input",
    captureOptions,
    "--output",
    join(directory, "native.jpg"),
  ])
  assert.equal(jpeg.mimeType, "image/jpeg")
  assert.equal((await readFile(jpeg.path)).readUInt16BE(0), 0xffd8)
  await assert.rejects(
    command(["record", "start", "--target-file", targetFile, "--fps", "60"]),
    (error) =>
      error.code === 2 && JSON.parse(error.stderr).outcome === "not-dispatched"
  )
  const recording = await command([
    "record",
    "start",
    "--target-file",
    targetFile,
    "--directory",
    join(directory, "recordings"),
  ])
  const receiptFile = join(directory, "recording.json")
  await writeFile(receiptFile, JSON.stringify(recording))
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      program(
        `state.count=(state.count??0)+1;await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(`value ${i}: 東京 🧪`)});return state.count`
      )
    )
  )
  assert.deepEqual([...results].sort(), [1, 2, 3, 4])
  const final = await program("return state.count")
  assert.equal(final, 4)
  const complete = await command([
    "record",
    "stop",
    "--input",
    receiptFile,
    "--wait",
  ])
  assert.equal(complete.status, "finished", JSON.stringify(complete))
  const media = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        complete.video,
      ])
    ).stdout
  )
  assert.ok(Number(media.format.duration) > 0)
  await command(["session", "stop"])
  stopped = true
  const launcher = await until(() => read(join(output, "launcher.json")))
  assert.equal(launcher.runtimeRemoved, true)
  assert.equal((await read(join(output, "worker.json"))).reason, "session-stop")
  for (const pid of [
    ready.pid,
    ...ready.backends.map((backend) => backend.pid),
  ])
    await until(
      async () =>
        !(
          await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone")
        ).match(/\) [RSDIT]/)
    )
  console.log(
    JSON.stringify({
      passed: true,
      directory,
      pixels: { width: shot.width, height: shot.height },
      resized: { width: smaller.width, height: smaller.height },
      jpeg: jpeg.mimeType,
      recording: {
        status: complete.status,
        width: media.streams[0].width,
        height: media.streams[0].height,
        duration: media.format.duration,
      },
      concurrentPrograms: results,
      cleanup: launcher,
    })
  )
} finally {
  if (sessionFile && !stopped)
    await command(["session", "stop"]).catch(() => {})
}
