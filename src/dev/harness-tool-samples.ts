import type { ToolIdentity, ToolSource } from "@mako/sessions/tool-identity"

// Names and argument keys as each harness records them (scripts/audit-native-tools.ts
// over this machine's sessions, 2026-09-30); the values are stand-ins.
export interface Sample {
  source: ToolSource
  expect: Partial<ToolIdentity>
}

const json = JSON.stringify

export const HARNESS_TOOL_SAMPLES: Sample[] = [
  // Claude Code
  { source: { harness: "claude", name: "Bash", input: json({ command: "ls -la", description: "List" }) }, expect: { kind: "shell", label: "Shell", target: "ls -la" } },
  { source: { harness: "claude", name: "Read", input: json({ file_path: "/a/b.ts" }) }, expect: { kind: "read", target: "/a/b.ts" } },
  { source: { harness: "claude", name: "Write", input: json({ file_path: "/a/b.ts", content: "x" }) }, expect: { kind: "write", path: "/a/b.ts" } },
  { source: { harness: "claude", name: "Monitor", input: json({ command: "tail -f log", description: "watch", timeout_ms: 1 }) }, expect: { kind: "shell", target: "tail -f log" } },
  { source: { harness: "claude", name: "Agent", input: json({ description: "Explore code", prompt: "…" }) }, expect: { kind: "agent", target: "Explore code" } },
  { source: { harness: "claude", name: "ToolSearch", input: json({ query: "select:Read" }) }, expect: { kind: "tool-search", target: "select:Read" } },
  { source: { harness: "claude", name: "ExitPlanMode", input: json({ plan: "# Plan" }) }, expect: { kind: "plan-exit" } },
  { source: { harness: "claude", name: "mcp__mako__app_status", input: "{}" }, expect: { kind: "mcp", label: "App status", server: "mako", tool: "app_status" } },
  { source: { harness: "claude", name: "mcp__mako__worktree_status", input: "{}" }, expect: { kind: "mcp", label: "Worktree status", server: "mako", tool: "worktree_status" } },
  { source: { harness: "claude", name: "mcp__mako__workspace_status", input: "{}" }, expect: { kind: "mcp", label: "Worktree status", server: "mako", tool: "workspace_status" } },
  { source: { harness: "claude", name: "mcp__mako__app_probe", input: "{}" }, expect: { kind: "mcp", label: "Probe app", server: "mako", tool: "app_probe" } },
  { source: { harness: "claude", name: "mcp__mako__recipe_guide", input: "{}" }, expect: { kind: "mcp", label: "Recipe guide", server: "mako", tool: "recipe_guide" } },
  { source: { harness: "claude", name: "mcp__deepwiki__ask_wiki_question", input: json({ repoName: "a/b", question: "how?" }) }, expect: { kind: "mcp", label: "deepwiki: ask wiki question", server: "deepwiki", target: "a/b" } },

  // Cursor
  { source: { harness: "cursor", name: "mcp", input: json({ providerIdentifier: "mako", toolName: "app_status", args: {} }) }, expect: { kind: "mcp", label: "App status", server: "mako", tool: "app_status", via: "mcp" } },
  { source: { harness: "cursor", name: "mcp", input: json({ providerIdentifier: "mako", toolName: "app_check", args: { tier: "full" } }) }, expect: { kind: "mcp", label: "Check app", server: "mako", tool: "app_check", target: "full" } },
  { source: { harness: "cursor", name: "mcp", input: json({ providerIdentifier: "mako-computer", toolName: "js", args: { code: "await page.click()", title: "Inspect status" } }) }, expect: { kind: "computer", label: "Computer", target: "Inspect status" } },
  { source: { harness: "cursor", name: "mcp", input: json({ providerIdentifier: "linear", toolName: "get_issue", args: { id: "ENG-1" } }) }, expect: { kind: "mcp", label: "linear: get issue", server: "linear", tool: "get_issue", target: "ENG-1" } },
  { source: { harness: "cursor", name: "mcp", input: json({ providerIdentifier: "mako" }) }, expect: { kind: "mcp", label: "MCP tool", tool: undefined } },
  { source: { harness: "cursor", name: "Shell", input: json({ command: "npm test" }) }, expect: { kind: "shell", target: "npm test" } },
  { source: { harness: "cursor", name: "StrReplace", input: json({ path: "src/a.ts", old_string: "a", new_string: "b" }) }, expect: { kind: "edit", label: "Edit", target: "src/a.ts" } },
  { source: { harness: "cursor", name: "Write", input: json({ path: "src/a.ts", contents: "x" }) }, expect: { kind: "write", target: "src/a.ts" } },
  { source: { harness: "cursor", name: "Glob", input: json({ glob_pattern: "**/*.ts" }) }, expect: { kind: "find", target: "**/*.ts" } },
  { source: { harness: "cursor", name: "AwaitShell", input: json({ shell_id: "7" }) }, expect: { kind: "shell-output", target: "7" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "mako", toolName: "app_start", arguments: { tier: "web" } }) }, expect: { kind: "mcp", label: "Start app", server: "mako", via: "CallDynamicTool", target: "web" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "mako-computer", toolName: "js", arguments: { code: "await page.goto(url)" } }) }, expect: { kind: "computer", label: "Computer", target: "await page.goto(url)" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "cursor", toolName: "Task", arguments: { description: "Find callers" } }) }, expect: { kind: "agent", target: "Find callers", tool: "Task" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "cursor", toolName: "WebSearch", arguments: { search_term: "x", query: "zod json" } }) }, expect: { kind: "web-search", target: "zod json" } },
  { source: { harness: "cursor", name: "GetDynamicTools", input: json({ namespace: "mako" }) }, expect: { kind: "tool-search", target: "mako" } },

  // Grok
  { source: { harness: "grok", name: "run_terminal_command", input: json({ command: "git status", description: "Status", timeout: 1, background: false }) }, expect: { kind: "shell", label: "Shell", target: "git status" } },
  { source: { harness: "grok", name: "read_file", input: json({ target_file: "src/a.ts", limit: 20 }) }, expect: { kind: "read", target: "src/a.ts" } },
  { source: { harness: "grok", name: "search_replace", input: json({ file_path: "src/a.ts", old_string: "a", new_string: "b" }) }, expect: { kind: "edit", target: "src/a.ts" } },
  { source: { harness: "grok", name: "list_dir", input: json({ target_directory: "src" }) }, expect: { kind: "list", target: "src" } },
  { source: { harness: "grok", name: "grep", input: json({ pattern: "TODO", path: "src" }) }, expect: { kind: "search", target: "TODO · src" } },
  { source: { harness: "grok", name: "spawn_subagent", input: json({ description: "Audit tools", prompt: "…", background: true }) }, expect: { kind: "agent", target: "Audit tools" } },
  { source: { harness: "grok", name: "get_command_or_subagent_output", input: json({ task_ids: ["t1"], timeout_ms: 1 }) }, expect: { kind: "shell-output", target: "t1" } },
  { source: { harness: "grok", name: "search_tool", input: json({ query: "app", limit: 5 }) }, expect: { kind: "tool-search", target: "app" } },
  { source: { harness: "grok", name: "use_tool", input: json({ tool_name: "mako__app_start", tool_input: { tier: "web" } }) }, expect: { kind: "mcp", label: "Start app", server: "mako", tool: "app_start", via: "use_tool", target: "web" } },

  // Codex
  { source: { harness: "codex", name: "exec_command", input: json({ cmd: "rg foo" }) }, expect: { kind: "shell", target: "rg foo" } },
  { source: { harness: "codex", name: "exec_command", input: json({ command: "/bin/zsh -lc 'git diff --check; echo '\\''done'\\'''" }) }, expect: { kind: "shell", target: "git diff --check; echo 'done'", command: "git diff --check; echo 'done'" } },
  { source: { harness: "codex", name: "exec_command", input: json({ command: "/bin/zsh -lc \"rg -n 'export|read\\\\(' src\"" }) }, expect: { target: "rg -n 'export|read\\(' src" } },
  { source: { harness: "codex", name: "exec_command", input: json({ command: ["bash", "-lc", "npm test"] }) }, expect: { target: "npm test" } },
  { source: { harness: "codex", name: "exec_command", input: json({ command: "/bin/zsh -lc 'a' && b" }) }, expect: { target: "/bin/zsh -lc 'a' && b" } },
  { source: { harness: "codex", name: "exec", input: "text(await tools.exec_command({cmd:'curl -s localhost:3000', yield_time_ms: 1000}))" }, expect: { kind: "shell", via: "exec", target: "curl -s localhost:3000" } },
  { source: { harness: "codex", name: "exec", input: "text(await tools.mcp__mako__app_status({}))" }, expect: { kind: "mcp", label: "App status", server: "mako", via: "exec" } },
  { source: { harness: "codex", name: "exec", input: "const a = await tools.exec_command({cmd:'ls'})\nconst b = await tools.exec_command({cmd:'pwd'})" }, expect: { kind: "code", label: "Script", target: "exec_command, exec_command" } },
  { source: { harness: "codex", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" }, expect: { kind: "edit", target: "src/a.ts" } },
  { source: { harness: "codex", name: "js", input: json({ code: "await page.click()", title: "Open settings" }) }, expect: { kind: "computer", target: "Open settings" } },
  { source: { harness: "codex", name: "spawn_agent", input: json({ task_name: "review", message: "…", fork_turns: 1 }) }, expect: { kind: "agent", target: "review" } },
  { source: { harness: "codex", name: "followup_task", input: json({ target: "agent-1", message: "go" }) }, expect: { kind: "agent-message", target: "agent-1" } },
  { source: { harness: "codex", name: "request_user_input_async", input: json({ questions: [{ question: "Which port?" }] }) }, expect: { kind: "question", target: "Which port?" } },
  { source: { harness: "codex", name: "sleep", input: json({ duration_ms: 500 }) }, expect: { kind: "wait", target: "0.5s" } },
  { source: { harness: "codex", name: "mako: app_status", input: "{}" }, expect: { kind: "mcp", label: "App status", server: "mako" } },

  // OpenCode
  { source: { harness: "opencode", name: "execute", input: json({ code: "return await tools.mako.app_status();" }) }, expect: { kind: "mcp", label: "App status", server: "mako", via: "execute" } },
  { source: { harness: "opencode", name: "execute", input: json({ code: "return search({namespace:\"mako\",query:\"app\"})" }) }, expect: { kind: "tool-search", target: "app" } },
  { source: { harness: "opencode", name: "patch", input: json({ patchText: "*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch" }) }, expect: { kind: "edit", target: "notes.md" } },
  { source: { harness: "opencode", name: "skill", input: json({ id: "unslop" }) }, expect: { kind: "skill", target: "unslop" } },
  { source: { harness: "opencode", name: "shell", input: json({ command: "ls" }) }, expect: { kind: "shell", target: "ls" } },

  // Devin
  { source: { harness: "devin", name: "exec", input: json({ command: "npm run lint", timeout: 1 }) }, expect: { kind: "shell", target: "npm run lint" } },
  { source: { harness: "devin", name: "run_subagent", input: json({ title: "Check docs", profile: "x", is_background: true, task: "…" }) }, expect: { kind: "agent", target: "Check docs" } },
  { source: { harness: "devin", name: "mako.app_check", input: "{}" }, expect: { kind: "mcp", label: "Check app", server: "mako" } },
  { source: { harness: "devin", name: "write_plan", input: json({ title: "Auth", summary: "s", plan: "p" }) }, expect: { kind: "plan", target: "Auth" } },
  { source: { harness: "devin", name: "get_output", input: json({ shell_id: "s1", timeout: 1 }) }, expect: { kind: "shell-output", target: "s1" } },
  { source: { harness: "devin", name: "kill_shell", input: json({ shell_id: "s1" }) }, expect: { kind: "shell-stop", target: "s1" } },
  { source: { harness: "devin", name: "mcp_list_tools", input: json({ server_name: "mako" }) }, expect: { kind: "tool-search", target: "mako" } },

  // Calls the first audit left unresolved or without a target.
  { source: { harness: "cursor", name: "ApplyPatch", input: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch" }, expect: { kind: "edit", target: "src/b.ts" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "cursor", toolName: "ReadLints", arguments: { paths: ["src/a.ts"] } }) }, expect: { kind: "read", label: "Lints", target: "src/a.ts" } },
  { source: { harness: "cursor", name: "CallDynamicTool", input: json({ namespace: "mako-browser-use", toolName: "mako_browser_screenshot", arguments: { target: "t1" } }) }, expect: { kind: "computer", label: "Computer: screenshot" } },
  { source: { harness: "grok", name: "kill_command_or_subagent", input: json({ task_id: "t2" }) }, expect: { kind: "shell-stop", target: "t2" } },
  { source: { harness: "grok", name: "web_search", input: json({ variant: "v", backend: "b" }) }, expect: { kind: "web-search", target: undefined } },
  { source: { harness: "codex", name: "exec", input: "text(await tools.apply_patch(`*** Begin Patch\n*** Add File: c.md\n+x\n*** End Patch`))" }, expect: { kind: "edit", target: "c.md" } },
  { source: { harness: "codex", name: "exec", input: "text(await tools.write_stdin({session_id: 41, chars: ''}))" }, expect: { kind: "shell-input", target: "41" } },

  // A name nobody declares falls back to ACP's kind, then to a readable label.
  { source: { harness: "grok", name: "frobnicate", acpKind: "execute", input: json({ command: "x" }) }, expect: { kind: "shell", target: "x" } },
  { source: { harness: "grok", name: "frobnicate_widgets" }, expect: { kind: "other", label: "Frobnicate widgets" } },
  { source: { harness: "codex", title: "Run tests", acpKind: "execute" }, expect: { kind: "shell" } },
]
