import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { applyPreferenceWrites, laterEdit, type Preferences } from "@mako/protocol/preferences"
import { PreferenceStore, type AccountPreferences } from "@mako/host/harnesses/preferences"
import { FinDefaultsStore } from "@mako/host/harnesses/fin-defaults"
import type { PreferenceValues } from "@mako/host/contracts/preferences"
import type { JsonValue } from "@mako/host/contracts/json"

/**
 * The preferences that follow the account (`PreferenceStore`), against an account that settles writes as the gateway
 * does (`applyPreferenceWrites`): an edit in effect at once and sent, kept while the account can't be reached and sent
 * once; the account's events taken in order and a skipped one read whole; a first sync's offers settled by the newest
 * edit per preference, an offer of unknown time only filling; and the Fin settings read from the account, written to
 * it, mirrored into their file for an older Mako, and an older Mako's edit to that file sent as its edit.
 */

const roots: string[] = []
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "mako-preferences-"))
  roots.push(root)
  return root
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** The account's end, as the gateway keeps it: `reachable` false is a network that's down. */
function account(now = () => Date.now()) {
  let held: Preferences = {}
  let revision = 0
  const writes: Preferences[] = []
  const state = { reachable: true }
  const answer = (): AccountPreferences => ({ account: "ana", preferences: { ...held }, revision })
  return {
    state,
    writes,
    held: () => held,
    revision: () => revision,
    end: {
      read: async () => {
        if (!state.reachable) throw new Error("offline")
        return answer()
      },
      write: async (edits: Preferences) => {
        if (!state.reachable) throw new Error("offline")
        writes.push(edits)
        const applied = applyPreferenceWrites(held, edits, now())
        if (Object.keys(applied.changed).length) {
          held = applied.preferences
          revision += 1
        }
        return answer()
      },
    },
    /** Another device's edit, kept by the account, and the event it sends. */
    elsewhere(name: string, value: JsonValue, at: number) {
      const applied = applyPreferenceWrites(held, { [name]: { value, at, op: `elsewhere-${at}` } }, now())
      held = applied.preferences
      revision += 1
      return { account: "ana", preferences: applied.changed, revision }
    },
  }
}

function store(root: string, cloud: ReturnType<typeof account> | undefined, announced: PreferenceValues[] = []) {
  return new PreferenceStore({ file: join(root, "preferences.json"), account: async () => cloud?.end, announce: (values) => announced.push(values) })
}

test("an edit made later wins; one of unknown time only fills; a device's clock ahead is held to the account's", () => {
  assert.equal(laterEdit({ at: 2, op: "a" }, { at: 1, op: "z" }), true)
  assert.equal(laterEdit({ at: 1, op: "b" }, { at: 1, op: "a" }), true, "the same moment: by ID")
  assert.equal(laterEdit({ at: 0, op: "z" }, { at: 0, op: "a" }), false, "unknown time never replaces one held")
  assert.equal(laterEdit({ at: 0, op: "a" }, undefined), true, "but fills one the account holds nothing for")
  const { preferences, changed } = applyPreferenceWrites({ theme: { value: "dark", at: 100, op: "a" } }, { theme: { value: "light", at: 9_999, op: "b" } }, 200)
  assert.equal(preferences.theme?.at, 200, "a future edit is kept at the account's now")
  assert.deepEqual(Object.keys(changed), ["theme"])
  assert.deepEqual(applyPreferenceWrites(preferences, { theme: { value: "dark", at: 150, op: "c" } }, 300).changed, {}, "an older edit arriving late changes nothing")
})

test("an edit is in effect at once and sent; offline it's kept, and sent once the account can be reached", async () => {
  const cloud = account()
  const root = scratch()
  const announced: PreferenceValues[] = []
  const host = store(root, cloud, announced)
  await host.set("theme", "light")
  assert.equal(host.value("theme"), "light")
  assert.equal(cloud.held().theme?.value, "light")
  assert.equal(announced.at(-1)?.theme, "light")
  cloud.state.reachable = false
  await host.set("fins.ceiling", 12)
  assert.equal(host.value("fins.ceiling"), 12, "in effect while offline")
  assert.equal(cloud.held()["fins.ceiling"], undefined)
  // A host started again reads what it kept: the edit still unsent.
  const again = store(root, cloud)
  assert.equal(again.value("fins.ceiling"), 12)
  cloud.state.reachable = true
  await again.sync()
  assert.equal(cloud.held()["fins.ceiling"]?.value, 12, "sent once it could be")
  const sent = cloud.writes.filter((each) => each["fins.ceiling"]).length
  await again.sync()
  assert.equal(cloud.writes.filter((each) => each["fins.ceiling"]).length, sent, "and not again")
})

test("the account's events are taken in order; a skipped one has them read whole; an older one changes nothing", async () => {
  const cloud = account()
  const host = store(scratch(), cloud)
  await host.sync()
  host.heard(cloud.elsewhere("theme", "dark", Date.now()), false)
  assert.equal(host.value("theme"), "dark")
  // One event the stream never brought: the next is past it, and the whole set is read.
  cloud.elsewhere("harnessOrder", ["codex", "claude"], Date.now())
  const skipped = cloud.elsewhere("theme", "light", Date.now())
  host.heard(skipped, false)
  await host.sync()
  assert.equal(host.value("theme"), "light")
  assert.deepEqual(host.value("harnessOrder"), ["codex", "claude"])
  host.heard({ account: "ana", preferences: { theme: { value: "dark", at: 1, op: "old" } }, revision: 1 }, false)
  assert.equal(host.value("theme"), "light", "an event from before changes nothing")
})

test("a first sync settles each preference by its newest edit: this Mac's older choice yields, its newer one wins", async () => {
  const cloud = account()
  const t = Date.now()
  cloud.elsewhere("theme", "light", t - 1_000)
  cloud.elsewhere("fins.ceiling", 20, t - 50_000)
  const host = store(scratch(), cloud)
  host.offer("theme", "dark", t - 60_000)
  host.offer("fins.ceiling", 8, t - 10_000)
  host.offer("fins.forFins", "Keep PRs small", 0)
  await host.sync()
  assert.equal(host.value("theme"), "light", "chosen elsewhere later: the account's stays")
  assert.equal(host.value("fins.ceiling"), 8, "chosen here later: this Mac's wins")
  assert.equal(host.value("fins.forFins"), "Keep PRs small", "unknown time fills what the account held nothing for")
  host.offer("theme", "dark", Date.now())
  await host.sync()
  assert.equal(host.value("theme"), "light", "each preference is offered once")
})

test("Fin settings follow the account: read from it, written to it, mirrored into their file, and an older Mako's edit there sent", async () => {
  const cloud = account()
  const root = scratch()
  const file = join(root, "fin-defaults.json")
  writeFileSync(file, `${JSON.stringify({ version: 1, chosen: { codex: { model: "gpt-5" } }, used: { claude: { model: "sonnet" } }, policy: { rules: [], forFins: "Small PRs" }, limit: 4, ceiling: 30 })}\n`)
  const old = Date.now() - 3_600_000
  utimesSync(file, old / 1000, old / 1000)
  const preferences = store(root, cloud)
  const fins = new FinDefaultsStore(file, preferences)
  fins.offerFromFile()
  await preferences.sync()
  assert.deepEqual(cloud.held()["fins.chosen"]?.value, { codex: { model: "gpt-5" } }, "the file's choices offered")
  assert.equal(cloud.held()["fins.chosen"]?.at, Math.round(old), "stamped when the file was last edited")
  assert.equal(cloud.held()["fins.ceiling"]?.value, 30)

  // Another device chose a ceiling later: in effect here, and the file mirrors it.
  preferences.heard(cloud.elsewhere("fins.ceiling", 16, Date.now()), false)
  fins.mirror()
  assert.equal(fins.reading().ceiling, 16)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).ceiling, 16, "the file says what's in effect, for an older Mako")
  assert.equal(fins.reading().limit, 4, "this device's own number stays its own")
  assert.equal(cloud.held().limit, undefined)

  // A change here goes to the account, not the file first.
  fins.saveRoleRules("forApexes", "Ask before merging")
  await preferences.sync()
  assert.equal(cloud.held()["fins.forApexes"]?.value, "Ask before merging")
  fins.mirror()
  assert.equal(JSON.parse(readFileSync(file, "utf8")).policy.forApexes, "Ask before merging")

  // An older Mako sharing the file changes the ceiling there: its edit, at the file's time, goes to the account.
  const stored = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, `${JSON.stringify({ ...stored, ceiling: 40 })}\n`)
  const later = Date.now() + 5
  utimesSync(file, later / 1000, later / 1000)
  fins.mirror()
  await preferences.sync()
  assert.equal(cloud.held()["fins.ceiling"]?.value, 40, "taken as the older Mako's edit")
  assert.equal(fins.reading().ceiling, 40)
})

test("two Macs on one account: a change on one is in effect on the other once it hears, and neither writes over the other", async () => {
  const cloud = account()
  const a = store(scratch(), cloud)
  const b = store(scratch(), cloud)
  await Promise.all([a.sync(), b.sync()])
  await a.set("theme", "light")
  const event = { account: "ana", preferences: { theme: cloud.held().theme! }, revision: cloud.revision() }
  b.heard(event, false)
  assert.equal(b.value("theme"), "light")
  await b.set("harnessOrder", ["claude", "codex"])
  await a.sync()
  assert.deepEqual(a.value("harnessOrder"), ["claude", "codex"])
  assert.equal(a.value("theme"), "light")
})
