import type { AuthoringApplied, AuthoringCatalog, AuthoringChange, AuthoringEntry, AuthoringOperations, AuthoringPlan, AuthoringSource, AuthoringTarget, AuthoringView, HookVocabulary } from "@mako/host/contracts/native-authoring"

/**
 * Every harness's hooks, commands and MCP servers as the host reads the
 * shapes in `scripts/fixtures/native-authoring`, for `?mock` and the
 * Settings screenshots. A preview shows a small diff of the change; apply
 * changes this copy only.
 */

const CWD = "/Users/fixture/code/project"
const HOME = "/Users/fixture"
const yes = { supported: true } as const
const no = (reason: string) => ({ supported: false, reason }) as const

function ops(disable: AuthoringOperations["disable"], trust: AuthoringOperations["trust"], create: AuthoringOperations["create"] = yes): AuthoringOperations {
  return { create, edit: create, remove: yes, disable, trust }
}

function source(scope: AuthoringSource["scope"], path: string, label: string, rank: number, extra: Partial<AuthoringSource> = {}): AuthoringSource {
  return { id: `${scope}:${path}`, scope, path, label, rank, exists: true, writable: yes, ...extra }
}

function hook(at: AuthoringSource, event: string, run: string, extra: { matcher?: string; type?: string; timeout?: number; enabled?: boolean; trust?: AuthoringEntry["trust"]; index?: number } = {}): AuthoringEntry {
  const entry: AuthoringEntry = {
    id: `${at.id}#${event}/${extra.index ?? 0}/0`, sourceId: at.id, name: `${event}${extra.matcher ? ` · ${extra.matcher}` : ""}`, enabled: extra.enabled ?? true,
    hook: { event, type: extra.type ?? "command", run, other: [] },
  }
  if (extra.matcher) entry.hook!.matcher = extra.matcher
  if (extra.timeout) entry.hook!.timeout = extra.timeout
  if (extra.trust) entry.trust = extra.trust
  return entry
}

function command(at: AuthoringSource, invocation: string, description: string, shadowedBy?: string): AuthoringEntry {
  const entry: AuthoringEntry = { id: `${at.id}#${invocation}.md`, sourceId: at.id, name: `/${invocation}`, enabled: true, command: { invocation, description, text: `---\ndescription: ${description}\n---\n${description}.\n` } }
  if (shadowedBy) entry.shadowedBy = shadowedBy
  return entry
}

function server(at: AuthoringSource, name: string, enabled: boolean, transport: "stdio" | "http", target: string, envNames: string[] = []): AuthoringEntry {
  return { id: `${at.id}#${name}`, sourceId: at.id, name, enabled, mcp: transport === "stdio" ? { transport, command: target, args: [], envNames, headerNames: [] } : { transport, url: target, envNames, headerNames: [] } }
}

const vocabulary = (events: string[], handlers: HookVocabulary["handlers"]): HookVocabulary => ({ events, handlers, matcher: true })
const MCP_OPS = { create: no("Copy a server in from another agent in the MCP servers section."), edit: no("Change a server's command by copying it in again from another agent."), disable: yes, remove: yes, trust: no("Servers have no trust of their own.") }

function views(): AuthoringView[] {
  const claudeUser = source("user", `${HOME}/.claude/settings.json`, "User settings", 0)
  const claudeProject = source("project", `${CWD}/.claude/settings.json`, "Project settings", 1, { trust: { state: "unasked", detail: "Claude Code's SDK, which Mako runs, reads this folder's settings without asking you to trust it." } })
  const claudeLocal = source("local", `${CWD}/.claude/settings.local.json`, "Local project settings", 2, { exists: false })
  const claudeCommandsUser = source("user", `${HOME}/.claude/commands`, "User commands", 0)
  const claudeCommandsProject = source("project", `${CWD}/.claude/commands`, "Project commands", 1)
  const claudeJson = source("user", `${HOME}/.claude.json`, "User servers in ~/.claude.json", 0)
  const mcpJson = source("project", `${CWD}/.mcp.json`, "Project servers in .mcp.json", 1)
  const codexUser = source("user", `${HOME}/.codex/hooks.json`, "User hooks.json", 0)
  const codexToml = source("user", `${HOME}/.codex/config.toml`, "User config.toml", 1, { writable: no("Mako writes Codex hooks to hooks.json. Edit the [hooks] table of config.toml in your editor.") })
  const codexProject = source("project", `${CWD}/.codex/hooks.json`, "Project hooks.json in the project's root", 2, { trust: { state: "trusted", detail: `Codex trusts ${CWD}.` } })
  const cursorUser = source("user", `${HOME}/.cursor/hooks.json`, "User hooks.json", 1)
  const cursorProject = source("project", `${CWD}/.cursor/hooks.json`, "Project hooks.json", 2)
  const cursorClaude = source("imported", `${HOME}/.claude/settings.json`, "Claude Code user settings", 3, { writable: no("Claude Code's settings, which Cursor also runs hooks from. Edit them under Claude Code.") })
  const grokUser = source("user", `${HOME}/.grok/hooks/cmux-session.json`, "User hooks/cmux-session.json", 0)
  const grokProject = source("project", `${CWD}/.grok/hooks/checks.json`, "Project hooks/checks.json", 20, { trust: { state: "trusted", detail: "Grok trusts this project." } })
  const grokCursor = source("imported", `${HOME}/.cursor/hooks.json`, "Cursor user hooks.json", 13, { writable: no("Cursor's file, which Grok also reads. Edit it under Cursor."), off: { key: "compat.cursor.hooks", detail: "Grok doesn't read these while [compat.cursor] hooks = false is in ~/.grok/config.toml." } })
  const grokCommandsProject = source("project", `${CWD}/.grok/commands`, ".grok/commands in the project's root", 0, { trust: { state: "trusted", detail: "Grok trusts this project." } })
  const grokCommandsUser = source("user", `${HOME}/.grok/commands`, "~/.grok/commands", 100)
  const devinV1 = source("project", `${CWD}/.devin/hooks.v1.json`, "hooks.v1.json in the project's root", 0, { trust: { state: "unasked", detail: "Devin ran this folder's hooks over ACP without asking to trust it." } })
  const devinUser = source("user", `${HOME}/.config/devin/config.json`, "User config.json", 5)
  const opencodePlugins = source("user", `${HOME}/.config/opencode/plugins`, "User plugins (plugins/)", 0)
  const opencodeCommands = source("project", `${CWD}/.opencode/commands`, "Project commands (.opencode/commands/)", 50)
  const opencodeConfig = source("user", `${HOME}/.config/opencode/opencode.jsonc`, "User opencode.jsonc", 11)
  const codexConfig = source("user", `${HOME}/.codex/config.toml`, "User config.toml", 0)
  const grokConfig = source("user", `${HOME}/.grok/config.toml`, "User config.toml", 20)
  const devinMcp = source("user", `${HOME}/.config/devin/mcp_config.json`, "User mcp_config.json", 0)
  const cursorMcp = source("user", `${HOME}/.cursor/mcp.json`, "User mcp.json", 0)
  const claudeHooks = vocabulary(["PreToolUse", "PostToolUse", "SessionStart", "Stop", "UserPromptSubmit", "Notification"], [{ type: "command", run: "command" }, { type: "http", run: "url" }, { type: "prompt", run: "prompt" }])
  const trusted = { state: "trusted" as const, detail: "You trusted this hook as it is now." }
  const untrusted = { state: "untrusted" as const, detail: "Codex won't run this hook until you trust it, here or in Codex's /hooks." }
  return [
    { provider: "claude", family: "hooks", label: "Claude Code", form: "hook", operations: ops(no("Claude Code has no switch for one hook; disableAllHooks in a settings file turns every hook off at once."), no("Claude Code's SDK, which Mako runs, reads project hooks without a trust prompt.")),
      precedence: "Hooks from every settings file run, user, project, local and managed alike. disableAllHooks in any file but the managed one turns them all off.", reload: "Claude Code reads hooks when a conversation starts.",
      hooks: claudeHooks, sources: [claudeUser, claudeProject, claudeLocal],
      entries: [hook(claudeUser, "SessionStart", "~/.claude/hooks/session-start.sh", { timeout: 10 }), hook(claudeUser, "PostToolUse", "npx prettier --write \"$CLAUDE_FILE\"", { matcher: "Edit|Write" }), hook(claudeProject, "PreToolUse", "./scripts/guard-shell.sh", { matcher: "Bash" })] },
    { provider: "claude", family: "commands", label: "Claude Code", form: "command", operations: ops(no("Claude Code reads a command file while it exists; there's no switch for one."), no("Claude Code's SDK reads project commands without asking.")),
      precedence: "A user command wins over a project command of the same name. A file in a folder is named with the folder, as /folder:name.", reload: "Claude Code reads commands when a conversation starts.",
      sources: [claudeCommandsUser, claudeCommandsProject],
      entries: [command(claudeCommandsUser, "git:commit", "Commit the staged change"), command(claudeCommandsProject, "review", "Review the diff for bugs")] },
    { provider: "claude", family: "mcp", label: "Claude Code", form: "mcp", operations: MCP_OPS, precedence: "A local server wins over a project server in .mcp.json, which wins over a user server of the same name.", reload: "Claude Code starts MCP servers when a conversation starts.",
      sources: [claudeJson, mcpJson], entries: [server(claudeJson, "docs", false, "http", "https://docs.example.com/mcp"), server(mcpJson, "project-tool", true, "stdio", "node")] },
    { provider: "codex", family: "hooks", label: "Codex", form: "hook", operations: ops(yes, yes),
      precedence: "Hooks from every layer run: user, each project folder from the root down, and managed. A project's hooks load only once Codex trusts the project, and each hook outside the managed layer runs only once you've trusted it.", reload: "Codex reads hooks when a conversation starts.",
      hooks: { ...vocabulary(["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart", "Stop"], [{ type: "command", run: "command" }]), matchers: ["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart"] },
      sources: [codexUser, codexToml, codexProject],
      entries: [hook(codexUser, "SessionStart", "~/.codex/hooks/session-start.sh", { timeout: 5, trust: trusted }), hook(codexUser, "Stop", "say done", { enabled: false, trust: untrusted }), hook(codexProject, "PreToolUse", "./scripts/check.sh", { matcher: "Bash", trust: untrusted })] },
    { provider: "codex", family: "commands", label: "Codex", form: "command", operations: ops(no("—"), no("—")), precedence: "", reload: "", sources: [], entries: [], absent: { by: "harness", reason: "Codex 0.159 reads no prompt files: ~/.codex/prompts is retired, and its commands are skills, under Skills" } },
    { provider: "codex", family: "mcp", label: "Codex", form: "mcp", operations: MCP_OPS, precedence: "A trusted project's config.toml is merged over the user's key by key.", reload: "Codex starts MCP servers when a conversation starts.",
      sources: [codexConfig], entries: [server(codexConfig, "docs", true, "http", "https://docs.example.com/mcp"), server(codexConfig, "computer-use", false, "stdio", "/usr/bin/true")] },
    { provider: "cursor", family: "hooks", label: "Cursor", form: "hook", operations: ops(no("Cursor has no switch for one hook; a hook runs while it's in hooks.json."), no("Cursor runs a project's hooks without asking you to trust the folder.")),
      precedence: "Hooks from every file run: MDM, user, project, and Claude Code's settings, which Cursor converts. Where hooks answer differently, deny wins over ask, and ask over allow.", reload: "Cursor reads hooks when a conversation starts.",
      hooks: vocabulary(["beforeShellExecution", "beforeMCPExecution", "afterFileEdit", "stop", "sessionStart"], [{ type: "command", run: "command" }, { type: "prompt", run: "prompt" }]),
      sources: [cursorUser, cursorProject, cursorClaude],
      entries: [hook(cursorUser, "stop", "afplay /System/Library/Sounds/Glass.aiff"), hook(cursorProject, "beforeShellExecution", "./scripts/no-force-push.sh", { matcher: "git push" }), hook(cursorClaude, "SessionStart", "~/.claude/hooks/session-start.sh", { timeout: 10 })] },
    { provider: "cursor", family: "commands", label: "Cursor", form: "command", operations: ops(no("—"), no("—")), precedence: "", reload: "", sources: [], entries: [], absent: { by: "harness", reason: "Cursor's SDK reads no command folder; Cursor moved its commands into skills, under Skills" } },
    { provider: "cursor", family: "mcp", label: "Cursor", form: "mcp", operations: MCP_OPS, precedence: "A project server wins over a user server of the same name.", reload: "Cursor starts MCP servers when a conversation starts.",
      sources: [cursorMcp], entries: [server(cursorMcp, "docs", true, "http", "https://docs.example.com/mcp")] },
    { provider: "opencode", family: "hooks", label: "OpenCode", form: "module", operations: ops(no("OpenCode turns a plugin off by the id its code declares, with \"-<id>\" in plugins; Mako doesn't run a plugin's code to read its id."), no("OpenCode loads a project's plugins without asking.")),
      precedence: "Every plugin file in these folders loads, the user's and the project's, beside the npm packages named in plugins.", reload: "OpenCode loads plugins when its server starts, which Mako does for each new connection.",
      sources: [opencodePlugins], entries: [{ id: `${opencodePlugins.id}#notify.js`, sourceId: opencodePlugins.id, name: "notify.js", enabled: true, module: { text: "// Notify when a session goes idle.\nexport default { id: \"notify\" }\n" } }] },
    { provider: "opencode", family: "commands", label: "OpenCode", form: "command", operations: ops(no("OpenCode reads a command while it exists; there's no switch for one."), no("OpenCode reads a project's commands without asking.")),
      precedence: "Files in command/ and commands/ and entries of the commands key are all read; a project's command replaces a user's of the same name.", reload: "OpenCode reads commands when its server starts.",
      sources: [opencodeConfig, opencodeCommands], entries: [command(opencodeConfig, "hello", "Greets"), command(opencodeCommands, "git/pr", "Open a pull request")] },
    { provider: "opencode", family: "mcp", label: "OpenCode", form: "mcp", operations: MCP_OPS, precedence: "The last server of a name replaces the others whole.", reload: "OpenCode starts MCP servers when its server starts.",
      sources: [opencodeConfig], entries: [server(opencodeConfig, "docs", false, "http", "https://docs.example.com/mcp")] },
    { provider: "grok", family: "hooks", label: "Grok", form: "hook", operations: ops(yes, no("Grok trusts a whole folder, when you answer its trust prompt; there's no trust for one hook.")),
      precedence: "Hooks from every file run, Grok's own and the Claude Code and Cursor files it imports. A project's own hooks load only in a Git repository Grok trusts.", reload: "Grok reads hooks when a conversation starts.",
      hooks: vocabulary(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Notification"], [{ type: "command", run: "command" }, { type: "http", run: "url" }]),
      sources: [grokUser, grokProject, grokCursor],
      entries: [hook(grokUser, "SessionStart", "cmux notify session-start", { timeout: 5 }), hook(grokUser, "Stop", "cmux notify stop", { enabled: false, index: 1 }), hook(grokProject, "PreToolUse", "./scripts/guard-shell.sh", { matcher: "Bash" }), hook(grokCursor, "stop", "afplay /System/Library/Sounds/Glass.aiff", { enabled: false })] },
    { provider: "grok", family: "commands", label: "Grok", form: "command", operations: ops(no("Grok reads a command file while it exists; there's no switch for one."), no("Grok trusts a whole folder.")),
      precedence: "The first command of a name wins: the project's .grok, .agents, .claude and .cursor folders from the working folder up, then the user's.", reload: "Grok reads commands when a conversation starts.",
      sources: [grokCommandsProject, grokCommandsUser], entries: [command(grokCommandsProject, "standup", "The project's standup"), command(grokCommandsUser, "standup", "Write the standup", `${grokCommandsProject.id}#standup.md`)] },
    { provider: "grok", family: "mcp", label: "Grok", form: "mcp", operations: MCP_OPS, precedence: "The first server of a name replaces the rest.", reload: "Grok starts MCP servers when a conversation starts.",
      sources: [grokConfig], entries: [server(grokConfig, "docs", true, "http", "https://docs.example.com/mcp")] },
    { provider: "devin", family: "hooks", label: "Devin", form: "hook", operations: ops(no("Devin has no switch for one hook; read_config_from.claude: false in its config stops it running Claude Code's."), no("Devin ran this folder's hooks over ACP without asking to trust it.")),
      precedence: "Hooks from every file run: each project folder from the working folder up to the repository's root, the user config, and Claude Code's settings, which Devin imports.", reload: "Devin reads hooks when a conversation starts.",
      hooks: vocabulary(["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "SessionStart"], [{ type: "command", run: "command" }, { type: "prompt", run: "prompt" }]),
      sources: [devinV1, devinUser], entries: [hook(devinV1, "PreToolUse", "./scripts/guard-shell.sh", { matcher: "exec", timeout: 10 }), hook(devinUser, "UserPromptSubmit", "~/.config/devin/hooks/prompt-log.sh")] },
    { provider: "devin", family: "commands", label: "Devin", form: "command", operations: ops(no("—"), no("—")), precedence: "", reload: "", sources: [], entries: [], absent: { by: "harness", reason: "Devin's slash commands are its skills, under Skills; 3000.10.23 reads no command folder" } },
    { provider: "devin", family: "mcp", label: "Devin", form: "mcp", operations: MCP_OPS, precedence: "A server in .devin/mcp_config.local.json wins over the project's and the user's.", reload: "Devin starts MCP servers when a conversation starts.",
      sources: [devinMcp], entries: [server(devinMcp, "docs", false, "http", "https://docs.example.com/mcp")] },
  ]
}

/** One copy per page, so a change applied in the fixture stays applied. */
export function mockAuthoring() {
  let catalog: AuthoringCatalog = { cwd: CWD, views: views() }
  const find = (target: AuthoringTarget) => catalog.views.find((view) => view.provider === target.provider && view.family === target.family)
  const plan = (target: AuthoringTarget, change: AuthoringChange): AuthoringPlan => {
    const view = find(target)
    const entry = "entryId" in change ? view?.entries.find((candidate) => candidate.id === change.entryId) : undefined
    const at = view?.sources.find((candidate) => candidate.id === (change.kind === "create" ? change.sourceId : entry?.sourceId))
    if (!view || !at) throw new Error("That entry is no longer where it was. Reload and try again.")
    const context = (text: string, line: number): AuthoringPlan["lines"][number] => ({ kind: "context", text, before: line, after: line })
    const added = (text: string, line: number): AuthoringPlan["lines"][number] => ({ kind: "add", text, after: line })
    const removed = (text: string, line: number): AuthoringPlan["lines"][number] => ({ kind: "remove", text, before: line })
    const event = entry?.hook?.event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() ?? ""
    let path = at.path
    let scope = at.scope
    let lines: AuthoringPlan["lines"]
    let summary: string
    if (change.kind === "trust") {
      path = `${HOME}/.codex/config.toml`
      scope = "user"
      summary = `Trust a ${entry?.hook?.event} hook from ${at.label}, as Codex's /hooks review does`
      lines = [context("[mcp_servers.computer-use]", 18), context("enabled = false", 19), context("", 20), added(`[hooks.state."${at.path}:${event}:0:0"]`, 21), added("trusted_hash = \"sha256:6c972df66a04bcdffaaaaba82576c524586526c989fa3bdd8ccc4c7025d266e7\"", 22)]
    } else if (change.kind === "enable" && entry?.hook) {
      path = `${HOME}/.grok/disabled-hooks`
      scope = "user"
      const name = `global/cmux-session:${event}[0].hooks[0]`
      summary = `${change.enabled ? "Turn on" : "Turn off"} ${name} in ~/.grok/disabled-hooks`
      lines = change.enabled ? [removed(name, 2)] : [context("global/cmux-session:stop[0].hooks[0]", 1), added(name, 2)]
    } else if (change.kind === "enable") {
      summary = `${change.enabled ? "Turn on" : "Turn off"} ${entry?.name} in ${at.label}`
      lines = target.provider === "codex"
        ? [context(`[mcp_servers.${entry?.name}]`, 12), context("url = \"https://docs.example.com/mcp\"", 13), change.enabled ? removed("enabled = false", 14) : added("enabled = false", 14), context("", 15)]
        : [context(`    "${entry?.name}": {`, 4), context("      \"url\": \"https://docs.example.com/mcp\",", 5), change.enabled ? removed("      \"disabled\": true,", 6) : added("      \"disabled\": true,", 6), context("      \"headers\": { \"Authorization\": \"[redacted]\" }", 7)]
    } else if (change.kind === "remove") {
      summary = `Remove ${entry?.name} from ${at.label}`
      lines = [context("  \"hooks\": {", 2), removed(`    "${entry?.hook?.event ?? entry?.name}": [`, 3), removed(`      { "hooks": [{ "type": "command", "command": "${entry?.hook?.run ?? ""}" }] }`, 4), removed("    ],", 5), context("  }", 6)]
    } else {
      const draft = change.draft
      summary = `${change.kind === "create" ? "Add" : "Change"} a ${draft.kind === "hook" ? draft.event : "new"} hook in ${at.label}`
      const run = draft.kind === "hook" ? draft.run : ""
      lines = draft.kind === "hook"
        ? [context("  \"hooks\": {", 1), added(`    "${draft.event}": [`, 2), added("      {", 3), added("        \"hooks\": [", 4), added(`          { "type": "${draft.type}", "command": ${JSON.stringify(run)} }`, 5), added("        ]", 6), added("      }", 7), added("    ],", 8), context("    \"UserPromptSubmit\": [", 9)]
        : [added(draft.kind === "command" ? draft.text : draft.text, 1)]
    }
    return { target, change, path, scope, summary, revision: "0".repeat(64), effect: "edit-file", lines, backup: true }
  }
  return {
    nativeAuthoringCatalog: async () => catalog,
    nativeAuthoringView: async (target: AuthoringTarget) => {
      const view = find(target)
      if (!view) throw new Error("No such view in the fixture")
      return view
    },
    previewNativeAuthoring: async (target: AuthoringTarget, change: AuthoringChange) => plan(target, change),
    applyNativeAuthoring: async (target: AuthoringTarget, change: AuthoringChange): Promise<AuthoringApplied> => {
      const preview = plan(target, change)
      catalog = { ...catalog, views: catalog.views.map((view) => view.provider !== target.provider || view.family !== target.family ? view : {
        ...view,
        entries: change.kind === "remove" ? view.entries.filter((entry) => entry.id !== change.entryId)
          : change.kind === "enable" ? view.entries.map((entry) => entry.id === change.entryId ? { ...entry, enabled: change.enabled } : entry)
          : change.kind === "trust" ? view.entries.map((entry) => entry.id === change.entryId ? { ...entry, trust: { state: "trusted", detail: "You trusted this hook as it is now." } } : entry)
          : view.entries,
      }) }
      return { plan: preview, backup: `${HOME}/Library/Application Support/mako/backups/native-config/fixture`, view: find(target)! }
    },
  }
}
