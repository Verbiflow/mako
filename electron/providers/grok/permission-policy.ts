import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { event, type TranscriptEvent } from "@mako/sessions/events"
import type { AccessTier } from "../../contracts/access.js"

/**
 * What Grok's own and Claude Code's settings do to the access Mako selects.
 *
 * Verified 2026-10-01 on grok 1.0.44 with real sessions against a scripted
 * model, and against its bundled `22-permissions-and-safety.md`:
 *
 * - Rules from every source merge into one set, and `deny` beats `ask`
 *   beats `allow` whatever file each came from. Deny holds at every tier,
 *   Full included; ask makes even a read ask.
 * - Sources: `~/.grok/config.toml` and the managed configs (`[permission]`
 *   `allow`/`ask`/`deny` strings, or `rules` tables), `~/.claude/settings.json`
 *   and `settings.local.json`, and the project's `.grok/config.toml` and
 *   `.claude/settings*.json` from the working folder up to the repository
 *   root. Grok reads `~/.claude` whatever `CLAUDE_CONFIG_DIR` says.
 * - Project files count only in a folder Grok trusts: its real path, or its
 *   repository's root, is `trusted = true` in `~/.grok/trusted_folders.toml`.
 *   Mako launches without `--trust`, so an untrusted project's rules and mode
 *   are skipped until the person answers Grok's trust request
 *   (`folder-trust.ts`), which names them among what it skips.
 * - Claude's `permissions.defaultMode` (or a top-level `defaultMode`) from
 *   the nearest file, project local first, replaces `--permission-mode
 *   default`, which is Mako's Ask. An explicit `auto` or `bypassPermissions`
 *   flag still wins, and Grok's own `[ui] permission_mode` never overrides
 *   the flag. An imported `bypassPermissions` wrote without asking; an
 *   imported `dontAsk` denied every call no rule allowed, without a request.
 */
export type GrokRuleAction = "deny" | "ask" | "allow"

export interface GrokRule {
  action: GrokRuleAction
  rule: string
  file: string
}

export interface GrokPermissionPolicy {
  /** The Claude-compatible default mode in force, and the file it came from. */
  mode?: { mode: string; file: string }
  rules: GrokRule[]
}

export interface GrokPermissionPaths {
  cwd: string
  home: string
  /** Grok's own folder, `GROK_HOME` or `~/.grok`. */
  grokHome: string
}

export interface GrokLaunchPolicy {
  /** The tier Grok runs at instead of Ask, when the imported mode is one of Mako's. */
  access?: AccessTier
  notices: TranscriptEvent[]
}

const ACTIONS: readonly GrokRuleAction[] = ["deny", "ask", "allow"]

const TIER_OF_MODE = new Map<string, AccessTier>([
  ["default", "ask"],
  ["auto", "auto"],
  ["bypassPermissions", "full"],
])

const CONSEQUENCE = new Map([
  ["bypassPermissions", "it runs tools without asking"],
  ["auto", "its safety check decides instead of asking"],
  ["dontAsk", "it denies anything no rule allows, without asking"],
  ["acceptEdits", "it edits files without asking"],
  ["plan", "it starts in its own plan mode"],
])

const RuleList = z.array(z.string().min(1)).catch([])

const ClaudeSettingsSchema = z.object({
  permissions: z.object({
    defaultMode: z.string().min(1).optional(),
    allow: RuleList.optional(),
    ask: RuleList.optional(),
    deny: RuleList.optional(),
  }).optional(),
  defaultMode: z.string().min(1).optional(),
})

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

interface SettingsFile {
  file: string
  mode?: string
  rules: GrokRule[]
}

/** Everything Grok will apply to a session started in `cwd`. */
export function grokPermissionPolicy(paths: GrokPermissionPaths): GrokPermissionPolicy {
  const { cwd, home, grokHome } = paths
  const project = projectDirs(cwd, home)
  const trusted = trustedProject(project, grokHome)
  const claudeProject = project.flatMap((dir) => [join(dir, ".claude", "settings.local.json"), join(dir, ".claude", "settings.json")])
  const grokProject = [...project].reverse().map((dir) => join(dir, ".grok", "config.toml"))
  const claudeUser = [join(home, ".claude", "settings.local.json"), join(home, ".claude", "settings.json")]
  const grokUser = [join(grokHome, "config.toml"), join(grokHome, "managed_config.toml"), "/etc/grok/managed_config.toml"]

  const projectFiles = [...claudeProject.map(readClaude), ...grokProject.map(readGrok)].filter(changesPermissions)
  const userFiles = [...claudeUser.map(readClaude), ...grokUser.map(readGrok)].filter(changesPermissions)
  const applied = trusted ? [...projectFiles, ...userFiles] : userFiles
  const policy: GrokPermissionPolicy = { rules: applied.flatMap((file) => file.rules) }
  const mode = applied.find((file) => file.mode !== undefined)
  if (mode?.mode) policy.mode = { mode: mode.mode, file: mode.file }
  return policy
}

/** The tier Grok really runs at for the selected `access`, and what the conversation should be told. */
export function grokLaunchPolicy(policy: GrokPermissionPolicy, access: AccessTier | undefined, home: string): GrokLaunchPolicy {
  const launch: GrokLaunchPolicy = { notices: [] }
  const imported = access === "ask" ? policy.mode : undefined
  if (imported && imported.mode !== "default") {
    const consequence = CONSEQUENCE.get(imported.mode) ?? `it runs in its ${imported.mode} mode`
    launch.notices.push({
      ...event(
        "Grok overrides Ask",
        `${tilde(imported.file, home)} sets permissions.defaultMode to ${imported.mode}, so ${consequence}`,
        "Grok applies Claude Code's default permission mode in place of Ask. Remove it from that file, or choose Auto or Full, which Grok honors."
      ),
      tone: "warning",
      setup: true,
    })
    const tier = TIER_OF_MODE.get(imported.mode)
    if (tier) launch.access = tier
  }
  if (policy.rules.length) launch.notices.push(rulesNotice(policy.rules, home))
  return launch
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
      `Grok merges these rules from its own and Claude Code's settings. Deny beats ask, and ask beats allow, whichever file a rule is in.\n\n${sections.join("\n\n")}`
    ),
    setup: true,
  }
}

function changesPermissions(file: SettingsFile | undefined): file is SettingsFile {
  return file !== undefined && (file.mode !== undefined || file.rules.length > 0)
}

function readClaude(file: string): SettingsFile | undefined {
  const settings = readJson(file, ClaudeSettingsSchema)
  if (!settings) return undefined
  const permissions = settings.permissions
  const read: SettingsFile = {
    file,
    rules: ACTIONS.flatMap((action) => (permissions?.[action] ?? []).map((rule) => ({ action, rule, file }))),
  }
  const mode = permissions?.defaultMode ?? settings.defaultMode
  if (mode) read.mode = mode
  return read
}

function readGrok(file: string): SettingsFile | undefined {
  const permission = readToml(file, GrokConfigSchema)?.permission
  if (!permission) return undefined
  const compact = ACTIONS.flatMap((action) => (permission[action] ?? []).map((rule) => ({ action, rule, file })))
  const tables = (permission.rules ?? []).map((rule) => ({
    action: rule.action,
    rule: rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool,
    file,
  }))
  return { file, rules: [...compact, ...tables] }
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

function readJson<T>(file: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.safeParse(JSON.parse(readFileSync(file, "utf8"))).data
  } catch {
    return undefined
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
