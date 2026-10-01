import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { event, type TranscriptEvent } from "@mako/sessions/events"
import type { AccessTier } from "../../contracts/access.js"

/**
 * Grok applies Claude Code's `permissions.defaultMode` from Claude-compatible
 * settings, and that mode replaces `--permission-mode default`, which is
 * Mako's Ask; an explicit `auto` or `bypassPermissions` flag still wins.
 * Checked 2026-09-30 on grok 1.0.44 with real turns launched at Ask: an
 * imported `bypassPermissions` wrote a file without asking, and an imported
 * `dontAsk` denied every call it would have asked about ("denied by prompt
 * policy (tool not pre-approved)") without sending a request. Grok reads
 * `~/.claude` whatever `CLAUDE_CONFIG_DIR` says.
 */
export interface GrokImportedMode {
  mode: string
  file: string
}

export interface GrokAskOverride {
  /** The tier Grok runs at instead, when the imported mode is one of Mako's. */
  access?: AccessTier
  notice: TranscriptEvent
}

const TIER_OF_MODE = new Map<string, AccessTier>([
  ["default", "ask"],
  ["auto", "auto"],
  ["bypassPermissions", "full"],
])

const CONSEQUENCE = new Map([
  ["bypassPermissions", "it runs tools without asking"],
  ["auto", "its safety check decides instead of asking"],
  ["dontAsk", "it denies anything it would ask about, without asking"],
  ["acceptEdits", "it edits files without asking"],
  ["plan", "it starts in its own plan mode"],
])

/** Grok takes the nested `permissions.defaultMode`, else a top-level one. */
const ClaudeSettingsSchema = z.object({
  permissions: z.object({ defaultMode: z.string().min(1).optional() }).optional(),
  defaultMode: z.string().min(1).optional(),
})

/**
 * The mode Grok imports, from the settings it reads: the project's, from the
 * working folder up to its repository root, then the user's, local before
 * shared at each level.
 */
export function grokImportedPermissionMode(cwd: string, home = homedir()): GrokImportedMode | undefined {
  for (const dir of [...projectDirs(cwd, home), home]) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const file = join(dir, ".claude", name)
      const mode = defaultModeOf(file)
      if (mode) return { mode, file }
    }
  }
  return undefined
}

/** What launching Grok at Ask really does here, when imported settings decide otherwise. */
export function grokAskOverride(cwd: string, home = homedir()): GrokAskOverride | undefined {
  const imported = grokImportedPermissionMode(cwd, home)
  if (!imported || imported.mode === "default") return undefined
  const file = imported.file.startsWith(`${home}/`) ? `~/${imported.file.slice(home.length + 1)}` : imported.file
  const consequence = CONSEQUENCE.get(imported.mode) ?? `it runs in its ${imported.mode} mode`
  const override: GrokAskOverride = {
    notice: {
      ...event(
        "Grok overrides Ask",
        `${file} sets permissions.defaultMode to ${imported.mode}, so ${consequence}`,
        "Grok applies Claude Code's default permission mode in place of Ask. Remove it from that file, or choose Auto or Full, which Grok honors."
      ),
      tone: "warning",
    },
  }
  const access = TIER_OF_MODE.get(imported.mode)
  if (access) override.access = access
  return override
}

function projectDirs(cwd: string, home: string): string[] {
  const dirs: string[] = []
  for (let dir = cwd; dir !== home; dir = dirname(dir)) {
    dirs.push(dir)
    if (existsSync(join(dir, ".git"))) return dirs
    if (dirname(dir) === dir) break
  }
  return dirs.slice(0, 1).filter((dir) => dir !== home)
}

function defaultModeOf(file: string): string | undefined {
  try {
    const settings = ClaudeSettingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).data
    return settings?.permissions?.defaultMode ?? settings?.defaultMode
  } catch {
    return undefined
  }
}
