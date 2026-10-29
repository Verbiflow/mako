import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

/**
 * A test's scratch folder (a home, a data root) is removed only once nothing
 * runs in it. A Grok sign-in probe a stopped host had started once went on
 * writing into its scratch home, and the test's `rm` failed with ENOTEMPTY:
 * a flake that hid a host leaving a harness process behind. These find what
 * still uses a folder, wait for it to go, and name it when it doesn't. They
 * never signal anything: a survivor is the bug under test, and killing it
 * here would hide it.
 */

/**
 * Every other process tied to `folder`: one whose command line names it, or
 * that has it, or a path under it, as its working folder or an open file. On
 * Linux, `/proc` also gives a process's `HOME`.
 */
export function processesUsingSync(folder) {
  const inside = (path) => path === folder || path.startsWith(`${folder}/`)
  const found = new Map()
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      const pid = Number(name)
      if (!Number.isInteger(pid) || pid === process.pid) continue
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()
        const home = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((entry) => entry.startsWith("HOME="))?.slice(5)
        const files = [readlinkSync(`/proc/${pid}/cwd`), ...readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { return "" } })]
        if (args.includes(folder) || (home && inside(home)) || files.some(inside)) found.set(pid, args)
      } catch {
        // Gone, or another user's: either way not one this test started.
      }
    }
    return [...found].map(([pid, args]) => ({ pid, args }))
  }
  const listed = new Map(execFileSync("ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const [, pid, args] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? []
    return [Number(pid), args ?? ""]
  }))
  for (const [pid, args] of listed) if (pid !== process.pid && args.includes(folder)) found.set(pid, args)
  let open = ""
  try {
    open = execFileSync("lsof", ["-nP", "-Fp", "+D", folder], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch (error) {
    // lsof exits 1 when nothing has a file there.
    open = error?.stdout ?? ""
  }
  for (const line of open.split("\n")) {
    const pid = Number(line.slice(1))
    if (line.startsWith("p") && pid !== process.pid && listed.has(pid)) found.set(pid, listed.get(pid))
  }
  return [...found].map(([pid, args]) => ({ pid, args }))
}

/** What still uses `folder` once `timeoutMs` has passed, or nothing as soon as nothing does. */
export async function processesLeftIn(folder, timeoutMs = 10_000) {
  for (const deadline = Date.now() + timeoutMs; ; await delay(100)) {
    const left = processesUsingSync(folder)
    if (!left.length || Date.now() >= deadline) return left
  }
}

/** One line per process, for a failure to name each. */
export function describeProcesses(processes) {
  return processes.map(({ pid, args }) => `  ${pid} ${args}`).join("\n")
}

/**
 * Removes `folder` once nothing uses it. A process still using it after
 * `timeoutMs` fails the run, naming it, with the folder left in place to
 * look at; so does a removal that fails anyway.
 */
export async function removeScratch(folder, timeoutMs = 10_000) {
  const left = await processesLeftIn(folder, timeoutMs)
  if (left.length) throw new Error(`${folder} is still in use ${timeoutMs / 1000} s after its test ended, so it was kept:\n${describeProcesses(left)}`)
  removeScratchSync(folder)
}

/** Removes `folder` now, retrying briefly; a failure names whatever uses it. */
export function removeScratchSync(folder) {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    const left = processesUsingSync(folder)
    throw new Error(`${folder} could not be removed (${error.code ?? error.message})${left.length ? `; still in use by:\n${describeProcesses(left)}` : ""}`, { cause: error })
  }
}
