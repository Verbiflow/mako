import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { ProviderChildren } from "../electron/provider-children.js"
import type { observeProcessIdentity } from "../electron/providers/process-liveness.js"

const root = await mkdtemp(join(tmpdir(), "mako-child-observation-"))
type Identity = Awaited<ReturnType<typeof observeProcessIdentity>>
const pending: Array<{ signal: AbortSignal; resolve(value: Identity): void }> =
  []
const registry = new ProviderChildren(
  root,
  process.pid,
  (_pid, signal) =>
    new Promise<Identity>((resolve) => pending.push({ signal, resolve }))
)
const schema = z.object({
  children: z.array(
    z.object({
      pid: z.number(),
      owner: z.string(),
      processStartedAt: z.number().optional(),
      executableIdentity: z.string().optional(),
    })
  ),
})
const records = async () =>
  schema.parse(JSON.parse(await readFile(registry.path, "utf8"))).children
const pid = 9_999_991
const track = (owner: string) =>
  registry.trackPid({
    pid,
    executable: "/fixture/launcher",
    kind: "fixture",
    owner,
  })
try {
  track("first")
  assert.equal(pending.length, 1)
  await delay(20)
  assert.equal(
    (await records())[0].processStartedAt,
    undefined,
    "Host timers must run while process identity observation is still pending"
  )
  registry.untrackPid(pid)
  assert.equal(pending[0].signal.aborted, true)
  track("replacement")
  assert.equal(pending.length, 2)
  pending[0].resolve({ startedAt: Date.now(), executable: "/fixture/old" })
  await delay(0)
  assert.equal(
    (await records())[0].executableIdentity,
    undefined,
    "An exited child's late observation cannot update a replacement record"
  )
  const born = Date.now()
  pending[1].resolve({ startedAt: born, executable: "/fixture/current" })
  await delay(0)
  assert.deepEqual(await records(), [
    {
      pid,
      owner: "replacement",
      processStartedAt: born,
      executableIdentity: "/fixture/current",
    },
  ])
  registry.untrackPid(pid)
  track("reused-pid")
  pending[2].resolve({
    startedAt: Date.now() - 60_000,
    executable: "/fixture/unrelated",
  })
  await delay(0)
  assert.equal(
    (await records())[0].processStartedAt,
    undefined,
    "An unrelated birth time cannot become authoritative cleanup evidence"
  )
  registry.untrackPid(pid)
  assert.deepEqual(await records(), [])
  console.log(
    "Child observation: host stays responsive; abort, exit/retrack and stale identity cannot revive or authorize a different process"
  )
} finally {
  registry.untrackPid(pid)
  await rm(root, { recursive: true, force: true })
}
