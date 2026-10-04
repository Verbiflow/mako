import { homedir } from "node:os"
import { join } from "node:path"
import { realpath } from "node:fs/promises"
import { probeOpenFiles } from "../open-files-probe.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

export function parseCursorOpenSessionPaths(
  output: string,
  roots: string[]
): string[] {
  const prefixes = roots.map((root) => `n${root.replace(/[\\/]$/, "")}/`)
  return [
    ...new Set(
      output
        .split("\n")
        .filter(
          (line) =>
            line.endsWith("/store.db") &&
            prefixes.some((prefix) => line.startsWith(prefix))
        )
        .map((line) => line.slice(1))
    ),
  ]
}

function sessions(paths: string[]): ProviderActivitySession[] {
  return paths.map((path) => ({ path, status: "open" }))
}

export const cursorProcessProbe: ProviderProcessProbe = {
  provider: "cursor",
  staleAfterMs: 15_000,
  async probe(signal, target) {
    const home = homedir()
    const roots = [
      join(home, ".cursor", "chats"),
      join(home, ".cursor", "acp-sessions"),
    ]
    const prefixes = roots.map((root) => `${root.replace(/[\\/]$/, "")}/`)
    const source = target ? await realpath(target.path).catch(() => target.path) : undefined
    // `cursor-agent` is a shell wrapper that execs Node, so lsof reports
    // the process as `node`; matching only the wrapper's name once found no
    // store at all (verified 2026-09-12). Every Node process is scanned and
    // the store paths do the filtering.
    const result = await probeOpenFiles({
      processNames: ["node", "cursor-agent", "Cursor"],
      sourcePath: source,
      signal,
      accept: (path) =>
        source ? path === source || path === target?.path :
          path.endsWith("/store.db") && prefixes.some((prefix) => path.startsWith(prefix)),
    })
    if (result.kind === "unavailable") return result
    if (target) return { kind: "available", sessions: result.paths.map(() => ({ nativeId: target.nativeId, path: target.path, status: "open", detail: "another process with the native source open" })) }
    return { kind: "available", sessions: sessions(result.paths) }
  },
}
