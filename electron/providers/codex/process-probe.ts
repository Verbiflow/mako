import { homedir } from "node:os"
import { join } from "node:path"
import { realpath } from "node:fs/promises"
import { CodexSessionActivity } from "./session-activity.js"
import { probeOpenFiles } from "../open-files-probe.js"
import type { ProviderProcessProbe } from "../process-probe.js"

export function parseCodexOpenSessionPaths(
  output: string,
  root: string
): string[] {
  const prefix = `n${root.replace(/[\\/]$/, "")}/`
  return [
    ...new Set(
      output
        .split("\n")
        .filter((line) => line.startsWith(prefix) && line.endsWith(".jsonl"))
        .map((line) => line.slice(1))
    ),
  ]
}

const activity = new CodexSessionActivity()

export const codexProcessProbe: ProviderProcessProbe = {
  provider: "codex",
  staleAfterMs: 15_000,
  async probe(signal, target) {
    const root = join(homedir(), ".codex", "sessions")
    const prefix = `${root.replace(/[\\/]$/, "")}/`
    const source = target ? await realpath(target.path).catch(() => target.path) : undefined
    const result = await probeOpenFiles({
      processNames: ["codex"],
      sourcePath: source,
      signal,
      // Admission inspects the actual source, including custom CODEX_HOME and archived roots.
      accept: (path) => source ? path === source || path === target?.path : path.startsWith(prefix) && path.endsWith(".jsonl"),
    })
    if (result.kind === "unavailable") return result
    // Admission needs ownership, not turn activity. The exact open inode is
    // sufficient positive evidence; do not scan up to 64 MiB of transcript.
    if (target) return { kind: "available", sessions: result.paths.map(() => ({ nativeId: target.nativeId, path: target.path, status: "open", detail: "another process with the native source open" })) }
    activity.retain(result.paths)
    const sessions = []
    // Keep reads bounded even when many idle app-server sessions remain open.
    for (let index = 0; index < result.paths.length; index += 4) {
      const batch = await Promise.all(
        result.paths
          .slice(index, index + 4)
          .map((path) => activity.read(path, signal))
      )
      sessions.push(...batch)
    }
    return { kind: "available", sessions }
  },
}
