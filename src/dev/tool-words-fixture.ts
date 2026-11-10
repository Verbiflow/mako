// Explicit isolated fixture data for `tool-rows-check.tsx?rows=words`; never imported by the application entry point.
import type { ToolArguments } from "@mako/sessions/tool-identity"
import type { LiveSnapshot } from "@/lib/types"

type Block = LiveSnapshot["blocks"][number]

const json = (args: ToolArguments) => JSON.stringify(args)
const answer = (fields: ToolArguments) => JSON.stringify(fields)
const PULL = "https://github.com/acme/app/pull/374"

/** Every tool of Mako's own `mako` server, settled, as an Apex's turn calls them: its arguments and its answer. */
export const MAKO_CALLS: readonly { tool: string; args: ToolArguments; output: string; failed?: true }[] = [
  { tool: "agents_start", args: { name: "own-words", harness: "codex", brief: { objective: "Make every tool row say what happened." }, clientKey: "k1" }, output: answer({ child: "t1", name: "own-words", conversation: "c1", state: "starting", next: "Its report wakes you." }) },
  { tool: "agents_start", args: { title: "Map the rail's search", brief: { objective: "Map the rail's search path and say where helpers fall out." }, clientKey: "k2" }, output: answer({ child: "t2", name: "rail-search", state: "starting", next: "Its report wakes you." }) },
  { tool: "agents_list", args: {}, output: answer({ children: [{ name: "own-words" }, { name: "rail-search" }, { name: "review" }], tree: { running: 2, started: 3 } }) },
  { tool: "agents_list", args: { scope: "crew" }, output: answer({ you: "own-words", apex: { working: true }, crew: [] }) },
  { tool: "agents_list", args: { scope: "apexes" }, output: answer({ apexes: [] }) },
  { tool: "agents_read", args: { child: "fin:own-words" }, output: answer({ name: "own-words", text: "Done." }) },
  { tool: "agents_read", args: { child: "rail-search", view: "transcript" }, output: answer({ name: "rail-search", text: "…" }) },
  { tool: "agents_send", args: { to: "fin:own-words", forward: true, clientKey: "k3" }, output: answer({ name: "own-words", delivery: "queued", hears: "After its turn." }) },
  { tool: "agents_send", args: { to: "apex:Release notes", text: "Which branch does the release go from?", clientKey: "k4" }, output: answer({ name: "Release notes", delivery: "queued", hears: "After its turn." }) },
  { tool: "agents_answer", args: { to: "fin:own-words", answer: "Squash it", clientKey: "k5" }, output: answer({ name: "own-words", answered: "question" }) },
  { tool: "agents_answer", args: { to: "fin:rail-search", person: true, clientKey: "k6" }, output: answer({ name: "rail-search", answered: "person" }) },
  { tool: "agents_wait", args: { children: ["own-words", "rail-search"] }, output: answer({ reports: [], cursor: 3, timedOut: true }) },
  { tool: "agents_move", args: { child: "own-words", harness: "claude", clientKey: "k5" }, output: answer({ moved: [{ name: "own-words", state: "moved" }] }) },
  { tool: "agents_stop", args: { child: "rail-search", reason: "Covered by own-words" }, output: answer({ stopped: ["rail-search"] }) },
  { tool: "agents_link", args: { session: "6b1e", harness: "claude", name: "review" }, output: answer({ child: "t3", name: "review", origin: "linked" }) },
  { tool: "agents_report", args: { status: "done", summary: "Rows say what happened.", artifacts: [{ kind: "pull-request", ref: PULL }], clientKey: "k7" }, output: answer({ id: "r1", delivered: "notice" }) },
  { tool: "pull_request_open", args: { title: "Make every tool row say what happened" }, output: `Opened #374 into main: ${PULL}` },
  { tool: "pull_request_status", args: {}, output: `branch: mako/tool-words\npullRequest:\n  number: 374\n  url: ${PULL}\n  merge: GitHub would merge it now` },
  { tool: "pull_request_rerun", args: {}, output: "Re-running the failed jobs of 1 GitHub Actions run on the pushed commit. pull_request_status shows them as they go." },
  { tool: "pull_request_merge", args: {}, output: "Merged #374 into main (squash). The branch is kept." },
  { tool: "thread_history", args: { action: "search", query: "exit code" }, output: "hits: []" },
  { tool: "show", args: { files: [{ path: "/fixture/mako/docs/rows-after.png", caption: "The rows after" }] }, output: "Shown to the person in your reply: rows-after.png. Don't embed these again." },
  { tool: "worktree_status", args: {}, output: "editsIn: this Thread's worktree" },
  { tool: "worktree_move", args: {}, output: "moved: true" },
  { tool: "worktree_bring", args: { entries: [{ path: "node_modules" }, { path: ".env.local" }] }, output: "copied:\n  - node_modules\n  - .env.local" },
  { tool: "worktree_update", args: {}, output: "updated: true" },
  { tool: "worktree_merge", args: {}, output: "merged: true" },
  { tool: "worktree_remove", args: {}, output: "removed: true" },
  { tool: "recipe_guide", args: {}, output: "How to write a recipe." },
  { tool: "recipe_save", args: { reason: "Run the API on its own port" }, output: "saved: draft 4" },
  { tool: "recipe_publish", args: { checked: [{ passed: true, how: "Opened the inbox" }] }, output: "published: 4" },
  { tool: "app_status", args: {}, output: "web: running" },
  { tool: "app_start", args: { processes: ["api"] }, output: "api exited with code 1 before it listened on its port.", failed: true },
  { tool: "app_start", args: { processes: ["web"] }, output: "web: running at http://localhost:21100" },
  { tool: "app_restart", args: { target: "desktop" }, output: "desktop: running" },
  { tool: "app_stop", args: {}, output: "stopped: web" },
  { tool: "app_logs", args: { process: "web" }, output: "ready in 412 ms" },
  { tool: "app_check", args: { tier: "quick", steps: ["lint"] }, output: "passed: lint" },
  { tool: "app_probe", args: {}, output: "web: 200" },
  { tool: "app_own_packages", args: {}, output: "owned: 2" },
  { tool: "port_holder", args: { port: 5173 }, output: "free" },
  { tool: "thread_move", args: { to: "cloud", clientKey: "k8" }, output: "moving: true" },
  { tool: "automation", args: { action: "run", id: "nightly-audit", clientKey: "k12" }, output: "done" },
  { tool: "harness", args: { action: "update", harness: "codex", clientKey: "k11" }, output: "started" },
  { tool: "settings", args: { action: "set", setting: "harness-order", value: ["claude", "codex"], clientKey: "k10" }, output: "set" },
  { tool: "thread", args: { action: "rename", title: "Ship the importer", clientKey: "k9" }, output: "renamed" },
]

const CHANGED = "/fixture/mako/src/components/transcript/tool-row.tsx"
const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/lib/tools.ts",
  "@@",
  "-  let failed = 0",
  "+  const fixed = new Set<string>()",
  "+  let failed = 0",
  "*** Update File: src/web-client/steps-words.ts",
  "@@",
  "-  const said = [verb, label, target]",
  "+  const said = [verb, label, target, facts]",
  "*** Add File: src/lib/retries.ts",
  "+export const RETRIES = 1",
  "*** End Patch",
].join("\n")

/** A turn's row facts: a failed command's exit, a read's range, an edit's and a write's size, a patch of several files, and a failure a retry fixed. */
const FACT_CALLS: readonly Block[] = [
  { type: "tool", id: "fact-lint-1", name: "Shell", title: "Shell", input: json({ command: "npm run lint" }), output: "src/lib/tools.ts\n  12:3  error  'fixed' is never reassigned\nexit 1", status: "failed" },
  { type: "tool", id: "fact-read", name: "Read", title: "Read", input: json({ path: CHANGED, offset: 120, limit: 61 }), output: "…", status: "completed" },
  { type: "tool", id: "fact-read-open", name: "Read", title: "Read", input: json({ path: "/fixture/mako/src/lib/tools.ts", offset: 300 }), output: "…", status: "completed" },
  { type: "tool", id: "fact-edit", name: "StrReplace", title: "StrReplace", input: json({ path: "/fixture/mako/src/lib/tools.ts", old_string: "a\nb\nc", new_string: "a\nB\nC\nD" }), output: "ok", status: "completed" },
  { type: "tool", id: "fact-write", name: "Write", title: "Write", input: json({ path: "/fixture/mako/src/lib/retries.ts", contents: Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join("\n") }), output: "ok", status: "completed" },
  { type: "tool", id: "fact-patch", name: "ApplyPatch", title: "ApplyPatch", input: PATCH, output: "ok", status: "completed" },
  { type: "tool", id: "fact-lint-2", name: "Shell", title: "Shell", input: json({ command: "npm run lint" }), output: "", status: "completed" },
  { type: "tool", id: "fact-test", name: "Shell", title: "Shell", input: json({ command: "npm test" }), output: "FAIL scripts/test-tool-identity.ts\nexit 2", status: "failed" },
]

/** The words turn: Mako's tools, then the row facts, then a Mako call still running. */
export function wordsBlocks(requestId: string): Block[] {
  const blocks: Block[] = [
    { type: "user", text: "Start the Fins, open the PR and check the app", requestId },
    ...MAKO_CALLS.map((call, index): Block => ({
      type: "tool",
      id: `mako-${index}`,
      name: `mcp__mako__${call.tool}`,
      title: `mako: ${call.tool}`,
      input: json(call.args),
      output: call.output,
      status: call.failed ? "failed" : "completed",
    })),
    { type: "text", id: "mako-done", text: "Every Fin is started and the PR is open." },
    ...FACT_CALLS,
    { type: "tool", id: "mako-running", name: "mcp__mako__agents_start", title: "mako: agents_start", input: json({ name: "verify", harness: "claude", brief: { objective: "Verify the rows." }, clientKey: "k9" }), status: "running" },
  ]
  return blocks
}
