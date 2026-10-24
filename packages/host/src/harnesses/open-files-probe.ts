import { spawn } from "node:child_process"
import type { ProviderActivityResult } from "../threads/index.js"
import { onMac, onWindows } from "../base/platform.js"

export type OpenFilesResult =
  | {
      kind: "available"
      paths: string[]
      processFound: boolean
      pids: number[]
      /** Each pid's process group, where lsof named it: a provider Mako spawns leads its group, so a native binary under its wrapper shares the wrapper's. */
      groups: Map<number, number>
    }
  | Extract<ProviderActivityResult, { kind: "unavailable" }>

export async function probeOpenFiles({
  processNames,
  signal,
  accept,
  sourcePath,
}: {
  processNames: string[]
  signal: AbortSignal
  accept: (path: string) => boolean
  /** Query a source inode across processes; executable names are not reliable ownership evidence. */
  sourcePath?: string
}): Promise<OpenFilesResult> {
  if (onWindows())
    return { kind: "unavailable", reason: "unsupported" }
  const command = onMac() ? "/usr/sbin/lsof" : "lsof"
  return new Promise((resolve) => {
    const child = spawn(
      command,
      sourcePath ? ["-Fpgn", "--", sourcePath] : ["-Fpgn", ...processNames.flatMap((name) => ["-c", name])],
      { signal, stdio: ["ignore", "pipe", "pipe"] }
    )
    let diagnostic = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(0, 4096)
    })
    const paths = new Set<string>()
    const pids = new Set<number>()
    const groups = new Map<number, number>()
    let pid: number | undefined
    const field = (line: string) => {
      if (/^p\d+$/.test(line)) {
        pid = Number(line.slice(1))
        pids.add(pid)
      } else if (/^g\d+$/.test(line) && pid !== undefined) groups.set(pid, Number(line.slice(1)))
    }
    let carry = ""
    let incomplete = false
    let bytes = 0
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 16 * 1024 * 1024) {
        incomplete = true
        child.kill()
        return
      }
      carry += chunk
      const lines = carry.split("\n")
      carry = lines.pop() ?? ""
      if (carry.length > 64 * 1024) {
        incomplete = true
        carry = ""
      }
      for (const line of lines) {
        field(line)
        if (!line.startsWith("n")) continue
        const path = line.slice(1)
        if (accept(path)) paths.add(path)
      }
    })
    child.once("error", () =>
      resolve({
        kind: "unavailable",
        reason: signal.aborted ? "timeout" : "failed",
      })
    )
    child.once("close", (code) => {
      field(carry)
      if (carry.startsWith("n")) {
        const path = carry.slice(1)
        if (accept(path)) paths.add(path)
      }
      if (!incomplete && !signal.aborted && !diagnostic.trim() && (code === 1 || (code === 0 && pids.size > 0)))
        resolve({
          kind: "available",
          paths: [...paths],
          processFound: code === 0,
          pids: [...pids],
          groups,
        })
      else
        resolve({
          kind: "unavailable",
          reason: signal.aborted ? "timeout" : "failed",
        })
    })
  })
}
