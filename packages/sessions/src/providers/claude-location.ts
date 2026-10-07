import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { z } from "zod"

/** A relative or unreadable entry is left out; the rest still count. */
const DeclaredRoots = z.object({ claude: z.array(z.string().refine((root) => isAbsolute(root)).nullable().catch(null)) })

/**
 * Where Claude Code's transcripts are, for the history reader and the usage
 * scanner alike: `~/.claude/projects`, which every Mako account's config
 * folder links back to, and each folder `~/.mako/roots.json` declares
 * (`{"claude": ["/abs/projects", …]}`). An exported `CLAUDE_CONFIG_DIR` adds
 * none: Mako launches Claude without it, so its sessions could be listed but
 * not resumed.
 */
export function claudeTranscriptRoots(home = homedir()): string[] {
  return [join(home, ".claude", "projects"), ...declaredRoots(home)]
}

function declaredRoots(home: string): string[] {
  let declared: unknown
  try {
    declared = JSON.parse(readFileSync(join(home, ".mako", "roots.json"), "utf8"))
  } catch {
    return []
  }
  return (DeclaredRoots.safeParse(declared).data?.claude ?? []).filter((root) => root !== null)
}
