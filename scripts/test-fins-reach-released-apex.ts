import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { childGroup, childStateOf, rosterChildren } from "@mako/host/contracts/children"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * An Apex at rest whose harness hibernated is let go of when memory is short, and its Fins go on moving: every move
 * reaches its windows as it happens, through the Apex's own batches, with nothing on screen reading the Apex in for it.
 */

const root = mkdtempSync(join(tmpdir(), "mako-fins-released-apex-"))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function groups(agents: readonly NativeAgent[]): string {
  return agents.map((agent) => childGroup(childStateOf(agent))).join()
}

/** The Apex's Fins' groups as the last of `events` that carried its roster said them. */
function heard(events: readonly HostEvent[], conversation: string): string | undefined {
  let roster: NativeAgentRoster | undefined
  for (const event of events) if (event.type === "live-batch" && event.batch.id === conversation && event.batch.nativeAgents) roster = event.batch.nativeAgents
  return roster && groups(rosterChildren(roster))
}

/**
 * A host short of memory, whose harnesses hibernate as soon as they rest; a Fin's turn holds until `release`. With no
 * room watch (the engine's 10 s poll), only the Fin's own event can carry its start or finish to the Apex: so a wait
 * here proves it went at once without a deadline that a loaded runner misses (#635, a 3 s one beside a disk-heavy suite).
 */
function world(name: string, fins: string[]): AgentsWorld {
  return new AgentsWorld({
    root: join(root, name),
    conversationMemory: { bytes: 0, recent: 0, sweepMs: 20 },
    providerIdleMs: 50,
    noRoomWatch: true,
    script: async (turn) => {
      if (!turn.text.includes("You're fin:")) return "Hello."
      fins.push(turn.conversation)
      await turn.world.hold(turn.conversation)
      return "Indexed."
    },
  })
}

async function apexAtRest(w: AgentsWorld): Promise<string> {
  const apex = await w.apex("claude")
  w.say(apex.conversation, "hi")
  await until("the Apex's turn", () => w.live.session(apex.conversation)?.status === "ready" && w.prompts.some((prompt) => prompt.conversation === apex.conversation))
  return apex.conversation
}

async function startFin(w: AgentsWorld, apex: string, name: string): Promise<void> {
  const answer = await w.agents.start(w.caller(apex), { brief: { objective: `Run ${name}` }, harness: "codex", name, wake: "never", clientKey: name, cwd: w.root })
  assert.ok(answer && !("refused" in answer), JSON.stringify(answer))
}

/** A Fin at work keeps its Apex in memory, past its harness's hibernation and every sweep, so its finish goes out. */
async function workKeepsTheApex(): Promise<void> {
  const fins: string[] = []
  const w = world("work-keeps", fins)
  try {
    const apex = await apexAtRest(w)
    await startFin(w, apex, "index")
    await until("the Fin at work in the Apex's roster", () => fins.length === 1 && heard(w.events, apex) === "working")
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(w.live.loaded(apex), "an Apex whose Fin works stays in memory")
    const from = w.events.length
    w.release(fins[0]!)
    await until("the Fin's finish in the Apex's roster", () => heard(w.events.slice(from), apex) === "done")
  } finally {
    await w.close()
  }
}

/** With every Fin settled the Apex is let go of; a Fin that starts then reads it back in and its start goes out. */
async function aMoveReadsTheApexIn(): Promise<void> {
  const fins: string[] = []
  const w = world("move-reads-in", fins)
  try {
    const apex = await apexAtRest(w)
    await startFin(w, apex, "index")
    await until("the first Fin at work", () => fins.length === 1)
    w.release(fins[0]!)
    await until("the first Fin's finish in its engine", () => groups(w.agents.roster(apex)) === "done")
    await until("the host letting go of the Apex at rest", () => !w.live.loaded(apex))
    const from = w.events.length
    await startFin(w, apex, "lint")
    await until("the second Fin's start in the Apex's roster", () => heard(w.events.slice(from), apex) === "working,done")
    // A start counts as at work before its first turn reaches the harness; its turn is released once it holds.
    await until("the second Fin's turn", () => fins.length === 2)
    w.release(fins[1]!)
    await until("the second Fin's finish in the Apex's roster", () => heard(w.events.slice(from), apex) === "done,done")
  } finally {
    await w.close()
  }
}

try {
  await workKeepsTheApex()
  await aMoveReadsTheApexIn()
  console.log("fins reach a resting apex: a Fin at work keeps its Apex in memory; a Fin that moves reads a released Apex back in; both moves go out at once")
} finally {
  rmSync(root, { recursive: true, force: true })
}
