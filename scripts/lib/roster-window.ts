import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { setImmediate as turn } from "node:timers/promises"
import { mock } from "node:test"
import type { HeardLiveBatch, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { NativeAgentRoster } from "@mako/host/contracts/native-agents"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import { watchDoor, watchReads } from "../live-door-watch.ts"

/** A window of its own: each process loads the actual renderer and owns its own store, reads and admission guards. */
export type WindowCommand =
  | { kind: "init"; snapshot: LiveSnapshot; listed?: boolean }
  | { kind: "batch"; batch: HeardLiveBatch }
  | { kind: "list"; summary: LiveSummary }
  | { kind: "unlist" }
  | { kind: "open" }
  | { kind: "read" }
  | { kind: "unload" }
  | { kind: "reply"; read: number; snapshot?: LiveSnapshot | null; fail?: boolean }
  | { kind: "inspect" }

export interface WindowState {
  held?: { revision: number; epoch?: string; hydrated: boolean; roster?: NativeAgentRoster }
  drawn: string
  reads: { number: number; conversation: string }[]
}

export function rosterWindow() {
  const child = fork(import.meta.filename, ["--window"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.app.json" } })
  let errors = ""
  child.stderr?.on("data", (text: Buffer) => { errors = (errors + text.toString()).slice(-8000) })
  return {
    ask(command: WindowCommand): Promise<WindowState> {
      return new Promise((resolve, reject) => {
        const end = (code: number | null) => reject(new Error(`roster window exited ${code}: ${errors}`))
        const timer = setTimeout(() => reject(new Error(`roster window did not answer ${command.kind}: ${errors}`)), 10_000)
        child.once("exit", end)
        child.once("message", (state: WindowState) => {
          clearTimeout(timer)
          child.removeListener("exit", end)
          resolve(state)
        })
        child.send(command)
      })
    },
    close() { child.kill() },
  }
}

async function runWindow(): Promise<void> {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
  Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
  const { installMockBridge } = await import("../../src/dev/mock-bridge")
  installMockBridge()
  const { getMako } = await import("../../src/lib/bridge")
  const { acpStore } = await import("../../src/state/acp-state")
  const { receivingLive, readingLive } = await import("../../src/state/live-door")
  const { applyLiveBatch, applyLiveSnapshot, hydrateLive, readBackLive, listLive, unlistLive, unloadLive } = await import("../../src/state/live-recovery")
  const { AudioFeedback } = await import("../../src/lib/audio-feedback")
  mock.method(AudioFeedback.prototype, "play", async () => {})
  mock.method(Date, "now", () => 1_800_000_000_000)
  const { selectAcpPresence } = await import("../../src/state/acp-presence")
  const { threadChildren } = await import("../../src/state/apex-fins")
  const { inboxModel } = await import("../../src/state/inbox")
  const { notificationsStore } = await import("../../src/state/notifications")
  mock.method(console, "warn", () => {})
  const bridge = getMako()
  const reader = new LiveHistoryReader()
  let id = "", serial = 0
  const reads = new Map<number, { conversation: string; answer: (snapshot: LiveSnapshot | null) => void; fail: () => void }>()
  mock.method(bridge, "liveRead", (conversation: string, input: LiveHistoryRead) => {
    if (input.kind !== "snapshot") return reader.read(conversation, input, async () => null)
    const number = ++serial
    return new Promise<LiveSnapshot | null>((answer, reject) => reads.set(number, { conversation, answer, fail: () => reject(new Error("fixture read failed")) }))
      .then((snapshot) => reader.read(conversation, input, async () => snapshot))
  })
  const door = watchDoor(acpStore, receivingLive)
  const reading = watchReads(bridge, readingLive)
  const settle = async () => { for (let at = 0; at < 8; at += 1) await turn() }
  process.on("message", async (command: WindowCommand) => {
    try {
      switch (command.kind) {
        case "init":
          id = command.snapshot.session.id
          acpStore.set({ activeKey: null })
          applyLiveSnapshot(command.snapshot)
          if (command.listed) unloadLive(id)
          break
        case "batch": applyLiveBatch(command.batch); break
        case "list": listLive([command.summary]); break
        case "unlist": acpStore.set({ activeKey: null }); unlistLive([id]); break
        case "open": acpStore.set({ activeKey: id }); void hydrateLive(id); break
        case "read": void readBackLive(id); break
        case "unload": acpStore.set({ activeKey: null }); unloadLive(id); break
        case "reply": {
          const read = reads.get(command.read)
          assert.ok(read, `read ${command.read} is still out`)
          reads.delete(command.read)
          if (command.fail) read.fail()
          else read.answer(command.snapshot ?? null)
          break
        }
        case "inspect": break
      }
      await settle()
      assert.deepEqual(door.strays, [], "every roster write went through receiveLive")
      assert.deepEqual(reading.bypasses, [], "every snapshot read went through readLive's record")
      const held = acpStore.get().conversations[id]
      process.send?.({
        ...(held?.kind === "live" && { held: { revision: held.revision ?? 0, ...(held.epoch && { epoch: held.epoch }), hydrated: Boolean(held.hydrated), ...(held.nativeAgents && { roster: held.nativeAgents }) } }),
        drawn: JSON.stringify({ presence: selectAcpPresence(acpStore.get()), children: held?.threadId ? threadChildren(acpStore.get(), held.threadId) : [], inbox: inboxModel(), notifications: notificationsStore.get().items }),
        reads: [...reads].map(([number, read]) => ({ number, conversation: read.conversation })),
      } satisfies WindowState)
    } catch (error) {
      console.error(error)
      process.exit(1)
    }
  })
}

if (process.argv.includes("--window")) await runWindow()
