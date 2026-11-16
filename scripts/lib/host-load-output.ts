import assert from "node:assert/strict"
import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"
import type { AppOutputCursor } from "@mako/host/contracts/thread-app"
import type { World } from "./host-load-world.ts"

type Output = World["appOutputs"][number]
type Bridge = Pick<MakoBridge, "threadAppOutput" | "onEvent" | "viewHints" | "followThreadApps">
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** A window's real output reader: current hosts follow hints; an explicitly older host keeps its 500 ms poll. */
export async function followHostLoadOutputs(bridge: Bridge, outputs: readonly Output[], legacy = false) {
  const states = outputs.map(output => ({ output, reads: 0, first: false, followed: 0, marker: "", heard: false }))
  const pending = new Set<Promise<unknown>>()
  const releases: (() => void)[] = []
  let failure: { error: unknown } | undefined
  let closed = false
  let hints = 0
  const off = bridge.onEvent(event => {
    if (event.type === "view-hint" && event.hint.domain === "output" && event.hint.fields.includes("output")) hints++
  })
  const read = async (state: typeof states[number], cursor?: AppOutputCursor) => {
    const work = bridge.threadAppOutput(state.output.cwd, "process:web", cursor)
    pending.add(work)
    try {
      const chunk = await work
      state.reads++
      if (!state.first) {
        assert.ok(chunk.text.length > 0, "the visible output method must return a non-empty initial chunk")
        if (legacy) assert.ok(chunk.text.includes(`host-load web output for ${state.output.app}\n`), "the older output belongs to the seeded owner")
        else assert.equal(chunk.app, state.output.app, "the output method must return the resolved app owner")
        state.first = true
      }
      if (!legacy) assert.equal(chunk.app, state.output.app)
      if (cursor && chunk.text) {
        assert.equal(chunk.reset, false, "an append follows the returned cursor without replay")
        state.followed++
      }
      if (state.marker && chunk.text.includes(state.marker)) state.heard = true
      return chunk
    } catch (error) {
      failure ??= { error }
      throw error
    } finally { pending.delete(work) }
  }
  let following = () => legacy
  try {
    if (legacy) {
      for (const state of states) {
        let cursor: AppOutputCursor | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const next = async () => {
          try { cursor = (await read(state, cursor)).cursor } catch { /* The observed failure is reported by ready/close. */ }
          if (!closed) timer = setTimeout(() => void next(), 500)
        }
        void next()
        releases.push(() => clearTimeout(timer))
      }
    } else {
      // Older source pins predate these modules; only the declared legacy path may omit them.
      const [{ DeskRefetch }, { ViewRefetch }, { appOutputReader }] = await Promise.all([
        import("../../src/state/desk-refetch.ts"), import("../../src/lib/view-refetch.ts"), import("../../src/state/thread-app-output.ts"),
      ])
      const reads = new ViewRefetch()
      const owner = new DeskRefetch(bridge, reads)
      const subscribe = appOutputReader(owner, (cwd, _key, cursor) => {
        const state = states.find(state => state.output.cwd === cwd)
        assert.ok(state)
        return read(state, cursor)
      })
      // Dispose the owner even if a later subscription fails during setup.
      releases.push(() => { owner.close(); reads.dispose() })
      for (const state of states) releases.push(subscribe(state.output.cwd, "process:web", () => {}))
      following = () => states.every(state => owner.outputFollowing(state.output.app))
    }
  } catch (error) {
    closed = true
    for (const release of [...releases].reverse()) release()
    off()
    await Promise.allSettled([...pending])
    throw error
  }
  const until = async (condition: () => boolean, label: string) => {
    for (const deadline = Date.now() + 30_000; !condition(); await wait(20)) {
      if (failure) throw failure.error
      assert.ok(Date.now() < deadline, `host-load output did not ${label} within 30 s`)
    }
    if (failure) throw failure.error
  }
  const close = async () => {
    if (!closed) {
      closed = true
      for (const release of [...releases].reverse()) release()
      off()
    }
    await Promise.allSettled([...pending])
    if (failure) throw failure.error
  }
  return {
    ready: () => until(() => states.every(state => state.first) && following(), "read every owner and establish output following"),
    /** A real append, once, then both its hint and all its cursor chunks must arrive. */
    appended: async (marker: string, write: () => void) => {
      const before = hints
      for (const state of states) { state.marker = marker; state.heard = false }
      write()
      await until(() => states.every(state => state.heard) && (legacy || hints > before), "deliver an append and its hint")
    },
    readings: () => ({ legacy, hints, pending: pending.size, outputs: states.map(state => ({ cwd: state.output.cwd, app: state.output.app, initial: state.first, reads: state.reads, followed: state.followed, heardAppend: state.heard })) }),
    close,
  }
}
