import assert from "node:assert/strict"
import { test } from "node:test"
import { LiveThreads } from "../packages/host/src/conversations/live-threads.js"
import { CLOUD_FOLDER_WHERE } from "../packages/host/src/contracts/listed-conversations.js"

// Where a conversation runs, as every window is told it: from the Thread store's execution of its Session, so the
// composer, the rail and the header read one place, whichever summary of it reached the window.
const SESSION_HERE = "3f1d2c4b-0000-4000-8000-000000000001"
const SESSION_CLOUD = "3f1d2c4b-0000-4000-8000-000000000002"
const SESSION_DEVICE = "3f1d2c4b-0000-4000-8000-000000000003"

function threads(failing = false) {
  const placements = new Map([
    ["here", { thread: "t-here", session: SESSION_HERE }],
    ["cloud", { thread: "t-cloud", session: SESSION_CLOUD }],
    ["device", { thread: "t-device", session: SESSION_DEVICE }],
  ])
  const executions = new Map<string, unknown>([
    [SESSION_HERE, { state: "here", generation: 1 }],
    [SESSION_CLOUD, { state: "elsewhere", owner: { kind: "cloud", runtime: "0115921a-8150-803d-86e0-4354e02b98e1" }, generation: 3 }],
    [SESSION_DEVICE, { state: "elsewhere", owner: { kind: "device", runtime: "d-other" }, generation: 2 }],
  ])
  let reads = 0
  return {
    get reads() {
      return reads
    },
    store: {
      journalPlacement: (id: string) => placements.get(id),
      executionsOf: (sessions: Iterable<string>) => {
        if (failing) throw new Error("the store is locked")
        reads += 1
        return new Map([...sessions].flatMap((session) => (executions.has(session) ? [[session, executions.get(session)]] : [])))
      },
    },
  }
}

test("a conversation whose Session a cloud Thread executes is said to run there; this Mac's and an unknown one aren't", () => {
  const fake = threads()
  // SAFETY: LiveThreads reads only journalPlacement and executionsOf of the store here.
  const live = new LiveThreads({ threads: fake.store as never, emit: () => {} })
  const away = live.runningElsewhere(["here", "cloud", "device", "unplaced"])
  assert.deepEqual([...away], [["cloud", CLOUD_FOLDER_WHERE]])
  assert.equal(fake.reads, 1, "every conversation's execution is read in one query")
  assert.deepEqual([...live.runningElsewhere([])], [])
})

test("a store that can't be read serves every conversation as this computer's, and says so once", () => {
  // SAFETY: as above.
  const live = new LiveThreads({ threads: threads(true).store as never, emit: () => {} })
  assert.deepEqual([...live.runningElsewhere(["cloud"])], [])
  assert.deepEqual([...live.runningElsewhere(["cloud"])], [])
})
