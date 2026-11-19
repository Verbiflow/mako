import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import type { WorktreeSummariesHeld, WorktreeSummary } from "@mako/host/contracts/thread-worktrees"
import { applyWorktreeSummaries, applyWorktreeSummaryChanges, refreshWorktreeSummaries, worktreeSummariesReading, worktreeSummariesStore } from "../src/state/worktrees"

/**
 * The window's side of the worktree summaries: the host's answer comes at once with what it holds and what it's still
 * reading; each change after it (`worktree-summary-changes`) gives a new object to the summaries it names and to no
 * other, so only the rows that show them draw again; and a host that says the whole list still works.
 * `npx tsx --tsconfig tsconfig.app.json scripts/test-worktree-summary-changes.ts`
 */

const summary = (path: string, changes: number): WorktreeSummary => ({ path, into: "main", ahead: 1, changes, landing: { kind: "open", into: "main", commits: 1 }, pull: null, behind: { from: "origin/main", commits: 2 } })
const paths = Array.from({ length: 107 }, (_, n) => `/worktrees/project/thread-${n}`)

test("a changed summary gives its own row a new object and no other", () => {
  applyWorktreeSummaries(paths.map((path) => summary(path, 0)))
  const before = worktreeSummariesStore.get().byPath
  let said = 0
  const stop = worktreeSummariesStore.subscribe(() => {
    said += 1
  })
  try {
    applyWorktreeSummaryChanges({ changed: [summary(paths[5]!, 0)], removed: [] })
    assert.equal(said, 0, "a summary said again as it was sets nothing")
    assert.equal(worktreeSummariesStore.get().byPath, before)
    applyWorktreeSummaryChanges({ changed: [summary(paths[5]!, 3)], removed: [] })
    const after = worktreeSummariesStore.get().byPath
    assert.equal(said, 1, "one change is one set of the store")
    assert.equal(after[paths[5]!]?.changes, 3)
    // A row selects its own path's summary, and draws again only when that object is another.
    assert.deepEqual(paths.filter((path) => after[path] !== before[path]), [paths[5]], "106 rows keep the object they had")
    applyWorktreeSummaryChanges({ changed: [], removed: [paths[6]!, "/never/held"] })
    assert.equal(said, 2)
    assert.equal(paths[6]! in worktreeSummariesStore.get().byPath, false, "a worktree gone leaves the record")
    assert.equal(Object.keys(worktreeSummariesStore.get().byPath).length, 106)
    applyWorktreeSummaryChanges({ changed: [], removed: ["/never/held"] })
    assert.equal(said, 2, "one never held changes nothing")
    applyWorktreeSummaryChanges({ changed: [summary("/worktrees/project/new", 1)], removed: [] })
    assert.equal(worktreeSummariesStore.get().byPath["/worktrees/project/new"]?.changes, 1, "a worktree first read joins it")
  } finally {
    stop()
  }
})

test("the answer comes with what's still being read, and each change clears its own mark", async () => {
  const held: WorktreeSummariesHeld = { summaries: [summary(paths[0]!, 0), summary(paths[1]!, 2)], reading: [paths[1]!, paths[2]!] }
  Object.assign(globalThis, { window: { mako: { worktreeSummaries: async () => held } } })
  try {
    await refreshWorktreeSummaries()
    assert.deepEqual(Object.keys(worktreeSummariesStore.get().byPath), [paths[0], paths[1]], "what the host holds is shown at once")
    assert.deepEqual(Object.keys(worktreeSummariesReading.get().byPath), [paths[1], paths[2]])
    applyWorktreeSummaryChanges({ changed: [summary(paths[2]!, 1)], removed: [] })
    assert.deepEqual(Object.keys(worktreeSummariesReading.get().byPath), [paths[1]], "one read is no longer being read")
    assert.equal(worktreeSummariesStore.get().byPath[paths[2]!]?.changes, 1)
    // One held from before and found as it was is said too, which ends its mark and changes no row.
    const before = worktreeSummariesStore.get().byPath
    applyWorktreeSummaryChanges({ changed: [summary(paths[1]!, 2)], removed: [] })
    assert.deepEqual(worktreeSummariesReading.get().byPath, {})
    assert.equal(worktreeSummariesStore.get().byPath, before)
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})

test("a host that answers the list alone and says the whole list on a change still works", async () => {
  Object.assign(globalThis, { window: { mako: { worktreeSummaries: async () => [summary(paths[0]!, 0), summary(paths[1]!, 0)] } } })
  try {
    await refreshWorktreeSummaries()
    assert.deepEqual(Object.keys(worktreeSummariesStore.get().byPath), [paths[0], paths[1]])
    assert.deepEqual(worktreeSummariesReading.get().byPath, {}, "its answer is read to its end, so nothing is marked")
    const before = worktreeSummariesStore.get().byPath
    applyWorktreeSummaries([summary(paths[0]!, 0), summary(paths[1]!, 5)])
    const after = worktreeSummariesStore.get().byPath
    assert.equal(after[paths[0]!], before[paths[0]!], "the whole list keeps an unchanged summary's object")
    assert.equal(after[paths[1]!]?.changes, 5)
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})

test("coming back to the window asks saying so, and an ask behind one that's out carries it", async () => {
  const asked: (string | undefined)[] = []
  const answers: (() => void)[] = []
  Object.assign(globalThis, { window: { mako: { worktreeSummaries: (why?: "focus") => {
    asked.push(why)
    return new Promise<WorktreeSummariesHeld>((resolve) => answers.push(() => resolve({ summaries: [], reading: [] })))
  } } } })
  try {
    const first = refreshWorktreeSummaries()
    const behind = refreshWorktreeSummaries("focus")
    assert.deepEqual(asked, [undefined], "one ask is out, as the rail asks")
    answers[0]!()
    await first
    await Promise.resolve()
    assert.deepEqual(asked, [undefined, "focus"], "the ask behind it says the window came to the front")
    answers[1]!()
    await behind
    const alone = refreshWorktreeSummaries("focus")
    assert.deepEqual(asked, [undefined, "focus", "focus"])
    answers[2]!()
    await alone
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})

/** A host's argument schema for a call that takes none, as a host from before the `changes` form has for this one. */
const NoArguments = z.tuple([])

test("the bridge asks a host once how it takes the call: an older one's refusal of the argument is learnt, any other refusal stands", async () => {
  const over = (invoke: (channel: string, args: readonly string[]) => Promise<WorktreeSummary[] | WorktreeSummariesHeld>) => {
    const seen: string[][] = []
    const bridge = createMakoBridge({
      invoke: async <Result,>(channel: string, ...args: unknown[]) => {
        const words = args.map(String)
        seen.push([channel, ...words])
        // SAFETY: the fake answers this one channel with the shapes the bridge names for it.
        return await invoke(channel, words) as Result
      },
      onEvent: () => () => {}, onTerminalEvent: () => () => {},
      pathForFile: () => null, resolveFileUrl: (url) => url,
    })
    return { bridge, seen }
  }
  // A host that takes the form: one call each time.
  const current = over(async () => ({ summaries: [], reading: [] }))
  await current.bridge.worktreeSummaries()
  await current.bridge.worktreeSummaries("focus")
  assert.deepEqual(current.seen, [["mako:worktree-summaries", "changes"], ["mako:worktree-summaries", "changes", "focus"]])
  // A host from before it refuses the argument, as its schema words it: asked again the plain way once, then plainly.
  const older = over(async (_channel, args) => {
    NoArguments.parse(args)
    return [summary(paths[0]!, 0)]
  })
  assert.deepEqual(await older.bridge.worktreeSummaries(), [summary(paths[0]!, 0)])
  assert.equal(older.seen.length, 2, "the first ask learns it")
  await older.bridge.worktreeSummaries("focus")
  await older.bridge.worktreeSummaries()
  assert.deepEqual(older.seen.slice(2), [["mako:worktree-summaries"], ["mako:worktree-summaries"]], "and every ask after is one call, with no argument")
  // A call refused for another reason (the gateway keeps it to this Mac's own windows) is refused once, not asked twice.
  const refused = over(async () => {
    throw new Error("Only this Mac's own windows make this call")
  })
  await assert.rejects(refused.bridge.worktreeSummaries(), /own windows/)
  await assert.rejects(refused.bridge.worktreeSummaries(), /own windows/)
  assert.equal(refused.seen.length, 2, "one call an ask")
})
