import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

function daemonFor(socket) {
  const pids = execFileSync("pgrep", ["-x", "mako-terminal-daemon"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number)
  return pids.find((pid) => {
    try {
      return execFileSync("lsof", ["-a", "-U", "-p", String(pid)], { encoding: "utf8" }).includes(socket)
    } catch {
      return false
    }
  })
}
const cpuSeconds = (pid) => {
  const [minutes, seconds] = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(":")
  return Number(minutes) * 60 + Number(seconds)
}

const endpoint = (root) => join(root, "profile", "terminal", "daemon.sock")

/** The daemon outlives the app by design; stop it once the package has quit, or the host respawns it. */
export function stopPackagedTerminal(root) {
  const pid = daemonFor(endpoint(root))
  if (pid) process.kill(pid, "SIGTERM")
}

/** A live shell in the package's own daemon: spawned from this bundle, answering input, idle when quiet. */
export async function checkPackagedTerminal({ app, bridge, waitFor, root, workspace, report, launchedAt }) {
  const session = await bridge("terminalCreate", [{ cwd: workspace, cols: 100, rows: 30 }])
  try {
    const pid = daemonFor(endpoint(root))
    assert.ok(pid, "No terminal daemon serves the package's profile")
    const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim())
    assert.ok(started >= launchedAt - 1000, "The terminal daemon predates this launch")
    const image = execFileSync("lsof", ["-a", "-d", "txt", "-p", String(pid), "-Fn"], { encoding: "utf8" })
    assert.ok(image.includes(join(app, "Contents")), "The terminal daemon does not run from this bundle")
    await bridge("terminalAttach", [session.id])
    await bridge("terminalWrite", [session.id, "echo MAKO_TERMINAL_$((6*7))\r"])
    await waitFor(
      () => bridge("terminalAttach", [session.id]),
      (snapshot) => snapshot.session.status === "running" && snapshot.data.includes("MAKO_TERMINAL_42"),
      "shell output",
      30_000
    )
    const before = cpuSeconds(pid)
    await delay(10_000)
    const idleCpu = cpuSeconds(pid) - before
    assert.ok(idleCpu < 0.2, `The idle terminal daemon used ${idleCpu}s of CPU in 10s`)
    report.phases.push({ phase: "terminal", daemonFreshFromBundle: true, output: true, idleCpuSecondsPer10s: idleCpu })
  } finally {
    await bridge("terminalKill", [session.id]).catch(() => {})
  }
}
