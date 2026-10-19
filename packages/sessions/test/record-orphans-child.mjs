import { createInterface } from "node:readline"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A process for record-orphans.mjs to kill: it captures one session (or
 * repacks) in the store at `folder`, and at the step named stops, says
 * `at <step>` and waits. `--kill` waits for nothing (the parent sends
 * SIGKILL); `--pause` goes on once the parent writes a line. A capture
 * slices at every 40th new chunk, by asking for the store's turn then, so
 * chunks commit before any version names them.
 *
 *   node record-orphans-child.mjs capture <folder> <home> <id> <step> --kill|--pause
 *   node record-orphans-child.mjs repack <folder> <step> [quiet minutes, 0 by default]
 */

const [mode, folder, ...rest] = process.argv.slice(2)
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const say = (text) => process.stdout.write(`${text}\n`)
const stop = async (pause) => {
  if (pause) await lines.next()
  else await new Promise(() => {})
}

if (mode === "capture") {
  const [home, id, at, how] = rest
  let written = 0
  let reached = false
  const store = new RecordStore(folder, new NativeStores(true), {
    step: async (step) => {
      // Every 40th new chunk a turn is asked for: the capture commits what it took at that chunk's slice, then lets it run.
      if (step === "written" && ++written % 40 === 0) void store.restamp("fixture", "nobody", "a", "b")
      if (step !== at || reached) return
      reached = true
      say(`at ${step}`)
      await stop(how === "--pause")
    },
  })
  const report = await store.capture({ harness: "fixture", nativeId: id, home, records: { roots: [{ name: "fixture", path: home }], files: [`${home}/${id}.jsonl`], databases: [] } })
  await store.close()
  say(`done ${JSON.stringify({ newChunks: report.newChunks, taken: report.taken })}`)
} else if (mode === "repack") {
  const [at, quiet = "0"] = rest
  const store = new RecordStore(folder, new NativeStores(true))
  let report = null
  try {
    report = await store.repack({
      quietMs: Number(quiet) * 60_000,
      step: (step) => {
        if (step !== at) return
        say(`at ${step}`)
        // Synchronous, as the repack calls it: this process does nothing more until it's killed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      },
    })
  } finally {
    await store.close()
  }
  say(`done ${JSON.stringify(report)}`)
}
process.exit(0)
