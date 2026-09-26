import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import { connectMcpComputerDriver } from "../packages/control-runtime/src/computer-driver-client.js"
import {
  cuaEmbeddedPid,
  cuaEmbeddedSocket,
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"

// The real native driver is killed while it types into a real Cocoa view in
// the background: first its stdio process, then the embedded daemon doing
// the input. The fixture records every key event independently.
const driver = process.env.MAKO_TEST_DRIVER
assert.ok(driver, "Set MAKO_TEST_DRIVER to the exact driver executable")
const run = promisify(execFile)
const root = await mkdtemp("/private/tmp/mako-driver-death-live-")
const bundle = join(root, "Key Fixture.app")
await mkdir(join(bundle, "Contents/MacOS"), { recursive: true })
await writeFile(join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>key-fixture</string>
<key>CFBundleIdentifier</key><string>dev.mako.test.key-fixture.${root.split("-").at(-1)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`)
await run("xcrun", ["swiftc", "-O", "scripts/lib/key-fixture.swift", "-o", join(bundle, "Contents/MacOS/key-fixture")], { timeout: 180_000 })
for (const index of [0, 1]) await run("open", ["-g", "-n", bundle, "--args", root, String(index)], { timeout: 30_000 })
const State = z.object({
  pid: z.number(),
  window: z.number(),
  value: z.string(),
  events: z.array(z.tuple([z.string(), z.number(), z.string(), z.boolean(), z.number()])),
  activations: z.number(),
})
const read = async (index: number) =>
  State.parse(JSON.parse(await readFile(join(root, `state-${index}.json`), "utf8")))
async function until<T>(check: () => Promise<T | undefined | false>, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Condition timed out")
}
/** Every key down has its key up, per key code: no key left held in the app. */
const held = (events: z.infer<typeof State>["events"]) => {
  const down = new Map<number, number>()
  for (const [type, code] of events)
    if (type === "keydown") down.set(code, (down.get(code) ?? 0) + 1)
    else if (type === "keyup") down.set(code, (down.get(code) ?? 0) - 1)
  return [...down].filter(([, count]) => count > 0).map(([code]) => code)
}
/** Key events any process other than the driver's daemons posted here. */
const daemons = new Set<number>()
const foreign = (events: z.infer<typeof State>["events"]) =>
  events.filter(([, , , , source]) => !daemons.has(source)).map(([type, code, , , source]) => [type, code, source])
const driverChildren = async (socket: string) =>
  (await run("ps", ["-axo", "pid=,ppid=,command="])).stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[2]) === process.pid && match[3]!.includes(`mcp --embedded --socket ${socket}`))
    .map((match) => Number(match![1]))

interface Evidence {
  driver: string
  version: string
  status: "running" | "passed" | "failed"
  error?: string
  stdioKill?: object
  daemonKill?: object
}
const evidence: Evidence = { driver, version: (await run(driver, ["--version"])).stdout.trim(), status: "running" }
let session: ReturnType<typeof controlSessionProbe> | undefined
try {
  const [a, b] = await Promise.all([0, 1].map((index) => until(() => read(index))))
  const targets = [a!, b!].map((state) => ({ pid: state.pid, window_id: state.window }))
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.driver-death", {
    ...process.env,
    PATH: dirname(driver) + delimiter + process.env.PATH,
  })
  assert.ok(socket)
  daemons.add(cuaEmbeddedPid()!)
  let spawns = 0
  session = controlSessionProbe(
    { command: driver, args: ["mcp", "--embedded", "--socket", socket] },
    "driver-death-live",
    async (process) => {
      spawns++
      return connectMcpComputerDriver(process)
    },
    { surface: "control" }
  )
  const exec = async (source: string) => {
    const reply = await session!.request({ method: "exec", arguments: { source } })
    const text = z.array(z.object({ text: z.string().optional() })).parse(reply.content)[0]?.text
    assert.ok(!reply.isError, text ?? JSON.stringify(reply))
    return JSON.parse(z.string().parse(text))
  }
  const handles = `const target=control.window(${JSON.stringify(targets[0])});
const other=control.window(${JSON.stringify(targets[1])});
const fault=(e)=>({code:e.code,outcome:e.outcome,message:e.message});`
  /**
   * Type `text` slowly into the target and run `kill` once `after` characters
   * landed; recovery starts at once, while orphaned typing may still land.
   * The recovering observation must be the settled text: one key typed after
   * it lands directly behind it, and nothing is replayed. That key must not
   * already be in the field: the driver confirms an accessibility insert when
   * the field contains the text, even if the insert did nothing.
   */
  const interrupted = async (text: string, mark: string, after: number, kill: () => Promise<number>, beforeRecovery = async () => {}) => {
    const start = (await read(0)).value.length
    const [result, killed] = await Promise.all([
      exec(`${handles}
await target.observe();
try { await target.raw('type_text',{text:${JSON.stringify(text)},delay_ms:150}); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
      until(async () => (await read(0)).value.length - start >= after && kill()),
    ])
    const atFault = (await read(0)).value.slice(start)
    await beforeRecovery()
    const recovery = await exec(`${handles}
let blocked; try { await target.pressKey('x') } catch(e) { blocked=[e.code,e.outcome] }
const before=Date.now(); const seen=(await target.observe()).get({role:'TextField',name:'Proof'}).value;
const settleMs=Date.now()-before;
const busy=[];
for (;;) { try { await target.raw('type_text',{text:${JSON.stringify(mark)}}); break } catch(e) {
  if (e.code!=='native-input-busy' || e.outcome!=='not-dispatched' || busy.length===20) throw e;
  busy.push(Date.now()-before); await new Promise(r=>setTimeout(r,250)) } }
return {blocked,seen,settleMs,busy};`)
    await new Promise((resolve) => setTimeout(resolve, 150 * text.length + 1_000))
    const final = await read(0)
    const typed = final.value.slice(start)
    return { result, killed, atFault, seen: recovery.seen.slice(start), settleMs: recovery.settleMs, blocked: recovery.blocked, busy: recovery.busy, typed, held: held(final.events), foreign: foreign(final.events) }
  }
  const settledCorrectly = (outcome: Awaited<ReturnType<typeof interrupted>>, text: string, mark: string) => {
    const detail = JSON.stringify(outcome)
    assert.deepEqual(outcome.foreign, [], `Only the driver's keys reached the background target: ${detail}`)
    assert.deepEqual(outcome.blocked, ["observation-required", "not-dispatched"], detail)
    assert.ok(text.startsWith(outcome.seen) && outcome.seen.length >= outcome.atFault.length, detail)
    assert.equal(outcome.typed, outcome.seen + mark, `The observation was settled and nothing was replayed: ${detail}`)
  }

  // 1. The host's stdio driver process dies mid-typing.
  const text = "abcdefghijklmnop"
  const stdio = await interrupted(text, "!", 4, async () => {
    const [pid] = await driverChildren(socket)
    assert.ok(pid, "The session's driver process is running")
    process.kill(pid, "SIGKILL")
    return pid
  })
  evidence.stdioKill = stdio
  assert.deepEqual([stdio.result.fault?.code, stdio.result.fault?.outcome], ["driver-exited", "unknown"], JSON.stringify(stdio.result))
  settledCorrectly(stdio, text, "!")
  assert.deepEqual(stdio.held, [], `The surviving daemon released every key: ${JSON.stringify(stdio)}`)
  const otherAfterStdio = await exec(`${handles}
await other.observe(); await other.raw('type_text',{text:'zz'}); return true;`)
  assert.equal(otherAfterStdio, true)
  assert.equal((await read(1)).value, "zz", "The unrelated app is usable after reconnect")
  assert.equal(spawns, 2)

  // 2. The embedded daemon doing the input dies mid-typing. The host
  // replaces it on the same socket; the session's driver reconnects there.
  const daemonText = "ABCDEFGHIJKLMNOP"
  let replacement: number | undefined
  let killedDaemon: number | undefined
  const daemon = await interrupted(
    daemonText,
    "#",
    4,
    async () => {
      const pid = cuaEmbeddedPid()
      assert.ok(pid, "The embedded daemon is running")
      process.kill(pid, "SIGKILL")
      killedDaemon = pid
      return pid
    },
    async () => {
      replacement = await until(async () => {
        const pid = cuaEmbeddedPid()
        return pid && pid !== killedDaemon ? pid : undefined
      })
      daemons.add(replacement)
      assert.equal(cuaEmbeddedSocket(), socket, "The replacement daemon listens on the same socket")
    }
  )
  evidence.daemonKill = { ...daemon, replacement }
  assert.equal(daemon.result.fault?.outcome, "unknown", JSON.stringify(daemon.result))
  settledCorrectly(daemon, daemonText, "#")
  // A daemon killed between a key's down and up events leaves that one key
  // pressed in the app; nothing can release it on the dead daemon's behalf.
  assert.ok(daemon.held.length <= 1, `At most the interrupted key is left pressed: ${JSON.stringify(daemon)}`)
  const otherAfterDaemon = await exec(`${handles}
await other.observe(); await other.raw('type_text',{text:'yy'}); return true;`)
  assert.equal(otherAfterDaemon, true)
  assert.equal((await read(1)).value, "zzyy", "The unrelated app is usable on the replacement daemon")
  for (const index of [0, 1]) {
    const state = await read(index)
    assert.equal(state.activations, 0, `Fixture ${index} never became the active app`)
    assert.deepEqual(foreign(state.events), [], `Only the driver's keys reached fixture ${index}`)
  }
  evidence.status = "passed"
  console.log(`PASS real driver death: stdio process and daemon killed mid-typing. Evidence: ${root}`)
} catch (error) {
  evidence.status = "failed"
  evidence.error = String(error)
  throw error
} finally {
  await session?.close()
  stopCuaEmbedded()
  for (const index of [0, 1])
    try {
      process.kill((await read(index)).pid)
    } catch {}
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
  console.log("Evidence:", root)
}
