import assert from "node:assert/strict"
import type { Thread, ThreadPage } from "@mako/sessions"
import type { ProviderBinding } from "@mako/host/contracts/conversation-control"
import { historyDigest, withSeed } from "@mako/host/conversations/native-history"

/**
 * A conversation Mako writes into a harness's own store to start a session
 * there, as a fork or a native carry does: tool calls, a failed one, an
 * event and two turns, which the store keeps as text.
 */
export function seedThread(cwd: string): Thread {
  return {
    ref: { harness: "fixture", nativeId: "seed", path: "/seed", cwd, title: "Seeded" },
    entries: [
      { kind: "user", at: "2026-10-09T10:00:00.000Z", text: "Remember the word first and look for the deploy script." },
      {
        kind: "assistant",
        at: "2026-10-09T10:00:10.000Z",
        blocks: [
          { type: "tool", name: "bash", input: "rg -n deploy scripts/", output: "scripts/deploy.sh:3", error: true },
          { type: "text", text: "Noted first. The deploy script is scripts/deploy.sh." },
        ],
      },
      { kind: "event", at: "2026-10-09T10:01:00.000Z", label: "Model changed", detail: "stand-in" },
      { kind: "user", at: "2026-10-09T10:02:00.000Z", text: "Remember the word second." },
      { kind: "assistant", at: "2026-10-09T10:02:05.000Z", blocks: [{ type: "text", text: "Noted second." }] },
    ],
  }
}

/** How the store reads back before its harness touches it; what `LiveTransfers` records on the binding. */
export function seeded(thread: Thread, read: Thread | null): NonNullable<ProviderBinding["seeded"]> {
  assert.ok(read && read.entries.length > 0, "the seeded store reads back")
  return { native: read.entries.length, entries: thread.entries.length, digest: historyDigest(read.entries) }
}

/**
 * Once the harness resumed the seeded session and answered in it, the store
 * still begins with the seed, so the conversation shows Mako's own record of
 * it, tool calls and all, followed by the turn the harness added.
 */
export function assertSeedHolds(harness: string, thread: Thread, after: Thread | null, seed: NonNullable<ProviderBinding["seeded"]>): void {
  assert.ok(after, `${harness}: the resumed store reads back`)
  assert.ok(after.entries.length > seed.native, `${harness}: the harness added its turn to the seeded session (${after.entries.length} entries, ${seed.native} seeded)`)
  const page: ThreadPage = { ref: after.ref, entries: after.entries, start: 0, total: after.entries.length, hasEarlier: false }
  const shown = withSeed(page, thread.entries, seed)
  assert.ok(shown, `${harness}: the resumed store still begins with the seed as it read before`)
  assert.deepEqual(shown.entries.slice(0, thread.entries.length), thread.entries, `${harness}: the seed shows as Mako wrote it`)
  assert.deepEqual(shown.entries.slice(thread.entries.length), after.entries.slice(seed.native), `${harness}: what the harness added follows it`)
  assert.ok(shown.entries.some((entry) => entry.kind === "assistant" && entry.blocks.some((block) => block.type === "tool" && block.name === "bash")), `${harness}: tool calls show as tool calls`)
}
