import assert from "node:assert/strict"
import type { SessionWriters } from "@mako/sessions/record-writers"
import type { CloudHarnesses } from "@mako/host/contracts/cloud-harnesses"
import type { HarnessUpdates } from "@mako/host/contracts/harness-updates"
import { aheadRefusal, HarnessCheck, weighHarnesses, type HarnessCheckOptions } from "@mako/host/conversations/harness-check"
import type { InstalledRuntime } from "@mako/host/conversations/kept-resume"
import { behindWords } from "@/lib/harness-check"

/**
 * A Thread's harnesses here weighed against what the cloud's machines run (`HarnessCheck`), as production met it:
 * this Mac on Codex 0.159.3, OpenCode 2.0.1, Grok 1.0.46 and Devin.app's 3000.10.23 against a cloud on 0.164.0,
 * 2.1.4, 1.0.70 and 3000.11.205. Going, a Session written here by a newer version than the cloud's is refused; coming
 * back, each harness here older than the cloud's is named with the offer that gets it there: Mako's update when it
 * installs the cloud's version, a newer Mako when this one tested an older one, else the app that owns it.
 */
const cloud: CloudHarnesses = {
  image: "mako-machine-c3918df7b6f3",
  revision: "8ffdb27bb0de296e7fb484a91c9a1c6dcac939c0",
  harnesses: { claude: "2.1.310", codex: "0.164.0", cursor: "1.0.40", devin: "3000.11.205", grok: "1.0.70", opencode: "2.1.4" },
}
const npm = (runtimeId: string) => ({ kind: "update" as const, runtimeId, label: "Update with npm" })
/** This Mac: this Mako tested the cloud's Codex and OpenCode, but an older Grok than the cloud runs. */
const here = new Map<string, InstalledRuntime>([
  ["codex", { version: "0.159.3", offer: npm("codex") }],
  ["opencode", { version: "2.0.1", offer: npm("opencode") }],
  ["grok", { version: "1.0.46", offer: { kind: "update", runtimeId: "grok", label: "Update Grok" } }],
  ["devin", { version: "3000.10.23", offer: { kind: "owner", owner: "Devin" } }],
  ["claude", { version: "2.1.310", offer: { kind: "owner", owner: "Mako" } }],
  ["cursor", { version: null, offer: { kind: "manual" } }],
])
const updates: HarnessUpdates = {
  codex: { versions: { tested: "0.164.0", standing: "supported" } },
  opencode: { versions: { tested: "2.1.4", standing: "supported" } },
  grok: { versions: { tested: "1.0.46", standing: "tested" } },
}
const writers = new Map<string, SessionWriters>([
  ["/codex/new.jsonl", { record: ["0.159.3"], observed: [] }],
  ["/codex/newer.jsonl", { record: ["0.164.0", "0.165.0"], observed: [] }],
  ["/claude/ahead.jsonl", { record: ["2.1.320"], observed: [] }],
])
const options: Pick<HarnessCheckOptions, "writers" | "installed" | "updates"> = {
  writers: (path) => writers.get(path) ?? null,
  installed: (harness) => here.get(harness) ?? { version: null, offer: { kind: "manual" } },
  updates: () => updates,
}

// Production's Thread: a Codex, an OpenCode, a Grok and a Devin Session, written here. Each goes, and each needs this
// Mac's harness newer before it comes back.
{
  const check = weighHarnesses(cloud, [
    { harness: "codex", path: "/codex/new.jsonl" },
    { harness: "opencode", path: "/opencode/s1" },
    { harness: "grok", path: "/grok/s1" },
    { harness: "devin", path: "/devin/s1" },
  ], options)
  assert.equal(check.kind, "known")
  if (check.kind !== "known") throw new Error("unreachable")
  assert.deepEqual(check.ahead, [], "nothing here is newer than the cloud's, so every Session can go")
  assert.deepEqual(check.behind, [
    { harness: "codex", here: "0.159.3", cloud: "0.164.0", offer: npm("codex"), to: "0.164.0" },
    { harness: "opencode", here: "2.0.1", cloud: "2.1.4", offer: npm("opencode"), to: "2.1.4" },
    { harness: "grok", here: "1.0.46", cloud: "1.0.70", offer: { kind: "owner", owner: "Mako" } },
    { harness: "devin", here: "3000.10.23", cloud: "3000.11.205", offer: { kind: "owner", owner: "Devin" } },
  ], "Codex and OpenCode by Mako's update, which installs the cloud's version; Grok only by a newer Mako, since this one tested 1.0.46; Devin by Devin.app")
}

// Going: a Session a newer Codex wrote here than the cloud runs can't resume there, and the refusal says when it can.
{
  const check = weighHarnesses(cloud, [{ harness: "codex", path: "/codex/newer.jsonl" }, { harness: "codex", path: "/codex/new.jsonl" }, { harness: "claude", path: "/claude/ahead.jsonl" }], {
    ...options,
    installed: (harness) => (harness === "codex" ? { version: "0.165.0", offer: npm("codex") } : options.installed(harness)),
  })
  assert.equal(check.kind, "known")
  if (check.kind !== "known") throw new Error("unreachable")
  assert.deepEqual(check.ahead, [{ harness: "codex", wrote: "0.165.0", cloud: "0.164.0" }, { harness: "claude", wrote: "2.1.320", cloud: "2.1.310" }], "one entry per harness, its newest writer: Claude Code's own CLI here wrote past the cloud's bundled build too")
  assert.deepEqual(check.behind, [], "this Mac's Codex is newer than the cloud's, so nothing holds the way back")
  const label = (harness: string) => ({ codex: "Codex", claude: "Claude Code" })[harness] ?? harness
  assert.equal(aheadRefusal(check.ahead.slice(0, 1), label), "The cloud runs Codex 0.164.0, older than the 0.165.0 that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs 0.165.0 or newer.")
  assert.equal(aheadRefusal(check.ahead, label), "The cloud runs Codex 0.164.0 and Claude Code 2.1.310, older than the Codex 0.165.0 and Claude Code 2.1.320 that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs those or newer.")
}

// What blocks nothing: the same version both sides, a version here that can't be read, a harness the cloud doesn't
// name, a Session whose writer nothing names (the arrival weighs that, knowing its install's age), and a Thread in
// the cloud, which has no path here.
{
  const check = weighHarnesses({ ...cloud, harnesses: { ...cloud.harnesses, codex: "0.159.3" } }, [
    { harness: "codex", path: "/codex/new.jsonl" },
    { harness: "cursor", path: "/cursor/s1" },
    { harness: "seventh" },
    { harness: "opencode" },
  ], options)
  assert.deepEqual(check, { kind: "known", image: cloud.image, ahead: [], behind: [{ harness: "opencode", here: "2.0.1", cloud: "2.1.4", offer: npm("opencode"), to: "2.1.4" }] })
}

// Asked once and held: what the cloud runs changes only with its image. A cloud that doesn't say, a Mac signed out
// and a failed read each answer `unknown` with why, so nothing is said ahead; one that failed is asked again soon.
{
  let asked = 0
  let answer: CloudHarnesses | null | Error = cloud
  let signedIn = true
  const check = new HarnessCheck({
    ...options,
    label: (harness) => harness,
    account: () => (signedIn ? { cloudHarnesses: async () => {
      asked += 1
      if (answer instanceof Error) throw answer
      return answer
    } } : undefined),
  })
  const [first, second] = await Promise.all([check.check([{ harness: "codex", path: "/codex/new.jsonl" }]), check.check([{ harness: "codex" }])])
  assert.equal(asked, 1, "two checks at once ask the cloud once")
  assert.equal(first.kind === "known" && first.behind[0]?.harness, "codex")
  assert.deepEqual(second, first)
  await check.check([{ harness: "grok" }])
  assert.equal(asked, 1, "held: a check a moment later asks nothing")
  const refused = await check.check([{ harness: "codex", path: "/codex/newer.jsonl" }])
  assert.equal(refused.kind === "known" && refused.refusal, "The cloud runs codex 0.164.0, older than the 0.165.0 that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs 0.165.0 or newer.", "a check with something ahead carries the words a move refuses with")

  const now = Date.now
  try {
    // Asked again in the background once old: what it said last answers meanwhile, so no move waits on the network.
    const asking = () => new Promise((resolve) => setImmediate(resolve))
    Date.now = () => now() + 11 * 60_000
    answer = null
    assert.equal((await check.check([{ harness: "codex" }])).kind, "known", "what it said last answers at once while it's asked again")
    await asking()
    assert.equal(asked, 2, "asked again once what it said is old")
    assert.deepEqual(await check.check([{ harness: "codex" }]), { kind: "unknown", reason: "The cloud doesn't say which harness versions its machines run." }, "a cloud that doesn't say")
    answer = new Error("The Mako cloud refused that.")
    Date.now = () => now() + 13 * 60_000
    await check.check([{ harness: "codex" }])
    await asking()
    assert.deepEqual(await check.check([{ harness: "codex" }]), { kind: "unknown", reason: "The Mako cloud refused that." })
    answer = cloud
    Date.now = () => now() + 14 * 60_000 + 1
    await check.check([{ harness: "codex" }])
    await asking()
    assert.equal((await check.check([{ harness: "codex" }])).kind, "known", "asked again a minute after it failed")
    assert.equal(asked, 4)
  } finally {
    Date.now = now
  }
  signedIn = false
  const signedOut = new HarnessCheck({ ...options, label: (harness) => harness, account: () => undefined })
  assert.deepEqual(await signedOut.check([{ harness: "codex" }]), { kind: "unknown", reason: "This Mac isn't signed in to Mako Cloud." })
}

// The window's words for what's behind: one harness named with the version its update installs, several listed, and
// what to do for each Mako can't update.
{
  const label = (harness: string) => ({ codex: "Codex", opencode: "OpenCode", devin: "Devin", grok: "Grok" })[harness] ?? harness
  const codex = { harness: "codex", here: "0.159.3", cloud: "0.164.0", offer: npm("codex"), to: "0.164.0" }
  assert.deepEqual(behindWords([codex], label, "move"), {
    title: "Codex here is older than the cloud's",
    detail: "Once it works in the cloud, it comes back only after Codex here is 0.164.0 or newer.",
    rows: [{ harness: "codex", versions: "Codex 0.159.3 here, 0.164.0 in the cloud" }],
    update: "Update Codex to 0.164.0, then move",
    anyway: "Move anyway",
  })
  assert.equal(behindWords([codex], label, "move", true).update, "Update Codex to 0.164.0, then hand off")
  const several = behindWords([
    codex,
    { harness: "opencode", here: "2.0.1", cloud: "2.1.4", offer: npm("opencode"), to: "2.1.4" },
    { harness: "devin", here: "3000.10.23", cloud: "3000.11.205", offer: { kind: "owner", owner: "Devin" } },
    { harness: "grok", here: "1.0.46", cloud: "1.0.70", offer: { kind: "owner", owner: "Mako" } },
    { harness: "seventh", here: "1.0.0", cloud: "1.1.0", offer: { kind: "manual", command: "seventh upgrade" } },
  ], label, "back")
  assert.equal(several.detail, "It comes back once Codex, OpenCode, Devin, Grok and seventh here are as new as the cloud's.")
  assert.equal(several.update, "Update Codex and OpenCode, then bring it back")
  assert.equal(several.anyway, "Bring back anyway")
  assert.deepEqual(several.rows.map((row) => row.todo), [undefined, undefined, "Update it through Devin; Mako checks again when you come back to this window.", "A newer Mako brings Grok 1.0.70: update Mako first.", "Update it from a terminal: seventh upgrade"])
  assert.equal(behindWords([{ harness: "devin", here: "3000.10.23", cloud: "3000.11.205", offer: { kind: "owner", owner: "Devin" } }], label, "back").update, undefined, "nothing for Mako to update: no update choice")
}

console.log("PASS: a Thread's harnesses weighed against the cloud's: a Session written here newer than the cloud's refused before it moves, with when it can; each harness here older than the cloud's named with the offer that reaches it (Mako's update, a newer Mako, or its app); nothing blocked by what's unknown; the cloud asked once and held, and asked again behind what it said last")
