import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireHostLock } from "@mako/host/base/host-lock"

/**
 * `mako-host status` never takes the data root's host lock: a reading must not turn away a host starting under it.
 * A container's host was polled with `status` as it started, a poll held the lock at that instant, and the host exited
 * as "already running". While a `join` waits for its code, or a host is starting and not yet listening, `status` says
 * so and exits 0, rather than failing to reach a host that isn't there.
 */
const root = await mkdtemp(join(tmpdir(), "mako-device-cli-"))
const dataRoot = join(root, "data")
process.env.MAKO_DATA_ROOT = dataRoot
process.env.MAKO_WEB_SOCKET = join(root, "host.sock")
process.env.MAKO_SECRET_KEY_FILE = join(root, "host-key")
process.env.MAKO_CLOUD_URL = "https://cloud.invalid"
const { deviceCommand } = await import("@mako/host/usage/device-cli")

type Said = { code: number; out: string; err: string }
/** What the console heard while `run` ran: swapped once around it, so overlapping commands never leave it swapped. */
async function heard<T>(run: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const { log, error } = console
  console.log = (...args: unknown[]) => void out.push(args.join(" "))
  console.error = (...args: unknown[]) => void err.push(args.join(" "))
  try {
    return { result: await run(), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}
/** One command, with what it printed. */
async function status(): Promise<Said> {
  const { result, out, err } = await heard(() => deviceCommand("status", ["--json"]))
  return { code: result, out, err }
}

type Local = { local: { host: string; holder?: number } }

try {
  // Nobody holds the root: the saved sign-in is read, and the host said not running.
  const free = await status()
  assert.equal(free.code, 0, `status exits 0 with nobody holding the root: ${free.err}`)
  // SAFETY: `--json` prints the account with a `local` block, as `report` writes it.
  assert.equal((JSON.parse(free.out) as Local).local.host, "not running")

  // A join waiting for its code holds the lock, and no host listens: status says so, exits 0, and reaches for no host.
  const held = await acquireHostLock(dataRoot)
  assert.equal(held.kind, "held")
  try {
    const under = await status()
    assert.equal(under.code, 0, `status exits 0 while a join holds the root: ${under.err}`)
    // SAFETY: `--json` prints a `local` block naming the holder, as `reportHeld` writes it.
    const said = JSON.parse(under.out) as Local
    assert.equal(said.local.holder, process.pid, "it names who holds the root")
    assert.match(said.local.host, /join|starting/, `and says a join may be waiting or a host starting: ${said.local.host}`)
  } finally {
    await held.release()
  }

  // A host starting while status reads: status takes no lock, so the host is never refused by a reading.
  const { result: codes, err } = await heard(async () => {
    const readings = Array.from({ length: 12 }, () => deviceCommand("status", ["--json"]))
    for (let attempt = 0; attempt < 12; attempt++) {
      const lock = await acquireHostLock(dataRoot)
      assert.equal(lock.kind, "held", `a host starting beside a status reading takes the lock (attempt ${attempt + 1})`)
      await lock.release()
      await new Promise((done) => setImmediate(done))
    }
    return Promise.all(readings)
  })
  for (const code of codes) assert.equal(code, 0, err)
  console.log("device CLI: status reads without the host lock, says when a join or a starting host holds the root, and never turns a starting host away")
} finally {
  await rm(root, { recursive: true, force: true })
}
