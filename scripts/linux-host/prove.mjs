import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { arch, homedir, release } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { BrowserService, BrowserVideo } from "@mako/control-runtime/browser"
import { BrowserCommandSchema, BrowserTargetSchema, decodeControlVideo } from "@mako/control-runtime/contracts"
import { MACHINE_BROWSER_ID, MachineBrowser } from "@mako/control-runtime/desktop"
import { classifyStartFailure } from "@mako/host/contracts/provider-failure"
import { othersRunning, SHARED_DAEMONS, startHost, until } from "./host-process.mjs"

/**
 * Item 1.1's proof, inside the Linux image (`runtime/host/Dockerfile`): the
 * host as installed there, with `electron` unresolvable, answers /health,
 * serves the first look's calls (wayfinder/audits/2026-10-01/
 * track-c1-headless-runtime), and starts each of its six harnesses to ready
 * or signed out. The image's user has no account anywhere, so signed out is
 * what most can reach: the host asking how to sign in, or a start it
 * classifies as signed out. Any other end fails the proof, as does a host
 * that doesn't exit cleanly on SIGTERM, or a process that outlives its data.
 *
 *   node prove.mjs <evidence directory>
 *
 * The image's entry point runs it. As a machine is a VM, with no syscall filter
 * to refuse the browser's sandbox its namespaces, the container runs without one:
 *
 *   docker run --rm --security-opt seccomp=unconfined -v <dir>:/evidence <image>
 */
const evidence = process.argv[2]
assert.ok(evidence, "Pass the evidence directory")
await mkdir(evidence, { recursive: true })
const run = promisify(execFile)
const report = { status: "running", machine: { arch: arch(), kernel: release(), node: process.versions.node, pointerCompression: Boolean(process.config.variables.v8_enable_pointer_compression) }, checks: [], harnesses: [], failures: [] }
const passed = (name, detail = {}) => {
  report.checks.push({ name, ...detail })
  console.log(`ok   ${name}${detail.note ? `: ${detail.note}` : ""}`)
}
const failed = (failure) => {
  report.failures.push(failure)
  console.error(`FAIL ${failure}`)
}

const dataRoot = join(homedir(), "proof-data")
let host
try {
  // No Electron to find, from the host's install or from the host package itself.
  const program = createRequire(import.meta.url).resolve("@mako/host/mako-host")
  for (const from of [import.meta.url, program])
    assert.throws(() => createRequire(from).resolve("electron"), { code: "MODULE_NOT_FOUND" }, `electron resolves from ${from}`)
  passed("electron is unresolvable", { note: `from the install and from ${program}` })

  host = await startHost({ dataRoot, output: join(evidence, "host-output.log") })
  passed("/health", { ms: Math.round(host.healthMs), methods: host.info.methods.length, note: `${Math.round(host.healthMs)} ms after spawn, ${host.info.methods.length} methods` })

  // The first look's calls.
  const boot = await host.call("mako:boot")
  assert.ok(Array.isArray(boot.tabs), "boot lists the tabs")
  await host.call("mako:capabilities")
  const availability = await host.call("mako:harness-availability")
  const accounts = await host.call("mako:accounts")
  assert.equal(await host.call("mako:host-log-path"), host.log)
  passed("boot, capabilities, availability, accounts, log path", { availability, providers: accounts.providers.map((provider) => provider.provider) })

  const terminal = await host.call("mako:terminal-create", { cwd: homedir(), title: "proof", cols: 80, rows: 24 })
  await host.call("mako:terminal-write", terminal.id, "echo proof-$((6*7)) on $(uname -sm)\n")
  const shell = await until(() => host.call("mako:terminal-attach", terminal.id), (attached) => JSON.stringify(attached).includes("proof-42 on Linux"), "the terminal's echo", 10_000)
  await host.call("mako:terminal-kill", terminal.id)
  passed("a login shell through the terminal daemon", { note: JSON.stringify(shell).match(/proof-42 on Linux \w+/)?.[0] })

  const project = join(homedir(), "proof-project")
  await mkdir(project, { recursive: true })
  await run("git", ["init", "-q", project])
  const app = await host.call("mako:thread-app", project)
  assert.equal(app.kind, "none", `a folder with no recipe isn't set up: ${JSON.stringify(app)}`)
  assert.equal(app.root, project, "the app's root is the folder's repository")
  passed("a folder's app: not set up, at its repository's root")

  const inspected = JSON.parse((await run("mako-host", ["inspect", "--data-root", dataRoot, "--json"])).stdout)
  assert.equal(inspected.health.pid, host.pid)
  passed("mako-host inspect", { domains: inspected.health.domains?.map((domain) => `${domain.name} ${domain.state}`) })

  const catalog = await until(() => readFile(host.log, "utf8"), (log) => / shared catalog (connected|unavailable)/.test(log), "the threads catalog's reader", 20_000)
  assert.match(catalog, / shared catalog connected/, "the shared catalog reader serves the host")
  passed("the shared catalog reader serves the host")

  // The machine's own browser: preferred, not running until an agent connects, sandboxed when it runs.
  const chromium = async (profile = "") => (await othersRunning()).filter(({ args }) => /\/chromium(\s|$)/.test(args) && args.includes(profile))
  const own = (statuses) => statuses.find((status) => status.id === MACHINE_BROWSER_ID)
  const listed = own(await host.call("mako:browser-control-status"))
  assert.equal(listed?.preferred, true, "the machine's browser is preferred")
  assert.equal(listed.connection.status, "disconnected")
  assert.deepEqual(await chromium(), [], "no browser runs until an agent connects")
  const connecting = performance.now()
  assert.equal(own(await host.call("mako:browser-control-connect", MACHINE_BROWSER_ID))?.connection.status, "connected")
  const connectMs = Math.round(performance.now() - connecting)
  const launched = await chromium()
  assert.ok(launched.length && !launched.some(({ args }) => args.includes("--no-sandbox")), "Chromium runs in its sandbox")
  passed("the machine's browser starts on an agent's first connect", { ms: connectMs, note: `connected in ${connectMs} ms, sandboxed` })

  // A page in that browser as remote viewers see it, through the FFmpeg the image built, as the host finds it.
  const media = join(program, "../../../../vendor/control-media/linux-x64")
  process.env.MAKO_CONTROL_MEDIA_ROOT = media
  const machine = new MachineBrowser({ executable: "/usr/bin/chromium", profile: join(dataRoot, "proof-browser") })
  const browser = new BrowserService([machine.definition])
  const command = (input) => browser.execute("proof", BrowserCommandSchema.parse(input), AbortSignal.timeout(30_000))
  try {
    await command({ action: "connect", browser: MACHINE_BROWSER_ID })
    const page = `<body style="margin:0;font:48px sans-serif"><p id=t>Mako 😀</p><script>let n=0;setInterval(()=>t.textContent='Mako 😀 '+ ++n,33)</script>`
    const { navigation, ...opened } = await command({ action: "open", browser: MACHINE_BROWSER_ID, url: `data:text/html,${encodeURIComponent(page)}` })
    assert.ok(!navigation?.fault, `the page loads: ${JSON.stringify(navigation?.fault)}`)
    const target = BrowserTargetSchema.parse(opened)
    const video = new BrowserVideo(async ({ frame, ended, size }) => ({
      stop: await browser.previewStream("proof", target, () => {}, frame, ended, size),
      resized: () => browser.previewResized("proof", target),
    }))
    const packets = []
    const joined = performance.now()
    const leave = await video.join({
      size: () => ({ width: 640, height: 400 }),
      backlog: () => 0,
      send: (bytes) => packets.push({ ...decodeControlVideo(bytes), at: performance.now() - joined }),
      ended: (reason) => failed(`the live video ended: ${reason}`),
    })
    await until(async () => packets, (sent) => sent.filter((packet) => packet.kind === "delta").length >= 30, "30 frames of live video", 20_000)
    await leave()
    video.close()
    const key = packets.find((packet) => packet.kind === "key")
    assert.equal(packets[0].kind, "poster", "a viewer paints the screencast's picture first")
    assert.ok(key && key.width <= 640 && key.height <= 400, `the video fits the viewer: ${key?.width}x${key?.height}`)
    passed("a page in that browser streams as H.264", { note: `poster in ${Math.round(packets[0].at)} ms, key frame ${key.width}x${key.height} in ${Math.round(key.at)} ms, then deltas` })
  } finally {
    browser.close()
    machine.close()
  }
  await until(() => chromium("proof-browser"), (left) => left.length === 0, "the proof's Chromium to exit", 10_000)

  // Each harness, started as a window starts one, to ready or signed out.
  const installed = JSON.parse(await readFile(join(homedir(), "harnesses.json"), "utf8"))
  const harnesses = await host.call("mako:harness-descriptors")
  assert.equal(harnesses.length, 6, `six harnesses, not ${harnesses.map((harness) => harness.provider).join(", ")}`)
  assert.deepEqual(harnesses.filter((harness) => !harness.live).map((harness) => harness.provider), [], "every harness can start a conversation")
  for (const { provider } of harnesses) {
    const conversation = randomUUID()
    const cwd = join(homedir(), "work", provider)
    await mkdir(cwd, { recursive: true })
    const result = { provider, version: installed[provider]?.version }
    report.harnesses.push(result)
    const began = performance.now()
    try {
      await host.call("mako:live-start", provider, cwd, { conversationId: conversation, title: "Linux proof" })
      const { session, permissions } = await until(() => host.call("mako:live-snapshot", conversation), (value) =>
        ["ready", "failed", "closed"].includes(value?.session.status) || value?.permissions.some((request) => request.kind === "authentication"),
      `${provider} ready or signed out`)
      result.ms = Math.round(performance.now() - began)
      if (session.status === "ready") {
        assert.ok(session.nativeId, "a ready session has its native identity")
        result.state = "ready"
      } else if (permissions.some((request) => request.kind === "authentication")) {
        result.state = "signed out"
        result.how = "the host asks how to sign in"
      } else if (session.status === "failed" && classifyStartFailure(session.error, false) === "auth") {
        result.state = "signed out"
        result.how = session.error
      } else {
        throw new Error(`it ended ${session.status}: ${session.error ?? "no error"}`)
      }
      passed(`${provider} ${result.version}: ${result.state}`, { note: `in ${result.ms} ms${result.how ? `, ${result.how}` : ""}` })
    } catch (error) {
      result.state = "failed"
      result.error = error instanceof Error ? error.message : String(error)
      failed(`${provider} ${result.version ?? ""}: ${result.error}`)
    } finally {
      await host.call("mako:live-close", conversation).catch((error) => failed(`${provider} didn't close: ${error.message}`))
    }
  }
} catch (error) {
  failed(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  if (host) {
    report.stop = await host.stop()
    if (report.stop.code === 0) passed("SIGTERM", { note: `exited 0 in ${Math.round(report.stop.stopMs)} ms` })
    else failed(`the host exited ${report.stop.code ?? report.stop.signal} on SIGTERM`)
    const log = await readFile(host.log, "utf8").catch(() => "")
    await writeFile(join(evidence, "host.log"), log)
    report.warnings = log.split("\n").filter((line) => / (warn|error) /.test(line))
    for (const line of report.warnings) console.log(`log  ${line}`)
    await delay(500)
    const stayed = await othersRunning()
    const unexpected = stayed.filter(({ args }) => !SHARED_DAEMONS.includes(args))
    for (const { args } of unexpected) failed(`still running after the host stopped: ${args}`)
    if (!unexpected.length) passed("only Mako's shared daemons outlive the host", { note: stayed.map(({ args }) => args).join(", ") || "none" })
    await rm(dataRoot, { recursive: true, force: true })
    const began = performance.now()
    while ((report.leftovers = await othersRunning()).length && performance.now() - began < 20_000) await delay(250)
    for (const { args } of report.leftovers) failed(`still running 20 s after its data was deleted: ${args}`)
    if (!report.leftovers.length) passed("each leaves on its own once idle and its data is gone", { note: `in ${Math.round(performance.now() - began)} ms` })
  }
  report.status = report.failures.length ? "failed" : "passed"
  await writeFile(join(evidence, "result.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Linux proof ${report.status}`)
  process.exitCode = report.failures.length ? 1 : 0
}
