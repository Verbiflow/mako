import { spawn } from "node:child_process"
import type { ProviderActivityResult } from "./process-probe.js"

export type OpenFilesResult =
  | { kind: "available"; paths: string[]; processFound: boolean }
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
  if (process.platform === "win32")
    return { kind: "unavailable", reason: "unsupported" }
  const command = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof"
  return new Promise((resolve) => {
    const child = spawn(
      command,
      sourcePath ? ["-Fn", "--", sourcePath] : ["-Fn", ...processNames.flatMap((name) => ["-c", name])],
      { signal, stdio: ["ignore", "pipe", "pipe"] }
    )
    let diagnostic = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(0, 4096)
    })
    const paths = new Set<string>()
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
      if (carry.startsWith("n")) {
        const path = carry.slice(1)
        if (accept(path)) paths.add(path)
      }
      if (!incomplete && !signal.aborted && !diagnostic.trim() && (code === 0 || code === 1))
        resolve({
          kind: "available",
          paths: [...paths],
          processFound: code === 0,
        })
      else
        resolve({
          kind: "unavailable",
          reason: signal.aborted ? "timeout" : "failed",
        })
    })
  })
}
