import assert from "node:assert/strict"
import { removalConfirmation } from "../src/lib/account-removal.ts"

// Nothing uses it: removed at once, as before.
const unused = removalConfirmation("Codex", "work@example.com", "me@example.com", { sessions: [], runs: 0, elsewhere: false })
assert.equal(unused.title, "Remove work@example.com?")
assert.match(unused.body, /deletes its saved credentials from this Mac\. Your other logins/)
assert.equal(unused.subjects, undefined)
assert.equal(unused.note, undefined)

// Only idle sessions: each is named, and each switches with its next message.
const idle = removalConfirmation("Codex", "work@example.com", "me@example.com", {
  sessions: [{ conversation: "a", title: "Tidy the changelog" }],
  runs: 0,
  elsewhere: false,
})
assert.match(idle.body, /The session using it switches to me@example\.com with its next message\./)
assert.deepEqual(idle.subjects, [{ kind: "session", id: "a", name: "Tidy the changelog", detail: "Switches with its next message" }])
assert.equal(idle.note, undefined)

// Busy work: removal waits, nothing stops, and every session says what it waits for.
const busy = removalConfirmation("Claude Code", "work@example.com", "me@example.com", {
  sessions: [
    { conversation: "a", title: "Tidy the changelog" },
    { conversation: "b", title: "Migrate the billing tables", waitingFor: "turn" },
    { conversation: "c", title: "Migrate the billing tables", waitingFor: "approval" },
    { conversation: "d", title: "Long fixture", waitingFor: "close" },
  ],
  runs: 1,
  elsewhere: true,
})
assert.match(busy.body, /deletes its saved credentials from this Mac once nothing uses it\. Nothing is stopped; each session below switches to me@example\.com as shown\./)
assert.deepEqual(busy.subjects?.map((subject) => [subject.id, subject.detail]), [
  ["a", "Switches with its next message"],
  ["b", "Waits for its turn to end"],
  ["c", "Waits for your approval"],
  ["d", "Keeps it until closed"],
])
assert.equal(busy.note, "A run outside these sessions also uses it. Another copy of Mako on this Mac is also using it. Until it's removed, it can't be selected; you can keep it from its row.")
assert.equal(busy.tone, "negative")

// Only a headless run: removal waits, with no session list to point at.
const runOnly = removalConfirmation("Codex", "work@example.com", "me@example.com", { sessions: [], runs: 2, elsewhere: false })
assert.match(runOnly.body, /once nothing uses it\. Nothing is stopped\.$/)
assert.equal(runOnly.subjects, undefined)
assert.equal(runOnly.note, "2 runs use it. Until it's removed, it can't be selected; you can keep it from its row.")

// Long lists show six and count the rest.
const many = removalConfirmation("Codex", "work@example.com", "me@example.com", {
  sessions: Array.from({ length: 9 }, (_, index) => ({ conversation: String(index), title: `Session ${index}`, waitingFor: "turn" as const })),
  runs: 0,
  elsewhere: false,
})
assert.equal(many.subjects?.length, 6)
assert.equal(many.more, 3)
console.log("Account removal confirmation: names every session with what happens to it, says when removal finishes, and stays quiet when nothing uses the account")
