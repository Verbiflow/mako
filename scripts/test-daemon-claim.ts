import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { claimDaemon, DaemonAlreadyServing } from "../packages/sessions/src/daemon.ts"

if (process.argv[2] === "hold") {
  await claimDaemon(process.argv[3])
  console.log("claimed")
  setInterval(() => {}, 60_000)
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-claim-"))
  try {
    const socket = join(root, "reader.sock")
    // What a reader that died used to leave: a lock file naming a pid that is alive now.
    await writeFile(`${socket}.lock`, String(process.ppid))
    const first = await claimDaemon(socket)
    await assert.rejects(claimDaemon(socket), DaemonAlreadyServing, "one claim at a time")
    await first.release()
    await (await claimDaemon(socket)).release()

    const holder = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "hold", socket], { stdio: ["ignore", "pipe", "inherit"] })
    await once(holder.stdout, "data")
    await assert.rejects(claimDaemon(socket), DaemonAlreadyServing, "another process's claim holds")
    holder.kill("SIGKILL")
    await once(holder, "exit")
    await (await claimDaemon(socket)).release()

    const nested = join(root, "catalogs", "identity", "reader.sock")
    await (await claimDaemon(nested)).release()
    assert.equal((await stat(dirname(nested))).mode & 0o777, 0o700, "the socket's folder exists, private, for the claimant to bind in")
    console.log("daemon claim: a stale lock file, a released claim and a killed holder never block; a live claim does; the socket's folder is made private")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
