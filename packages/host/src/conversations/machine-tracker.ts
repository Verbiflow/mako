import { join } from "node:path"
import type { Git } from "@mako/git"
import type { SavedConversation } from "@mako/protocol/saves"
import type { MoveCheckpoint } from "@mako/protocol/moves"
import type { RecordsLink, SentRecords } from "@mako/sessions/record-sync"
import type { SessionSettings } from "@mako/sessions/settings"
import { LiveActivity } from "../attribution/index.js"
import type { LiveBatch, LiveSummary } from "../contracts/live-conversations.js"
import { HandoffSchema, RuntimeIdSchema, type Handoff } from "../contracts/thread-execution.js"
import type { ThreadId } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"
import { MachineSaves, type MachineSaveLink } from "./machine-saves.js"
import { restoreSave, type MachineRestoreDeps } from "./machine-restore.js"
import type { MoveArrivalDeps } from "./move-arrival.js"
import { sendThreadCarry, type ThreadCarryDeps } from "./move-departure.js"

/**
 * A cloud machine's tracker, put together from the host's parts: the saves (`MachineSaves`), heard from the same
 * reading of live batches attribution makes (`LiveActivity`), and the restore a new machine runs before it speaks
 * (`restoreSave`). Only a cloud machine's host makes one.
 */

export type MachineGateway = { gatewayUrl: string; machine: string; credential: string }

export type MachineTrackerDeps = {
  git: Git
  dataRoot: string
  /** The gateway the machine is linked through now. */
  gateway(): MachineGateway | undefined
  records(gateway: MachineGateway): RecordsLink
  workspace(): string | undefined
  live: {
    summaries(): LiveSummary[]
    activeRequest(id: string): string | null
    continueTurn: MachineRestoreDeps["continueTurn"]
  }
  /** The mode and settings a conversation ran with, as the Thread store's memory keeps them. */
  remembered(harness: string, nativeId: string): { modeId?: string; settings?: SessionSettings } | null | undefined
  store(): TrackerStore | undefined
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  arrival: MoveArrivalDeps
  /** What the rest of the Thread is read from, as a departure reads it: the journal's outside files and file history. */
  carry?: ThreadCarryDeps
}

/** What the tracker reads of the machine's Thread store. */
export type TrackerStore = {
  journalPlacement(conversationId: string): { thread: ThreadId } | undefined
  threadHandoff(thread: ThreadId): Pick<Handoff, "thread" | "sessions">
  readonly self: Handoff["source"]
}

export type MachineTracker = {
  saves: MachineSaves
  /** Every live batch the host emits: its calls and turns ending are when the checkout is saved. */
  observe(batch: LiveBatch): void
  restore(gateway: MachineGateway, generation: number): Promise<{ from: number; ms: number } | undefined>
}

export function saveLink(gateway: MachineGateway, records: RecordsLink): MachineSaveLink {
  return {
    records,
    save: { url: new URL(`/v1/machines/${encodeURIComponent(gateway.machine)}/save`, gateway.gatewayUrl).toString(), authorization: `Bearer ${gateway.credential}` },
  }
}

export function openMachineTracker(deps: MachineTrackerDeps): MachineTracker {
  /** The machine's conversations that have a native session: what a new machine can open again. */
  const started = () => deps.live.summaries().filter((summary) => summary.session.nativeId)
  const saves = new MachineSaves({
    git: deps.git,
    scratch: join(deps.dataRoot, "saves"),
    link: () => {
      const gateway = deps.gateway()
      return gateway && saveLink(gateway, deps.records(gateway))
    },
    workspace: deps.workspace,
    conversations: (turns) => started().map((summary): SavedConversation => {
      const { harness, nativeId, currentMode } = summary.session
      const remembered = deps.remembered(harness, nativeId!)
      const modeId = remembered?.modeId ?? currentMode ?? undefined
      // The request it's answering, only while its turn runs by the turn's own start and end.
      const active = deps.live.activeRequest(summary.session.id)
      const requestId = active !== null && turns.has(active) ? active : undefined
      const call = requestId ? turns.get(requestId) : undefined
      const saved: SavedConversation = { conversationId: summary.session.id, harness, nativeId: nativeId! }
      if (modeId) saved.modeId = modeId
      if (remembered?.settings) saved.tuning = remembered.settings
      if (requestId) {
        saved.turn = { requestId }
        if (call) saved.turn.running = call.slice(0, 200)
      }
      return saved
    }),
    // The rest of the Thread, as its departure would pack it: the carry a new machine lays down beside the checkout.
    ...(deps.carry && {
      carry: async (folder: string, records: RecordsLink, checkpoint: MoveCheckpoint) => {
        const first = started()[0]
        const thread = first && deps.store()?.journalPlacement(first.session.id)?.thread
        return thread && deps.carry ? sendThreadCarry(deps.carry, { folder, thread, checkpoint }, records, "a save") : undefined
      },
    }),
    handoff: () => {
      const store = deps.store()
      const gateway = deps.gateway()
      const first = started()[0]
      const placed = first && store?.journalPlacement(first.session.id)
      if (!store || !gateway || !placed) return undefined
      const { thread, sessions } = store.threadHandoff(placed.thread)
      // As a release would name it, each Session one generation on, without releasing anything: what a new machine's
      // store takes under these IDs, the restore naming the move.
      return HandoffSchema.parse({
        move: namedUuid(`mako save\0${gateway.machine}\0${thread.id}`),
        source: store.self,
        target: { kind: "cloud", runtime: RuntimeIdSchema.parse(namedUuid(`mako machine\0${gateway.machine}`)) },
        releasedAt: Date.now(),
        thread,
        sessions: sessions.map((session) => ({ ...session, generation: session.generation + 1 })),
      })
    },
    flushRecords: async () => {
      const gateway = deps.gateway()
      const paths = started().flatMap((summary) => (summary.session.nativePath ? [summary.session.nativePath] : []))
      if (gateway && paths.length) await deps.sendRecords(deps.records(gateway), paths)
    },
  })
  // Attribution's reading of live batches, its marks heard here: the conversation's id stands for its Session.
  const activity = new LiveActivity({
    tracker: { activity: (mark) => saves.activity(mark), reported: () => undefined },
    placement: (conversationId) => ({ thread: "machine", session: conversationId }),
    session: (conversationId) => {
      const summary = deps.live.summaries().find((each) => each.session.id === conversationId)
      return summary ? { cwd: summary.session.cwd, harness: summary.session.harness } : undefined
    },
    checkout: () => deps.workspace(),
    working: () => undefined,
    now: () => Date.now(),
  })
  /** Conversations heard so far: one opening here is saved at once, so a machine lost before its first call ends loses nothing. */
  const heard = new Set<string>()
  return {
    saves,
    observe: (batch) => {
      activity.observe(batch)
      if (heard.has(batch.id)) return
      heard.add(batch.id)
      saves.changed("a conversation opened")
    },
    async restore(gateway, generation) {
      // Held until it's done; a restore that fails stays held, and the runtime tries it again before it speaks.
      saves.hold()
      const restored = await restoreSave({ arrival: deps.arrival, continueTurn: deps.live.continueTurn }, saveLink(gateway, deps.records(gateway)), gateway.machine, generation)
      if (!restored) {
        saves.released("nothing to restore")
        return undefined
      }
      saves.restoredFrom({ from: restored.from, ms: restored.ms, conversations: restored.conversations })
      return { from: restored.from, ms: restored.ms }
    },
  }
}
