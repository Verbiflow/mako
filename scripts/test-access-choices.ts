// The person's access choice per harness: the account owns them, a host keeps the
// last it heard and what it couldn't send yet, a window's old copy is handed over
// once without overriding the account, and an older word never replaces a newer.
//
//   npx tsx scripts/test-access-choices.ts
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { applyAccessChoosing, type AccessChoices as AccountChoices } from "@mako/protocol/access-choices"
import { AccessChoiceStore, type AccessChoicesAccount } from "@mako/host/harnesses/access-choices"
import type { AccessChoices } from "@mako/host/contracts/access-choices"
import type { LiveSessionMode } from "@mako/host/contracts/providers-acp"

const LADDERS = new Map<string, LiveSessionMode[]>([
  ["claude", [{ id: "default", name: "Default", access: "ask" }, { id: "acceptEdits", name: "Accept edits", access: "edits" }, { id: "bypassPermissions", name: "Bypass", access: "full" }]],
  ["codex", [{ id: "access:ask", name: "Ask", access: "ask" }, { id: "access:full", name: "Full", access: "full" }]],
  ["cursor", [{ id: "full-access", name: "Full access", access: "full" }]],
])
/** What the host keeps in its file, as far as these checks read it. */
const KeptSchema = z.object({ unsent: z.object({}).loose(), offered: z.object({}).loose(), revision: z.number(), account: z.string() })

/** An account as the gateway keeps it: one set of choices, its revision raised by each change. */
class FakeAccount implements AccessChoicesAccount {
  choices: AccountChoices = {}
  revision = 0
  reachable = true
  writes: Array<{ choices: AccessChoices; fill: boolean }> = []
  constructor(readonly id: string) {}
  async read() {
    if (!this.reachable) throw new Error("offline")
    return { account: this.id, choices: this.choices, revision: this.revision }
  }
  async write(choices: AccessChoices, fill: boolean) {
    if (!this.reachable) throw new Error("offline")
    this.writes.push({ choices, fill })
    const next = applyAccessChoosing(this.choices, { choices, fill })
    if (JSON.stringify(next) !== JSON.stringify(this.choices)) {
      this.choices = next
      this.revision += 1
    }
    return { account: this.id, choices: this.choices, revision: this.revision }
  }
}

const root = await mkdtemp(join(tmpdir(), "mako-access-choices-"))
try {
  const file = join(root, "access-choices.json")
  let account: FakeAccount | undefined
  const announced: AccessChoices[] = []
  const open = () => new AccessChoiceStore({ file, modes: (harness) => LADDERS.get(harness), account: async () => account, announce: (choices) => announced.push(choices) })
  const store = open()

  // Signed out: a choice is this Mac's alone, in effect at once, with its tier, and kept to send.
  assert.deepEqual(await store.choose("claude", "bypassPermissions"), { claude: { mode: "bypassPermissions", access: "full" } })
  assert.equal(store.mode("claude"), "bypassPermissions")
  assert.equal(announced.length, 1)
  await assert.rejects(store.choose("claude", "yolo"), /offers no mode yolo/)

  // A window's own copy from before is handed over: taken only where nothing is chosen.
  await store.adopt({ claude: "default", codex: "access:full" })
  assert.deepEqual(store.current(), { claude: { mode: "bypassPermissions", access: "full" }, codex: { mode: "access:full", access: "full" } })

  // Signing in to an account that already has a choice for codex: what this Mac chose replaces the account's, what it
  // only kept from before doesn't.
  account = new FakeAccount("account-a")
  account.choices = { codex: { mode: "access:ask", access: "ask" } }
  account.revision = 4
  await store.sync()
  assert.deepEqual(account.choices, { codex: { mode: "access:ask", access: "ask" }, claude: { mode: "bypassPermissions", access: "full" } })
  assert.deepEqual(store.current(), account.choices)
  assert.deepEqual(account.writes.map((write) => write.fill), [true, false], "the old copy offered, then the choice made here")
  const stored = KeptSchema.parse(JSON.parse(await readFile(file, "utf8")))
  assert.deepEqual([stored.unsent, stored.offered, stored.revision, stored.account], [{}, {}, 5, "account-a"])

  // Another device changed it: the account's event is what's kept, and every window hears it.
  const before = announced.length
  store.heard({ account: "account-a", choices: { ...account.choices, cursor: { mode: "full-access", access: "full" } }, revision: 7 })
  assert.equal(store.mode("cursor"), "full-access")
  assert.equal(announced.length, before + 1)
  // An older word, heard late, changes nothing.
  store.heard({ account: "account-a", choices: {}, revision: 5 })
  assert.equal(store.mode("cursor"), "full-access")
  // A mode the harness no longer offers starts nothing; a harness without a choice starts in its own default.
  store.heard({ account: "account-a", choices: { claude: { mode: "planless" } }, revision: 8 })
  assert.equal(store.mode("claude"), undefined)
  assert.equal(store.mode("codex"), undefined)
  // A tier this build doesn't know is left out, the mode kept.
  store.heard({ account: "account-a", choices: { claude: { mode: "bypassPermissions", access: "unheard-of" } }, revision: 9 })
  assert.deepEqual(store.current(), { claude: { mode: "bypassPermissions" } })

  // Offline: the choice is in effect here at once and kept unsent, laid over the account's word until it's taken.
  account.choices = { claude: { mode: "bypassPermissions", access: "full" } }
  account.revision = 9
  account.reachable = false
  await store.choose("codex", "access:full")
  assert.equal(store.mode("codex"), "access:full")
  store.heard({ account: "account-a", choices: { claude: { mode: "default", access: "ask" } }, revision: 10 })
  assert.deepEqual(store.current(), { claude: { mode: "default", access: "ask" }, codex: { mode: "access:full", access: "full" } })
  account.reachable = true
  await store.sync()
  assert.equal(account.choices.codex?.mode, "access:full")
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).unsent, {})

  // Choosing what the account already says sends nothing.
  const writes = account.writes.length
  await store.choose("codex", "access:full")
  assert.equal(account.writes.length, writes)

  // Another host of this user (a profile) reads what this one wrote, and a file it can't read is no choice at all.
  assert.equal(open().mode("codex"), "access:full")
  await writeFile(file, "{ not json")
  const unreadable = open()
  assert.deepEqual(unreadable.current(), {})

  // Another account's revisions are its own: signing in to it takes its choices, however low its revision.
  account = new FakeAccount("account-b")
  account.choices = { cursor: { mode: "full-access", access: "full" } }
  account.revision = 1
  await store.sync()
  assert.deepEqual(store.current(), { cursor: { mode: "full-access", access: "full" } })
  console.log("access choices: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
