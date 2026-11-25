import { existsSync } from "node:fs"
import { basename } from "node:path"
import { agyConversationPath } from "@mako/sessions"
import { fileResumeEvidence, nativeCheckpoint } from "../native-continuation.js"
import { probeOpenFiles } from "../open-files-probe.js"
import type { AcpResume } from "../acp-source.js"
import type { ProviderProcessProbe } from "../../threads/index.js"

export const antigravityProbe: ProviderProcessProbe = {
  provider: "antigravity",
  async probe(signal, target) {
    const result = await probeOpenFiles({
      processNames: ["agy", "antigravity"], signal,
      sourcePath: target?.path,
      accept: (path) => target ? path === target.path : /\/conversations\/[a-f0-9-]{36}\.db$/.test(path),
    })
    if (result.kind === "unavailable") return result
    return { kind: "available", sessions: result.paths.map((path) => ({ nativeId: basename(path, ".db"), path, status: "open" })) }
  },
}

export const antigravityResume: AcpResume = {
  kind: "native", via: "ACP session/load reopens the conversation by its ID.",
  wake: "The next message opens the saved Antigravity session.",
  ...fileResumeEvidence(antigravityProbe, async (path) => {
    const db = await nativeCheckpoint(path)
    return db && `${db}:${await nativeCheckpoint(path + "-wal") ?? ""}`
  }),
  locate({ nativeId, env }) {
    const path = agyConversationPath(env, nativeId)
    return path && existsSync(path) ? path : undefined
  },
}
