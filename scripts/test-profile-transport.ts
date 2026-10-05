import assert from "node:assert/strict"
import {
  rpcRequest,
  streamRequest,
  runDiscovery,
} from "../electron/providers/profile-transport.ts"
import { withDiscoveryProcess } from "../electron/providers/discovery-process.ts"
import { z } from "zod"

const earlyExit = ["-e", "process.exit(2)"]
await assert.rejects(
  rpcRequest(process.execPath, earlyExit, "models/list", process.env, false),
  /exited|closed/
)
await assert.rejects(
  streamRequest(process.execPath, earlyExit, {}, process.env, () => undefined),
  /exited|closed/
)
const closedInput = [
  "-e",
  'require("node:fs").closeSync(0); process.stderr.write("x".repeat(262144)); process.stdout.write(JSON.stringify({id:1,result:{}})+"\\n"); setTimeout(()=>process.exit(0),100)',
]
await assert.rejects(
  rpcRequest(process.execPath, closedInput, "models/list", process.env, false),
  /EPIPE|closed|exited|write/i
)
const replies = [
  "-e",
  'let text=""; process.stdin.on("data",chunk=>{text+=chunk;let n;while((n=text.indexOf("\\n"))>=0){const m=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(m.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+"\\n");if(m.id===2)process.stdout.write(JSON.stringify({id:2,result:{models:["fixture"]}})+"\\n");}})',
]
assert.deepEqual(
  await rpcRequest(
    process.execPath,
    replies,
    "models/list",
    process.env,
    false
  ),
  { models: ["fixture"] }
)
const valueSchema = z.object({ value: z.string() })
assert.equal(
  await streamRequest(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({value:'complete'}))"],
    {},
    process.env,
    (value) => valueSchema.parse(value).value
  ),
  "complete"
)
const rejectedAt = performance.now()
await assert.rejects(
  streamRequest(
    process.execPath,
    ["-e", "process.stdout.write('{}\\n');setInterval(()=>{},1000)"],
    {},
    process.env,
    (value) => valueSchema.parse(value).value
  ),
  /invalid discovery response/
)
assert.ok(performance.now() - rejectedAt < 5_000)
await assert.rejects(
  runDiscovery(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(9_000_000))"],
    process.env
  ),
  /exceeded/
)
const pidSchema = z.object({ pid: z.number() })
const pid = await streamRequest(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write(JSON.stringify({pid:process.pid})+'\\n')",
  ],
  {},
  process.env,
  (value) => pidSchema.parse(value).pid
)
assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
let timedPid: number | undefined
await assert.rejects(
  withDiscoveryProcess(
    {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: process.env,
      timeoutMs: 200,
    },
    async ({ child, phase, exited }) => {
      timedPid = child.pid
      phase("fixture request")
      await exited
    }
  ),
  /fixture request after 200 ms/
)
const expiredPid = timedPid
assert.ok(expiredPid)
assert.throws(() => process.kill(expiredPid, 0), { code: "ESRCH" })
for (const priority of ["background", "launch"] satisfies NonNullable<
  Parameters<typeof withDiscoveryProcess>[0]["priority"]
>[]) {
  let running = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withDiscoveryProcess(
        {
          command: process.execPath,
          args: ["-e", "setTimeout(()=>{},100)"],
          env: process.env,
          priority,
        },
        async ({ exited }) => {
          running++
          peak = Math.max(peak, running)
          await exited
          running--
        }
      )
    )
  )
  assert.equal(peak, priority === "launch" ? 4 : 3)
  assert.equal(running, 0)
}
const held = Promise.withResolvers<void>()
const ready = Promise.withResolvers<void>()
let backgroundStarted = 0
const work = {
  command: process.execPath,
  args: ["-e", "setInterval(()=>{},1000)"],
  env: process.env,
}
const backgroundJobs = Array.from({ length: 3 }, () =>
  withDiscoveryProcess(work, async () => {
    if (++backgroundStarted === 3) ready.resolve()
    await held.promise
  })
)
await ready.promise
let queuedBackgroundStarted = false
const queuedBackground = withDiscoveryProcess(work, async () => {
  queuedBackgroundStarted = true
  await held.promise
})
try {
  let expiredStarted = false
  const expiredAt = performance.now()
  await assert.rejects(withDiscoveryProcess({ ...work, timeoutMs: 100 }, async () => { expiredStarted = true }), /timed out in the queue/)
  assert.equal(expiredStarted, false, "expired queued work must not spawn")
  assert.ok(performance.now() - expiredAt < 2_000, "queue time consumes the same bounded discovery budget")
  const cancelled = new AbortController()
  let cancelledStarted = false
  const cancelledQuery = withDiscoveryProcess({ ...work, signal: cancelled.signal }, async () => { cancelledStarted = true })
  const refused = assert.rejects(cancelledQuery, /superseded fixture discovery/)
  cancelled.abort(new Error("superseded fixture discovery"))
  await refused
  assert.equal(cancelledStarted, false)
  await Promise.race([
    withDiscoveryProcess({ ...work, priority: "launch" }, async () => {}),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("A launch query waited behind background discovery")
          ),
        2000
      )
    ),
  ])
  assert.equal(
    queuedBackgroundStarted,
    false,
    "The reserved slot cannot be consumed by display enrichment"
  )
} finally {
  held.resolve()
  await Promise.all([...backgroundJobs, queuedBackground])
}
const activeAbort = new AbortController()
let abortedPid: number | undefined
await assert.rejects(withDiscoveryProcess({ ...work, signal: activeAbort.signal }, async ({ child, exited }) => {
  abortedPid = child.pid
  activeAbort.abort(new Error("active fixture discovery cancelled"))
  await exited
}), /active fixture discovery cancelled/)
const cancelledPid = abortedPid
assert.ok(cancelledPid)
assert.throws(() => process.kill(cancelledPid, 0), { code: "ESRCH" }, "active cancellation cleans up its own process before returning")
console.log(
  "Profile transport: bounded output/concurrency, queue deadlines, queued and active cancellation, priority reservation, complete frames and confirmed owned process termination verified"
)
