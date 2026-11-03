import assert from "node:assert/strict"
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import { claudeRoutedCall } from "@mako/host/harnesses/claude/routing"
import { NATIVE_OVERRIDE, routeNativeTool, routeShellCall, shellLine, shellWords, type CallThread } from "@mako/host/contracts/native-calls"

const main = "/Users/p/proj"
const worktree = "/Users/p/.mako/worktrees/proj-1/fix-login"
const inMain: CallThread = { folder: main, recipe: { kind: "ready", processes: ["web", "gateway"] }, computer: true }
const inWorktree: CallThread = { folder: worktree, worktree, main, recipe: { kind: "ready", processes: ["web"] }, computer: true }
const noRecipe: CallThread = { folder: worktree, worktree, recipe: { kind: "none" } }

assert.deepEqual(shellWords(`git commit -m "a; b" && echo 'x y'`), ["git", "commit", "-m", "a; b", "&&", "echo", "x y"])
assert.deepEqual(shellWords("npm test 2>&1 | tail"), ["npm", "test", "2>&1", "|", "tail"])
{
  const line = shellLine(`cd mako && FOO=1 nohup npm run dev > /tmp/log 2>&1 &`, main)
  assert.equal(line.segments.length, 1)
  assert.deepEqual(line.segments[0]!.argv.slice(0, 3), ["npm", "run", "dev"])
  assert.equal(line.segments[0]!.cwd, `${main}/mako`)
  assert.equal(line.segments[0]!.background, true)
  assert.deepEqual(line.segments[0]!.env, { FOO: "1" })
}
assert.equal(shellLine(`bash -lc 'git worktree add ../x'`, main).segments[0]!.argv[1], "worktree")
assert.equal(shellLine(`while ! curl -s localhost:3000; do sleep 2; done`, main).loop, true)

type Case = { name: string; thread: CallThread; command: string; cwd?: string; route: "allow" | "warn" | "deny"; rule?: string }
const CASES: Case[] = [
  // worktrees and branches
  { name: "a worktree by hand in the main checkout", thread: inMain, command: "git worktree add ../proj-feature -b feature", cwd: main, route: "deny", rule: "git-worktree-add" },
  { name: "a worktree by hand from inside a Thread's worktree", thread: inWorktree, command: "git -C /Users/p/proj worktree add /tmp/w", cwd: worktree, route: "deny", rule: "git-worktree-add" },
  { name: "a worktree in a scratch repository elsewhere", thread: inMain, command: "cd /tmp/fixture && git worktree add ../w", cwd: main, route: "allow" },
  { name: "listing worktrees", thread: inMain, command: "git worktree list", cwd: main, route: "allow" },
  { name: "a new branch in the main checkout", thread: inMain, command: "git checkout -b fix/login", cwd: main, route: "deny", rule: "git-new-branch-in-checkout" },
  { name: "git switch -c in the main checkout", thread: inMain, command: "git switch -c fix/login", cwd: main, route: "deny", rule: "git-new-branch-in-checkout" },
  { name: "switching the main checkout's branch", thread: inMain, command: "git switch release", cwd: main, route: "deny", rule: "git-switch-in-checkout" },
  { name: "a new branch in the Thread's worktree", thread: inWorktree, command: "git checkout -b other", cwd: worktree, route: "warn", rule: "git-new-branch-in-worktree" },
  { name: "restoring a file", thread: inMain, command: "git checkout -- src/a.ts", cwd: main, route: "allow" },
  { name: "updating from main by hand", thread: inWorktree, command: "git fetch origin && git rebase origin/main", cwd: worktree, route: "warn", rule: "git-update-from-main" },
  { name: "commit and push", thread: inWorktree, command: "git add -A && git commit -m 'x' && git push -u origin HEAD", cwd: worktree, route: "allow" },
  // pull requests
  { name: "gh pr create", thread: inWorktree, command: `gh pr create --title "Fix" --body "$(cat body.md)"`, cwd: worktree, route: "deny", rule: "gh-pr-create" },
  { name: "gh pr create with -R", thread: inWorktree, command: "gh -R Verbiflow/mako pr create --fill", cwd: worktree, route: "deny", rule: "gh-pr-create" },
  { name: "gh pr merge", thread: inWorktree, command: "gh pr merge 297 --squash", cwd: worktree, route: "deny", rule: "gh-pr-merge" },
  { name: "gh pr checks", thread: inWorktree, command: "gh pr checks", cwd: worktree, route: "warn", rule: "gh-pr-status" },
  { name: "gh pr checks --watch", thread: inWorktree, command: "gh pr checks --watch --interval 30", cwd: worktree, route: "warn", rule: "gh-watch" },
  { name: "a failed run's log", thread: inWorktree, command: "gh run view 123 --log-failed | tail -50", cwd: worktree, route: "warn", rule: "gh-pr-status" },
  { name: "reading an issue", thread: inWorktree, command: "gh issue view 12", cwd: worktree, route: "allow" },
  { name: "a PR in a repository elsewhere", thread: inWorktree, command: "cd /tmp/other && gh pr create --fill", cwd: worktree, route: "allow" },
  // the app
  { name: "npm run dev with a recipe", thread: inWorktree, command: "npm run dev", cwd: worktree, route: "deny", rule: "dev-server" },
  { name: "nohup'd vite with a recipe", thread: inMain, command: "nohup npx vite --port 5173 > /tmp/vite.log 2>&1 &", cwd: main, route: "deny", rule: "dev-server" },
  { name: "wrangler dev in a subfolder", thread: inMain, command: "cd mako-backend/apps/gateway && npx wrangler dev --port 8787", cwd: main, route: "deny", rule: "dev-server" },
  { name: "electron with a recipe", thread: inWorktree, command: "npx electron .", cwd: worktree, route: "deny", rule: "dev-server" },
  { name: "a dev server without a recipe", thread: noRecipe, command: "pnpm dev", cwd: worktree, route: "warn", rule: "dev-server-no-recipe" },
  { name: "a build", thread: inWorktree, command: "npm run build && npx vite build", cwd: worktree, route: "allow" },
  { name: "tests", thread: inWorktree, command: "npm test -- --run", cwd: worktree, route: "allow" },
  { name: "the escape hatch", thread: inWorktree, command: `${NATIVE_OVERRIDE} npm run dev`, cwd: worktree, route: "allow" },
  { name: "a dev server in another project", thread: inWorktree, command: "cd /Users/p/other && npm run dev", cwd: worktree, route: "allow" },
  // ports
  { name: "who holds a port", thread: inMain, command: "lsof -i :3000", cwd: main, route: "warn", rule: "lsof-port" },
  { name: "killing a port's holder", thread: inMain, command: "kill -9 $(lsof -ti :3000)", cwd: main, route: "warn", rule: "lsof-port" },
  { name: "pkill by pattern", thread: inMain, command: "pkill -f vite", cwd: main, route: "warn", rule: "kill-by-pattern" },
  // agent CLIs
  { name: "claude -p", thread: inMain, command: `claude -p "review this diff" --output-format json`, cwd: main, route: "deny", rule: "agent-cli-claude" },
  { name: "codex exec in the background", thread: inMain, command: `nohup codex exec --full-auto "port the handlers" > /tmp/c.log 2>&1 &`, cwd: main, route: "deny", rule: "agent-cli-codex" },
  { name: "cursor-agent -p", thread: inMain, command: `cursor-agent -p "write tests"`, cwd: main, route: "deny", rule: "agent-cli-cursor-agent" },
  { name: "opencode run", thread: inMain, command: `opencode run "fix lint"`, cwd: main, route: "deny", rule: "agent-cli-opencode" },
  { name: "claude --version", thread: inMain, command: "claude --version", cwd: main, route: "allow" },
  { name: "codex login status", thread: inMain, command: "codex login status", cwd: main, route: "allow" },
  { name: "mako agents report", thread: inMain, command: "mako agents report --text done", cwd: main, route: "allow" },
  // browser and computer
  { name: "a screenshot", thread: inMain, command: "screencapture -x /tmp/s.png", cwd: main, route: "deny", rule: "screencapture" },
  { name: "System Events keystrokes", thread: inMain, command: `osascript -e 'tell application "System Events" to keystroke "a"'`, cwd: main, route: "deny", rule: "osascript-ui" },
  { name: "opening a page", thread: inMain, command: "open http://localhost:20540", cwd: main, route: "warn", rule: "open-browser" },
  { name: "opening a file in Finder", thread: inMain, command: "open .", cwd: main, route: "allow" },
  { name: "a screenshot without Mako's computer server", thread: noRecipe, command: "screencapture -x /tmp/s.png", cwd: worktree, route: "allow" },
  { name: "playwright tests", thread: inMain, command: "npx playwright test", cwd: main, route: "allow" },
  // background and polling
  { name: "a background script", thread: inMain, command: "nohup node scripts/long.js > /tmp/l.log 2>&1 &", cwd: main, route: "warn", rule: "background" },
  { name: "a sleep loop on CI", thread: inWorktree, command: "until gh pr checks | grep -q pass; do sleep 30; done", cwd: worktree, route: "warn", rule: "sleep-loop" },
  { name: "a sleep loop on a pid", thread: inMain, command: "while kill -0 1234 2>/dev/null; do sleep 10; done; echo done", cwd: main, route: "warn", rule: "sleep-loop" },
  { name: "a long sleep", thread: inMain, command: "sleep 300 && tail -5 /tmp/log", cwd: main, route: "warn", rule: "long-sleep" },
  { name: "a short sleep", thread: inMain, command: "sleep 2 && curl -s localhost:20540", cwd: main, route: "allow" },
  { name: "a deny wins over a warn on the same line", thread: inWorktree, command: "gh pr checks; gh pr merge --squash", cwd: worktree, route: "deny", rule: "gh-pr-merge" },
]

for (const entry of CASES) {
  const route = routeShellCall(entry.thread, { command: entry.command, cwd: entry.cwd })
  assert.equal(route.kind, entry.route, `${entry.name}: ${entry.command}`)
  if (route.kind !== "allow") {
    assert.equal(route.rule, entry.rule, `${entry.name}: rule`)
    assert.doesNotMatch(route.message, /\n/, `${entry.name}: one line`)
  }
  if (route.kind === "deny") assert.ok(route.message.includes(NATIVE_OVERRIDE), `${entry.name}: a deny names the override`)
}

// Messages name Mako's tools as the harness calls them.
{
  const route = routeShellCall(inWorktree, { command: "gh pr create --fill", cwd: worktree }, (tool) => `mcp__mako__${tool}`)
  assert.ok(route.kind === "deny" && route.message.includes("mcp__mako__pull_request_open"))
}

// The harness's own tools.
assert.equal(routeNativeTool(inMain, { tool: "EnterWorktree" }).kind, "deny")
assert.equal(routeNativeTool(inMain, { tool: "mcp__claude-in-chrome__navigate", server: "claude-in-chrome" }).kind, "deny")
assert.equal(routeNativeTool(noRecipe, { tool: "mcp__claude-in-chrome__navigate", server: "claude-in-chrome" }).kind, "allow", "without Mako's computer server the person's browser tools stay")
assert.equal(routeNativeTool(inMain, { tool: "mcp__linear__save_issue", server: "linear" }).kind, "allow")

// Claude's PreToolUse: a deny carries the message, a warn rides on an allowed call as context, and a spawn still goes to spawn routing.
{
  const Answer = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.string().optional(), permissionDecisionReason: z.string().optional(), additionalContext: z.string().optional() }) })
  const answer = (tool: string, input: JsonObject) => {
    const hook: PreToolUseHookInput = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "u", session_id: "s", transcript_path: "/t", cwd: worktree }
    const routed = claudeRoutedCall({ calls: () => inWorktree, teams: false, conversation: "c" }, hook)
    return routed && Answer.parse(routed).hookSpecificOutput
  }
  const denied = answer("Bash", { command: "gh pr create --fill" })
  assert.equal(denied?.permissionDecision, "deny")
  assert.match(denied?.permissionDecisionReason ?? "", /mcp__mako__pull_request_open/)
  const warned = answer("Bash", { command: "gh pr checks" })
  assert.equal(warned?.permissionDecision, undefined, "a warn leaves the approval as it was")
  assert.match(warned?.additionalContext ?? "", /mcp__mako__pull_request_status/)
  assert.equal(answer("Bash", { command: "npm test" }), undefined)
  assert.equal(answer("EnterWorktree", { name: "x" })?.permissionDecision, "deny")
  assert.equal(answer("mcp__claude-in-chrome__navigate", { url: "x" })?.permissionDecision, "deny")
  assert.equal(answer("mcp__mako__worktree_move", {}), undefined, "Mako's own tools go ahead")
  assert.equal(answer("Agent", { subagent_type: "general-purpose" }), undefined, "without spawn routing a spawn is the harness's own")
}

console.log(`native calls: ${CASES.length} shell cases and the native tools pass`)
