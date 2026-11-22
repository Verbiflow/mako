import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { HostJobs } from "@mako/host/base/host-jobs"
import { followHostLog, type HostLogFields } from "@mako/host/base/host-log"
import { openAttribution } from "@mako/host/attribution/index"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { sharedJournalFolder } from "@mako/host/attribution/shared-journal"
import { removeScratch } from "./lib/remove-scratch.mjs"

/*
 * The journal's writing owner runs in a worker so the host's thread never waits on SQLite; the owner must not wait on
 * the host's thread either. On 2026-11-18 the person's host held its loop 1.6-2 s of every 2 s for two hours, and the
 * owner's flushes waited on it: a one-file write took 1.6-2 s (the host's context, asked before the write), a 4-file
 * flush's stats 4.4 s (Git's ignore listing and `check-ignore`, run through the host). Here the host's thread is held
 * the same way while a new file, an edit of a committed one and an index move are journaled, and each flush's own
 * time (stats, reads, write) stays far under the hold.
 */

const HOLD_MS = 1_500
const HOLDS = 4

/** Hold this thread as the person's host was held: `HOLD_MS` busy, then a moment for its loop. */
async function holdTheHost(): Promise<void> {
  for (let hold = 0; hold < HOLDS; hold++) {
    const end = performance.now() + HOLD_MS
    while (performance.now() < end) { /* the host's thread held */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("the writing owner journals while the host's thread is held, without waiting on it", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-held-")))
  const repo = join(folder, "repo")
  mkdirSync(join(repo, "src"), { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(repo, ".gitignore"), "build/\n*.log\n")
  for (let index = 0; index < 20; index++) writeFileSync(join(repo, "src", `file-${index}.ts`), `export const value${index} = ${index}\n`.repeat(40))
  git("add", ".")
  git("commit", "-q", "-m", "base")
  const listeners = new Map<string, (paths: string[]) => void>()
  const lines: { message: string; fields: HostLogFields }[] = []
  const unfollow = followHostLog((line) => { if (line.scope === "attribution" || line.scope === "git") lines.push({ message: line.message, fields: line.fields ?? {} }) })
  const owner = await openAttribution({
    dataRoot: join(folder, "data"), userRoot: join(folder, "user"), label: "held-host", git: new Git(), jobs: new HostJobs(),
    watch: (root, changed) => { listeners.set(root, changed); return { ready: Promise.resolve(), close() {} } },
    stores: () => [], placement: () => undefined, session: () => undefined,
    // The host's catalog and its running sessions: what the owner reads to tell another app's changes from a Thread's.
    catalogued: () => [], running: () => ({}),
  })
  try {
    assert.equal(owner.failure(), undefined)
    await owner.track(repo)
    await owner.settled()
    const changed = listeners.get(repo)
    assert.ok(changed, "the owner watches the checkout through the host")
    // A first change, so whatever the owner holds of the host is held before the host is.
    writeFileSync(join(repo, "src", "file-0.ts"), "export const first = 1\n")
    changed(["src/file-0.ts"])
    await owner.settled()
    const before = lines.length
    // An index move (`git add` of another file), a new file, and edits of committed files, all heard before the hold.
    writeFileSync(join(repo, "src", "staged.ts"), "export const staged = 1\n")
    git("add", "src/staged.ts")
    changed([".git/index"])
    // Past the 2 s the owner once kept the host's context for, so a flush now would have asked for it again.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    writeFileSync(join(repo, "src", "new.ts"), "export const fresh = 1\n")
    for (let index = 1; index < 6; index++) writeFileSync(join(repo, "src", `file-${index}.ts`), `export const edited${index} = ${index}\n`)
    changed(["src/new.ts", ...[1, 2, 3, 4, 5].map((index) => `src/file-${index}.ts`)])
    await holdTheHost()
    await owner.settled()
    const flushes = lines.slice(before).filter((line) => line.message === "slow flush" && Number(line.fields.entries) > 0)
    const own = flushes.map((line) => Number(line.fields.statMs) + Number(line.fields.hashMs) + Number(line.fields.diffMs) + Number(line.fields.writeMs))
    console.log(`flushes with entries while the host was held: ${flushes.map((line) => `stat ${line.fields.statMs} hash ${line.fields.hashMs} diff ${line.fields.diffMs} write ${line.fields.writeMs} lag ${line.fields.lagMs}`).join("; ") || "none slow"}`)
    const slowAsks = lines.slice(before).filter((line) => line.message === "the host was slow to answer the writing owner")
    console.log(`slow host asks: ${slowAsks.map((line) => String(line.fields.asks)).join("; ") || "none"}`)
    for (const ms of own) assert.ok(ms < HOLD_MS / 3, `a flush's own work took ${Math.round(ms)} ms while the host's thread was held ${HOLD_MS} ms at a time`)
    const store = JournalStore.open(join(sharedJournalFolder(join(folder, "user")), "journal.sqlite"), { device: "held-host-reader", readOnly: true })
    try {
      const journaled = store.entries(0, 1000)
      for (const path of ["src/new.ts", "src/file-1.ts", "src/file-5.ts"]) assert.ok(journaled.some((entry) => entry.path === path), `${path} journaled`)
    } finally { store.close() }
  } finally {
    unfollow()
    await owner.close()
    removeScratch(folder)
  }
})
