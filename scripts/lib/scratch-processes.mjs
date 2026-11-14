import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs"
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
        if (statSync(`/proc/${pid}`).uid !== process.getuid()) continue
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()
        const home = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((entry) => entry.startsWith("HOME="))?.slice(5)
        const files = [readlinkSync(`/proc/${pid}/cwd`), ...readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) } catch (error) { if (error?.code === "ENOENT") return ""; throw error } })]
        if (args.includes(folder) || (home && inside(home)) || files.some(inside)) found.set(pid, args)
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw new Error("Scratch process inspection was incomplete.", { cause: error })
      }
    }
    return [...found].map(([pid, args]) => ({ pid, args }))
  }
  const listed = new Map()
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
  if (ps.error || ps.signal || ps.status !== 0 || String(ps.stderr ?? "").trim()) throw new Error("Scratch process inspection was incomplete.")
  const rows = String(ps.stdout ?? "").trim()
  if (!rows) throw new Error("Scratch process inspection was empty.")
  for (const line of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw new Error("Scratch process inspection was malformed.")
    listed.set(Number(match[1]), match[2])
  }
  for (const [pid, args] of listed) if (pid !== process.pid && args.includes(folder)) found.set(pid, args)
  // List open files, not the whole scratch tree: a clone can have millions of tiny files.
  const lsof = spawnSync("lsof", ["-nP", "-F0pn", "-u", String(process.getuid?.())], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024 })
  const open = String(lsof.stdout ?? "")
  const empty = lsof.status === 1 && !open.trim() && !String(lsof.stderr ?? "").trim()
  if (lsof.error || lsof.signal || (!empty && (lsof.status !== 0 || String(lsof.stderr ?? "").trim()))) throw new Error("Scratch open-file inspection was incomplete.")
  if (!empty && !open.trim()) throw new Error("Scratch open-file inspection was empty.")
  let pid
  for (const raw of open.split("\0")) {
    const field = raw.replace(/^\n/, "")
    if (field.startsWith("p")) {
      if (!/^p[1-9]\d*$/.test(field)) throw new Error("Scratch open-file inspection was malformed.")
      pid = Number(field.slice(1))
    } else if (field.startsWith("n")) {
      if (!pid) throw new Error("Scratch open-file inspection had no process identity.")
      if (pid !== process.pid && inside(field.slice(1).replace(/ \(deleted\)$/, ""))) found.set(pid, listed.get(pid) ?? "owned scratch open")
    } else if (field.startsWith("f")) {
      if (field === "fNOFD") throw new Error("Scratch open-file inspection was incomplete.")
    } else if (field.trim()) throw new Error("Scratch open-file inspection was malformed.")
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
  return processes.map(({ pid }) => `  ${pid} still uses scratch`).join("\n")
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
