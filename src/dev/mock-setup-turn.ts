// The fixture desk's setup Thread: one scripted turn that reads the guide,
// looks at the project, saves the recipe and proves it, with the strip's
// "Setting up" menu following each step. `?mock&app=setup`.
import type { LiveUpdate } from "../../electron/contracts/live-content"
import { mockSetupMoment } from "./mock-thread-app"

type Beat = { after: number; updates?: LiveUpdate[]; moment?: Parameters<typeof mockSetupMoment>[0] }

const tool = (id: string, title: string, toolKind: string, input?: string): LiveUpdate => {
  const update: Extract<LiveUpdate, { kind: "tool" }> = { kind: "tool", id, title, toolKind, status: "in_progress" }
  if (input) update.input = input
  return update
}
const done = (id: string, output?: string): LiveUpdate => {
  const update: Extract<LiveUpdate, { kind: "tool-update" }> = { kind: "tool-update", id, status: "completed" }
  if (output) update.output = output
  return update
}
const say = (id: string, text: string): LiveUpdate => ({ kind: "text", id, text })

const FINAL = [
  "mako is set up. Every Thread now runs its own copy of the app, on its own ports and with its own data folder:",
  "",
  "- **Start:** `npm run web`, on the Thread's port",
  "- **Quick check:** typecheck and lint",
  "- **Full check:** `npm run test:dev-live`",
  "",
  "Nothing in the project changed. If your team should get the same setup, I can commit the recipe as `.mako/recipe.json`.",
].join("\n")

const BEATS: Beat[] = [
  { after: 900, updates: [tool("guide", "mcp__mako__recipe_guide", "other")] },
  { after: 700, updates: [done("guide"), tool("status", "mcp__mako__app_status", "other", "{}")] },
  { after: 500, updates: [done("status", "mako has no recipe yet.")] },
  { after: 500, updates: [say("look", "I'll see how mako runs today, then give each Thread its own ports and data.")] },
  { after: 900, updates: [tool("pkg", "Read package.json", "read", '{"path":"package.json"}')] },
  { after: 500, updates: [done("pkg"), tool("start", "Read electron/start.mjs", "read", '{"path":"electron/start.mjs"}')] },
  { after: 600, updates: [done("start"), tool("ports", "Search for fixed ports and data folders", "search", '{"pattern":"5173|listen\\\\(|MAKO_DATA_DIR"}')] },
  { after: 900, updates: [done("ports", "3 matches in 2 files")] },
  {
    after: 600,
    updates: [say("found", "The dev server already reads its port from PORT and its data folder from MAKO_DATA_DIR, so nothing in the project has to change. Saving the recipe.")],
  },
  { after: 1400, updates: [tool("save", "mcp__mako__recipe_save", "other", '{"recipe":{"processes":{"web":{"command":"npm run web","port":"{port}"}},"checks":{"quick":"npm run typecheck && npm run lint","full":"npm run test:dev-live"}}}')], moment: { at: "progress", progress: { recipe: "running" } } },
  { after: 700, updates: [done("save")], moment: { at: "progress", progress: { recipe: "done" } } },
  { after: 500, updates: [tool("run", "mcp__mako__app_start", "other", "{}")], moment: { at: "progress", progress: { app: "running" } } },
  { after: 2600, updates: [done("run", "web is up on this Thread's port")], moment: { at: "progress", progress: { app: "done" } } },
  { after: 500, updates: [tool("curl", "curl -s -o /dev/null -w '%{http_code}' $MAKO_THREAD_URL", "execute", '{"command":"curl -s -o /dev/null -w \'%{http_code}\' $MAKO_THREAD_URL"}')] },
  { after: 600, updates: [done("curl", "200")] },
  { after: 500, updates: [tool("quick", "mcp__mako__app_check", "other", '{"tier":"quick"}')], moment: { at: "progress", progress: { checks: "running" } } },
  { after: 2400, updates: [done("quick", "Passed in 41 s"), tool("full", "mcp__mako__app_check", "other", '{"tier":"full"}')] },
  { after: 3000, updates: [done("full", "Passed in 1 min 12 s")], moment: { at: "progress", progress: { checks: "done" } } },
  { after: 700, updates: [say("final", FINAL)] },
]

/** Play the turn: `push` delivers each beat's updates, and `finish` ends the turn once the app runs. */
export function playSetupTurn(push: (updates: LiveUpdate[]) => void, finish: () => void): void {
  let at = 0
  for (const beat of BEATS) {
    at += beat.after
    setTimeout(() => {
      if (beat.updates) push(beat.updates)
      if (beat.moment) mockSetupMoment(beat.moment)
    }, at)
  }
  setTimeout(() => {
    finish()
    mockSetupMoment({ at: "done" })
  }, at + 600)
}
