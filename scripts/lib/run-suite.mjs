import { execFileSync, spawn } from "node:child_process"

/** Every process of `group`, one line each, with what it's running: a hang's name. */
function groupProcesses(group) {
  // wchan: the kernel call each is blocked in, which is all a Linux runner can say of where it's stuck.
  const table = execFileSync("ps", ["-axo", "pid=,pgid=,stat=,wchan=,etime=,pcpu=,command="], { encoding: "utf8" })
  return table.split("\n").flatMap((line) => {
    const [pid, pgid] = line.trim().split(/\s+/)
    return Number(pgid) === group && Number(pid) !== process.pid ? [{ pid: Number(pid), line: line.trim().slice(0, 240) }] : []
  })
}

/** Where a process is stuck, on a Mac: every thread's native stack, without `sample`'s header and its list of libraries. */
function stackOf(pid) {
  if (process.platform !== "darwin") return ""
  try {
    const report = execFileSync("sample", [String(pid), "1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
    const graph = report.slice(Math.max(0, report.indexOf("Call graph:")), report.indexOf("Total number in stack") >>> 0)
    return graph.split("\n").slice(0, 400).map((line) => line.replace(/^(\s*[+!:|\s]*)\s+/, "$1").slice(0, 150)).join("\n")
  } catch {
    return ""
  }
}

/**
 * Runs a command in a process group of its own, its output passed through, and
 * answers its exit code, or null when it was stopped. It's stopped past
 * `limitMs`, or after `quietMs` with nothing printed, naming what was running
 * and where it was stuck, then ending the whole group: a hung suite used to
 * say nothing for 20 minutes and leave no word of which script it was.
 *
 * It ends on the command's exit, not on its output closing: a process it left
 * in the background can hold that open for good.
 */
export function runSuite(command, args, { limitMs, quietMs, write = (text) => process.stdout.write(text) }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true })
    const began = Date.now()
    let spoke = began
    let stopped = false
    const heard = (bytes) => {
      spoke = Date.now()
      write(bytes.toString())
    }
    child.stdout.on("data", heard)
    child.stderr.on("data", heard)
    const stop = (why) => {
      stopped = true
      clearInterval(watch)
      write(`\nHUNG: ${why}. What was running:\n`)
      const running = groupProcesses(child.pid)
      for (const { line } of running) write(`  ${line}\n`)
      for (const { pid, line } of running) if (/node|tsx/.test(line)) write(`--- ${pid}\n${stackOf(pid)}\n`)
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        /* It went by itself as it was named. */
      }
    }
    const watch = setInterval(() => {
      if (Date.now() - began > limitMs) stop(`past ${Math.round(limitMs / 1000)} s`)
      else if (Date.now() - spoke > quietMs) stop(`nothing printed for ${Math.round(quietMs / 1000)} s`)
    }, Math.min(1_000, quietMs / 4))
    const settle = (code) => {
      clearInterval(watch)
      child.stdout.removeListener("data", heard)
      child.stderr.removeListener("data", heard)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(stopped ? null : code)
    }
    child.once("error", (error) => {
      write(`\nDID NOT START: ${command}: ${error.message}\n`)
      settle(null)
    })
    child.once("exit", (code) => setTimeout(() => settle(code), 200))
  })
}
