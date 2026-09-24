// Run in the reviewed Linux runtime image with this file mounted at /checks.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
const run = promisify(execFile)
const root = process.env.MAKO_RUNTIME_ROOT ?? "/opt/mako-control"
const require = createRequire(join(root, "package.json"))
const cli = require.resolve("@mako/control-runtime/cli")
const directory = await mkdtemp("/tmp/mako-cli-linux-")
let sessionFile
let stopped = false
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
  const file = join(directory, "program.js")
  await writeFile(file, source)
  return (await command(["exec", "--source-file", file])).at(-1)?.value
}
const read = async (file) => JSON.parse(await readFile(file, "utf8"))
async function until(fn) {
  const deadline = Date.now() + 20000
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    assert.ok(Date.now() < deadline, "Cleanup deadline")
    await delay(30)
  }
}
try {
  const config = join(directory, "job.json")
  const output = join(directory, "job")
  await writeFile(
    config,
    JSON.stringify({
      output,
      browser: { executable: "/usr/bin/chromium", sandbox: false },
      startupMs: 15000,
      shutdownMs: 10000,
    })
  )
  sessionFile = (await command(["session", "start", "--config", config]))
    .sessionFile
  assert.ok(sessionFile)
  const ready = await read(join(output, "ready.json"))
  const html =
    "data:text/html," +
    encodeURIComponent(
      '<!doctype html><title>CLI proof</title><label>Name<input aria-label="Name"></label><button>Save</button><output>0</output><script>window.saves=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent=++window.saves;setInterval(()=>document.body.style.background=Date.now()%200<100?"#fff":"#ddd",100)</script>'
    )
  const browsers = await command(["browsers"])
  const browser = browsers.browsers[0].id
  const openOptions = join(directory, "open.json")
  await writeFile(
    openOptions,
    JSON.stringify({ disposition: "window", background: true, url: html })
  )
  const target = await command([
    "open",
    "--browser",
    browser,
    "--input",
    openOptions,
  ])
  const targetFile = join(directory, "target.json")
  await writeFile(targetFile, JSON.stringify(target))
  await program(
    `state.tab=control.tab(${JSON.stringify(target)});await state.tab.locator({role:'textbox',name:'Name'}).setValue('東京 🧪');await state.tab.locator({role:'button',name:'Save'}).click();return await state.tab.expect({role:'textbox',name:'Name',value:'東京 🧪'});`
  )
  assert.equal(
    (
      await program(
        "return await state.tab.cdp('Runtime.evaluate',{expression:'window.saves'})"
      )
    ).result.value,
    1
  )
  const shot = await command([
    "shot",
    "--target-file",
    targetFile,
    "--role",
    "button",
    "--name",
    "Save",
    "--output",
    join(directory, "Save button.png"),
  ])
  assert.ok(shot.width > 10 && shot.height > 10)
  assert.ok(shot.width < 200 && shot.height < 100)
  const receipt = await command([
    "record",
    "start",
    "--target-file",
    targetFile,
    "--directory",
    join(directory, "recordings"),
  ])
  const receiptFile = join(directory, "recording.json")
  await writeFile(receiptFile, JSON.stringify(receipt))
  // Interleaved clipped capture must use the same capture coordinator.
  await command([
    "shot",
    "--target-file",
    targetFile,
    "--role",
    "textbox",
    "--name",
    "Name",
    "--output",
    join(directory, "field.png"),
  ])
  await delay(450)
  const complete = await command([
    "record",
    "stop",
    "--input",
    receiptFile,
    "--wait",
  ])
  assert.equal(complete.status, "finished", JSON.stringify(complete))
  assert.ok((await stat(complete.video)).size > 0)
  const probe = JSON.parse(
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
  assert.ok(Number(probe.format.duration) > 0)
  assert.ok(probe.streams[0].width > shot.width)
  // Execute public help against duplicate controls in a real Chromium page.
  const setup = `document.body.insertAdjacentHTML('beforeend', '<form aria-label="Profile"><label>Name<input aria-label="Name"></label><button type="button">Save</button></form>'); window.profileSaves=0; document.querySelector('form button').onclick=()=>window.profileSaves++`
  await program(
    `await state.tab.cdp('Runtime.evaluate',{expression:${JSON.stringify(setup)}})`
  )
  await assert.rejects(
    program("await state.tab.locator({role:'button',name:'Save'}).click()"),
    (error) =>
      error.code === 3 && JSON.parse(error.stderr).code === "target-ambiguous"
  )
  const examples = (await command(["api", "--topic", "examples"])).examples
  await program(examples.scopedEdit)
  const independent = await program(
    "return (await state.tab.cdp('Runtime.evaluate',{expression:\"JSON.stringify({profile:document.querySelector('form input').value,original:document.querySelector('input').value,profileSaves:window.profileSaves,saves:window.saves})\",returnByValue:true})).result.value"
  )
  assert.deepEqual(JSON.parse(independent), {
    profile: "Ada",
    original: "東京 🧪",
    profileSaves: 1,
    saves: 1,
  })
  const closeup = await program(examples.screenshot)
  assert.ok((await stat(closeup.path)).size > 0)
  if (process.env.MAKO_RUNTIME_EVIDENCE) {
    const evidence = process.env.MAKO_RUNTIME_EVIDENCE
    await mkdir(evidence, { recursive: true })
    for (const [source, name] of [[shot.path, "button.png"], [join(directory, "field.png"), "field.png"], [closeup.path, "closeup.png"], [complete.video, "recording.mp4"], [complete.timeline, "timeline.json"]])
      await cp(source, join(evidence, name))
    await writeFile(join(evidence, "media.json"), JSON.stringify({ receipt: complete, media: probe }, null, 2))
  }
  await command(["session", "stop"])
  stopped = true
  const launcher = await until(
    async () => await read(join(output, "launcher.json"))
  )
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
      recording: {
        status: complete.status,
        width: probe.streams[0].width,
        height: probe.streams[0].height,
        duration: probe.format.duration,
      },
      publicExamples: {
        scopedEdit: true,
        scopedScreenshot: true,
        ambiguousClickRefused: true,
      },
      cleanup: launcher,
    })
  )
} finally {
  if (sessionFile && !stopped)
    await command(["session", "stop"]).catch(() => {})
}
