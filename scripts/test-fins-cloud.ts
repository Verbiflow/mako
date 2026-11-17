// A Fin placed in the cloud, on one host with the account and the cloud Thread's host stood in for: the gate that
// keeps `place: cloud` refused as it ships, and, opened, a start reserved, made into its cloud Thread on its own
// machine and placed there with its committed source, each step under the start's one op, through lost answers, a
// refusal, an uncommitted folder and a stop. No network, provider, account or machine is used.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Json } from "@mako/protocol"
import { type CloudFinAnswer, type CloudFinPlace, type CloudFinPlaced, type CloudFinReservation, type CloudFinStart, cloudFinThread } from "@mako/protocol/cloud-fins"
import { ORCHESTRATION_VERSION } from "@mako/host/contracts/agents"
import type { AgentsStartResult } from "@mako/host/contracts/agent-tools"
import type { PlaceLink } from "@mako/host/conversations/agent-places"
import type { CloudFins } from "@mako/host/conversations/agents"
import { sealFinSource } from "@mako/host/conversations/fin-source"
import { processHostConfig } from "@mako/host/host-config"
import { AgentsWorld } from "./lib/agents-world"

const REMOTE = "https://github.com/acme/app"
const SOURCE = sealFinSource({ version: 1, repository: { url: REMOTE, branch: "main" }, commit: "a".repeat(40), cwd: "." })
const FOLDER = "/home/user/app"
const STATUS = { at: 1, day: "2026-11-17", planSandboxes: 2, sandboxCentsPerHour: 120, runningSandboxes: 0, dailySpendCents: 10_000, spentTodayCents: 0, reservedTodayCents: 0 }

/** The account's refusals a case asks for, by step. */
type Refusals = { reserve?: Extract<CloudFinAnswer, { ok: false }>["reason"] }

/** The account, as the cloud start asks it: what each call was, and how it answers, losing an answer on demand. */
function account() {
  const calls: string[] = []
  const reservations = new Map<string, CloudFinReservation>()
  const lose = new Set<"reserve" | "start" | "cancel">()
  /** Steps whose every answer is lost, as an account that never gets one back to this device. */
  const always = new Set<"reserve" | "start" | "cancel">()
  const refuse: Refusals = {}
  const answer = (op: string): CloudFinAnswer => ({ ok: true, reservation: reservations.get(op)!, limits: STATUS })
  const lost = (step: "reserve" | "start" | "cancel") => {
    if (!lose.delete(step) && !always.has(step)) return
    throw new Error(`the account's answer to ${step} was lost`)
  }
  const fins: CloudFins = {
    harnesses: async () => ["codex", "claude"],
    capture: async () => SOURCE,
    reserve: async (start: CloudFinStart) => {
      calls.push(`reserve ${start.op} ${start.inputSha256.slice(0, 8)} ${start.thread}`)
      if (refuse.reserve) return { ok: false, reason: refuse.reserve, limits: STATUS }
      const kept = reservations.get(start.op)
      if (kept && (kept.inputSha256 !== start.inputSha256 || kept.thread !== start.thread)) return { ok: false, reason: "conflict", limits: STATUS }
      if (!kept) reservations.set(start.op, { ...start, by: randomUUID(), at: 1, phase: "reserved", cancel: false, generation: 0, planRevision: 1, leaseUntil: 3_600_001, retireUntil: 3_900_001, reservedCents: 120 })
      lost("reserve")
      return answer(start.op)
    },
    start: async (place: CloudFinPlace): Promise<CloudFinPlaced> => {
      calls.push(`start ${place.op} ${place.repository.url} ${place.harness}`)
      const kept = reservations.get(place.op)
      if (!kept || kept.cancel) return { ok: false, reason: kept ? "cancelled" : "missing", detail: "no reservation to make" }
      reservations.set(place.op, { ...kept, phase: "running", generation: 1 })
      lost("start")
      return { ok: true, thread: place.thread, machine: "m-0123456789abcdef", folder: FOLDER, reservation: reservations.get(place.op)! }
    },
    cancel: async (start: CloudFinStart) => {
      calls.push(`cancel ${start.op}`)
      const kept = reservations.get(start.op)
      if (kept) reservations.set(start.op, { ...kept, cancel: true, phase: kept.phase === "reserved" ? "cancelled" : "retiring" })
      lost("cancel")
      return kept ? answer(start.op) : { ok: false, reason: "missing", limits: STATUS }
    },
  }
  return { fins, calls, reservations, lose, always, refuse }
}

/** The cloud Thread's host, as the Apex's link reaches it: it offers committed sources and starts the Fin it's given. */
function cloudHost(calls: string[]): PlaceLink {
  return {
    self: async () => "00000000-0000-4000-8000-0000000000aa",
    devices: async () => [],
    call: async (target, channel, args): Promise<Json> => {
      assert.equal(target.kind, "cloud", "everything of a cloud start goes to its cloud Thread")
      calls.push(`${channel} ${target.kind === "cloud" ? target.thread : ""}`)
      if (channel === "mako:agents-capabilities") return { orchestration: { version: ORCHESTRATION_VERSION }, slots: { used: 0, of: 1 }, harnesses: ["codex", "claude"], committedSource: 1 }
      if (channel === "mako:agents-place") {
        // SAFETY: `mako:agents-place` carries one AgentsPlaceInput, which the sender parsed against its contract before the call.
        const input = args[0] as { name: string; harness: string; workspace: { folder?: string; remote?: string; source?: { sha256: string } } }
        assert.deepEqual([input.workspace.folder, input.workspace.remote, input.workspace.source?.sha256], [FOLDER, undefined, SOURCE.sha256], "it works in its machine's clone, at its committed source")
        return { child: randomUUID(), name: input.name, harness: input.harness, access: "auto", state: "working", sourceSha256: SOURCE.sha256 }
      }
      if (channel === "mako:agents-cancel") return { cancelled: true }
      throw new Error(`unexpected ${channel}`)
    },
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-fins-cloud-")))
const started = (answer: AgentsStartResult) => {
  assert.ok(!("refused" in answer), `refused: ${"refused" in answer ? answer.why : ""}`)
  return answer
}
const refused = (answer: AgentsStartResult) => {
  assert.ok("refused" in answer, "expected a refusal")
  return answer
}
const START = { brief: { objective: "Fix the parser." }, harness: "codex", name: "parser", place: "cloud", clientKey: "k1" }

async function world(name: string, fins?: CloudFins, link: string[] = []) {
  return new AgentsWorld({ root: join(root, name), script: () => "Noted.", noRoomWatch: true, away: cloudHost(link), remoteOf: async () => REMOTE, ...(fins && { cloudFins: fins }) })
}

try {
  // Only a proof's host opens them: MAKO_CLOUD_FIN_PROOF on a host sharing the person's ~/.mako is refused outright.
  {
    const socket = join(root, "host.sock")
    // A production host's environment, so the configuration reads no development build (none exists before CI builds one).
    const shared = processHostConfig({ HOME: root, MAKO_PROD: "1", MAKO_WEB_SOCKET: socket, MAKO_PROFILE: "dev", MAKO_CLOUD_FIN_PROOF: "open" })
    assert.ok("refused" in shared && shared.code === 78, "a profile shares the person's ~/.mako: refused")
    const proof = processHostConfig({ HOME: root, MAKO_PROD: "1", MAKO_WEB_SOCKET: socket, MAKO_DATA_ROOT: join(root, "proof-host"), MAKO_CLOUD_FIN_PROOF: "open" })
    assert.ok(!("refused" in proof) && proof.environment.isolated && proof.cloudFinProof, "an isolated host opens them when asked")
    const unasked = processHostConfig({ HOME: root, MAKO_PROD: "1", MAKO_WEB_SOCKET: socket, MAKO_DATA_ROOT: join(root, "proof-host") })
    assert.ok(!("refused" in unasked) && !unasked.cloudFinProof, "and only when asked")
    console.log("proof gate: only an isolated host asked by MAKO_CLOUD_FIN_PROOF opens cloud Fins")
  }

  // Closed, as it ships: refused exactly as before, nothing asked of the account.
  {
    const host = await world("closed")
    try {
      const apex = await host.apex("claude")
      const answer = refused(await host.agents.start(apex.caller, { ...START, cwd: host.root }))
      assert.deepEqual([answer.refused, answer.why], ["place-unavailable", "A Fin can't be placed in the cloud yet: name one of the person's devices with device:<name>, or leave place out to start it here."])
      assert.equal(host.store.queuedSpawns().length, 0)
      console.log("closed: place: cloud is refused as it ships, and nothing is recorded or sent")
    } finally {
      await host.close()
    }
  }

  // Opened: reserved, made into its cloud Thread on its machine, then placed there, all under one op, digest and Thread.
  {
    const cloud = account()
    const link: string[] = []
    const host = await world("open", cloud.fins, link)
    try {
      const apex = await host.apex("claude")
      const answer = started(await host.agents.start(apex.caller, { ...START, cwd: host.root }))
      assert.equal(answer.state, "working")
      const op = `start:${apex.caller.kind === "agent" ? apex.caller.session : ""}:k1`
      const thread = await cloudFinThread(op)
      assert.deepEqual(cloud.calls.map((call) => call.split(" ")[0]), ["reserve", "start"], "reserved, then made")
      assert.ok(cloud.calls[0]!.endsWith(thread), "under the op's own cloud Thread")
      assert.deepEqual(link, [`mako:agents-capabilities ${thread}`, `mako:agents-place ${thread}`], "then placed there, checked first for committed sources")
      const edge = host.store.edges().all.find((each) => each.placed)
      assert.deepEqual(edge?.placed?.target, { kind: "cloud", thread })
      assert.equal(host.store.queuedSpawns().length, 0, "its row went once its Apex had its record")
      console.log("open: a cloud start is reserved, made into its own cloud Thread and machine, and placed there with its committed source")
    } finally {
      await host.close()
    }
  }

  // A lost answer at each account step: the start is asked again under the same op and digest, never twice reserved.
  for (const step of ["reserve", "start"] as const) {
    const cloud = account()
    const host = await world(`lost-${step}`, cloud.fins)
    try {
      const apex = await host.apex("claude")
      cloud.lose.add(step)
      const first = started(await host.agents.start(apex.caller, { ...START, cwd: host.root }))
      assert.equal(first.state, "queued", "whether it was made isn't known: its row stays")
      assert.equal(host.store.queuedSpawns().length, 1)
      const again = started(await host.agents.start(apex.caller, { ...START, cwd: host.root }))
      assert.ok(again.state === "working" || again.state === "queued")
      // A place freeing drains what waits: the row is asked again under its op.
      host.agents.capacityChanged()
      for (let turn = 0; turn < 200 && !host.store.edges().all.some((each) => each.placed); turn++) await new Promise((resolve) => setTimeout(resolve, 10))
      const reserves = cloud.calls.filter((call) => call.startsWith("reserve "))
      assert.equal(new Set(reserves).size, 1, "every reserve was the same start: one op, one digest, one Thread")
      assert.equal(cloud.reservations.size, 1, "and the account holds one reservation")
      assert.ok(host.store.edges().all.some((each) => each.placed), "and it was placed once the answers came")
      console.log(`lost ${step} answer: asked again under the same op and digest, one reservation, then placed`)
    } finally {
      await host.close()
    }
  }

  // The account's refusal reads as its reason; an uncommitted folder is refused before anything leaves.
  {
    const cloud = account()
    cloud.refuse.reserve = "slots"
    const host = await world("refused", cloud.fins)
    try {
      const apex = await host.apex("claude")
      const full = refused(await host.agents.start(apex.caller, { ...START, cwd: host.root }))
      assert.equal(full.refused, "budget")
      assert.match(full.why, /plan runs as many cloud machines at once/)
      const uncommitted = account()
      uncommitted.fins.capture = async () => { throw new Error("the folder has uncommitted changes") }
      const other = await world("uncommitted", uncommitted.fins)
      try {
        const apex2 = await other.apex("claude")
        const answer = refused(await other.agents.start(apex2.caller, { ...START, cwd: other.root }))
        assert.equal(answer.refused, "place-unavailable")
        assert.match(answer.why, /committed, pushed source.*uncommitted changes/)
        assert.deepEqual(uncommitted.calls, [], "nothing asked of the account")
        assert.equal(other.store.queuedSpawns().length, 0)
      } finally {
        await other.close()
      }
      console.log("refusals: a full plan reads as budget with the account's reason; an uncommitted folder is refused before anything leaves")
    } finally {
      await host.close()
    }
  }

  // A stop before the start was made: the account's cancel settles it, and nothing is placed.
  {
    const cloud = account()
    const link: string[] = []
    const host = await world("stop-unmade", cloud.fins, link)
    try {
      const apex = await host.apex("claude")
      // The account reserves it each time, and its answer never comes back.
      cloud.always.add("reserve")
      assert.equal(started(await host.agents.start(apex.caller, { ...START, cwd: host.root })).state, "queued")
      const op = [...cloud.reservations.keys()][0]!
      assert.deepEqual(await host.agents.stop(apex.caller, { child: "parser", reason: "not needed" }), { stopped: ["parser"] })
      assert.ok(cloud.calls.includes(`cancel ${op}`), "the account was told: a reservation may exist though its answer never came")
      assert.equal(cloud.reservations.get(op)?.phase, "cancelled", "never made: its reservation is closed")
      assert.equal(host.store.queuedSpawns().length, 0, "and its row is settled")
      assert.deepEqual(link, [], "nothing was asked of a cloud Thread that was never made")
      console.log("stop, never made: a cloud start whose reservation's answer was lost is cancelled by the account, and nothing is placed")
    } finally {
      await host.close()
    }
  }

  // A stop of a start made into its cloud Thread whose answer never came: the account retires it, and its Thread is told.
  {
    const cloud = account()
    const link: string[] = []
    const host = await world("stop-made", cloud.fins, link)
    try {
      const apex = await host.apex("claude")
      cloud.always.add("start")
      assert.equal(started(await host.agents.start(apex.caller, { ...START, cwd: host.root })).state, "queued")
      const op = [...cloud.reservations.keys()][0]!
      assert.equal(cloud.reservations.get(op)?.phase, "running", "made, though its answer was lost")
      assert.deepEqual(await host.agents.stop(apex.caller, { child: "parser", reason: "not needed" }), { stopped: ["parser"] })
      assert.equal(cloud.reservations.get(op)?.phase, "retiring", "the account retires its machine: never called stopped by a clock")
      assert.ok(link.some((call) => call.startsWith("mako:agents-cancel")), "and its cloud Thread is told, so a start that reaches it after won't run")
      assert.ok(!link.some((call) => call.startsWith("mako:agents-place")), "nothing was placed")
      assert.equal(host.store.queuedSpawns().length, 0)
      console.log("stop, made: a cloud start made into its machine is retired by the account and stopped at its cloud Thread")
    } finally {
      await host.close()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("cloud Fins: all passed")
