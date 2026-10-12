import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { event, type TranscriptEvent } from "@mako/sessions/events"

/**
 * What Grok's own settings do to the access Mako selects.
 *
 * Verified 2026-10-01 on grok 1.0.44 with real sessions against a scripted
 * model, and against its bundled `22-permissions-and-safety.md`:
 *
 * - Rules from every source merge into one set, and `deny` beats `ask`
 *   beats `allow` whatever file each came from. Deny holds at every tier,
 *   Full included; ask makes even a read ask.
 * - Sources: `~/.grok/config.toml` and the managed configs (`[permission]`
 *   `allow`/`ask`/`deny` strings, or `rules` tables), and the project's
 *   `.grok/config.toml` from the working folder up to the repository root.
 * - Project files count only in a folder Grok trusts: its real path, or its
 *   repository's root, is `trusted = true` in `~/.grok/trusted_folders.toml`.
 *   Mako launches without `--trust`, so an untrusted project's rules are
 *   skipped until the person answers Grok's trust request (`folder-trust.ts`),
 *   which names them among what it skips.
 *
 * Grok also imports Claude Code's permissions (`.claude/settings*.json`, at
 * home and in the project) unless its Claude import marker is set, and an
 * imported `defaultMode` replaced `--permission-mode default`, Mako's Ask, so
 * a person with Claude at `auto` got Auto when they chose Ask. Mako launches
 * Grok with that import off (`GROK_OWN_PERMISSIONS`), so Grok runs at the tier
 * chosen under its own rules alone.
 */
export type GrokRuleAction = "deny" | "ask" | "allow"

export interface GrokRule {
  action: GrokRuleAction
  rule: string
  file: string
}

export interface GrokPermissionPolicy {
  rules: GrokRule[]
}

export interface GrokPermissionPaths {
  cwd: string
  home: string
  /** Grok's own folder, `GROK_HOME` or `~/.grok`. */
  grokHome: string
}

/**
 * Turns off Grok's import of Claude Code's permission settings for the
 * process. Verified 2026-10-11 on grok 1.0.46 against a scripted model, with
 * `defaultMode: auto` in the home's `~/.claude/settings.json`: an edit under
 * `--permission-mode default` ran unasked; with this set, Grok asked first.
 * `--permission-mode`, `GROK_DEFAULT_PERMISSION_MODE`, `GROK_CONFIG`'s
 * `ui.permission_mode` and `claude_compat.imported`, and `_meta.autoMode:
 * false` all left Auto in force. It is the gate Grok's own import marker
 * (`[claude_compat] imported = true`) sets, and `grok inspect` showed it drops
 * only the Claude permission sources: Claude skills, `CLAUDE.md`,
 * `~/.claude.json` and `.mcp.json` servers still load. `test-grok-modes-live`
 * fails if a Grok release stops honouring it.
 */
export const GROK_OWN_PERMISSIONS: Readonly<Record<string, string>> = { _GROK_CLAUDE_MARKER_OVERRIDE: "1" }

/** Grok's launch notices: the permission rules it applies, which hold at every tier. */
export function grokLaunchNotices(policy: GrokPermissionPolicy, home: string): TranscriptEvent[] {
  return policy.rules.length ? [rulesNotice(policy.rules, home)] : []
}

const ACTIONS: readonly GrokRuleAction[] = ["deny", "ask", "allow"]

const RuleList = z.array(z.string().min(1)).catch([])

const GrokConfigSchema = z.object({
  permission: z.object({
    allow: RuleList.optional(),
    ask: RuleList.optional(),
    deny: RuleList.optional(),
    rules: z.array(z.object({
      action: z.enum(["allow", "ask", "deny"]),
      tool: z.string().min(1),
      pattern: z.string().min(1).optional(),
    })).catch([]).optional(),
  }).optional(),
})

const TrustSchema = z.object({
  folders: z.record(z.string(), z.object({ trusted: z.boolean().catch(false) }).catch({ trusted: false })).catch({}),
})

/** Every permission rule Grok will apply to a session started in `cwd`. */
export function grokPermissionPolicy(paths: GrokPermissionPaths): GrokPermissionPolicy {
  const { cwd, home, grokHome } = paths
  const project = projectDirs(cwd, home)
  const projectFiles = trustedProject(project, grokHome) ? [...project].reverse().map((dir) => join(dir, ".grok", "config.toml")) : []
  const userFiles = [join(grokHome, "config.toml"), join(grokHome, "managed_config.toml"), "/etc/grok/managed_config.toml"]
  return { rules: [...projectFiles, ...userFiles].flatMap(readGrokRules) }
}

const HEADINGS = new Map<GrokRuleAction, string>([
  ["deny", "Denied, at every access level"],
  ["ask", "Always asks first"],
  ["allow", "Runs without asking"],
])

function rulesNotice(rules: readonly GrokRule[], home: string): TranscriptEvent {
  const counts = ACTIONS.flatMap((action) => {
    const count = rules.filter((rule) => rule.action === action).length
    return count ? [`${count} ${action === "deny" ? "denied" : action === "ask" ? "always ask" : "allowed"}`] : []
  })
  const files = [...new Set(rules.map((rule) => tilde(rule.file, home)))]
  const sections = ACTIONS.flatMap((action) => {
    const listed = rules.filter((rule) => rule.action === action)
    if (!listed.length) return []
    return [`**${HEADINGS.get(action)}**\n\n${listed.map((rule) => `- \`${rule.rule}\` · ${tilde(rule.file, home)}`).join("\n")}`]
  })
  return {
    ...event(
      "Grok permission rules",
      `${counts.join(", ")} · ${files.length === 1 ? files[0] : `${files.length} files`}`,
      `Grok merges these rules from its own settings. Deny beats ask, and ask beats allow, whichever file a rule is in.\n\n${sections.join("\n\n")}`
    ),
    setup: true,
  }
}

function readGrokRules(file: string): GrokRule[] {
  const permission = readToml(file, GrokConfigSchema)?.permission
  if (!permission) return []
  const compact = ACTIONS.flatMap((action) => (permission[action] ?? []).map((rule) => ({ action, rule, file })))
  const tables = (permission.rules ?? []).map((rule) => ({
    action: rule.action,
    rule: rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool,
    file,
  }))
  return [...compact, ...tables]
}

/** From the working folder up to its repository root, nearest first; just the folder outside a repository. */
function projectDirs(cwd: string, home: string): string[] {
  const dirs: string[] = []
  for (let dir = cwd; dir !== home; dir = dirname(dir)) {
    dirs.push(dir)
    if (isRepositoryRoot(dir)) return dirs
    if (dirname(dir) === dir) break
  }
  return dirs.slice(0, 1).filter((dir) => dir !== home)
}

/** A `.git` folder with a `HEAD`, or a worktree's `.git` file: Grok asks git, and an empty `.git` is no repository. */
function isRepositoryRoot(dir: string): boolean {
  const git = join(dir, ".git")
  try {
    return statSync(git).isFile() || existsSync(join(git, "HEAD"))
  } catch {
    return false
  }
}

/** Whether Grok applies the project's own settings, instructions and skills in `cwd`. */
export function grokTrustsProject(paths: GrokPermissionPaths): boolean {
  return trustedProject(projectDirs(paths.cwd, paths.home), paths.grokHome)
}

/** Trust is recorded by real path, for the folder itself or its repository's root. */
function trustedProject(project: readonly string[], grokHome: string): boolean {
  if (!project.length) return false
  const trust = readToml(join(grokHome, "trusted_folders.toml"), TrustSchema)
  if (!trust) return false
  const trusted = new Set(Object.entries(trust.folders).flatMap(([path, entry]) => (entry.trusted ? [path] : [])))
  const root = project.at(-1)!
  const candidates = isRepositoryRoot(root) ? [project[0]!, root] : [project[0]!]
  return candidates.some((dir) => trusted.has(realPath(dir)))
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readToml<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.safeParse(parseToml(readFileSync(file, "utf8"))).data
  } catch {
    return undefined
  }
}

function tilde(file: string, home: string): string {
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file
}
