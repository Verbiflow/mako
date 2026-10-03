import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import * as before from "../electron/app-probe-main.tmp.js"
import { beginTrace, probeApp } from "../electron/app-probe.js"
import { AppKeySchema } from "../electron/contracts/thread-environments.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { childHistory } from "../electron/watch-backend.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-probe-bench-")))
const checkout = join(root, "checkout")
mkdirSync(checkout)
const app = join(root, "app.cjs")
writeFileSync(app, `require("node:net").createServer().listen(20028, "127.0.0.1"); setInterval(() => {}, 1000)`)
const history = childHistory()
const ms = (at: number) => Math.round(performance.now() - at)
let traced = 0
const processes = new ThreadProcesses({
  root: join(root, "records"),
  listening: portListening,
  cameUp: async (folder, at) => {
    const began = performance.now()
    await beginTrace(folder, at, process.argv.includes("--no-history") ? undefined : history)
    traced = ms(began)
  },
})
const key = AppKeySchema.parse("folder-0123456789abcdef")
try {
  await processes.start(key, [{ kind: "process", name: "web", command: `node ${JSON.stringify(app)}`, cwd: checkout, env: process.env, port: 20028 }])
  console.log(`trace begun in ${traced} ms`)
  await processes.settle(key, ["process-web"], 15_000, 300)
  for (let run = 0; run < 4; run += 1) {
    let began = performance.now()
    const { pids, since, records } = await processes.footprint(key, [checkout])
    await Promise.all([
      before.socketsOf(pids),
      before.writingOf(pids, [checkout, records]),
      before.changedSince(since!, [checkout, root, join(homedir(), ".mako")]),
      before.systemPortsFrom(),
    ])
    const old = ms(began)
    began = performance.now()
    const now = await processes.footprint(key, [checkout])
    const view = await probeApp({
      folder: now.folder,
      pids: now.pids,
      commands: now.commands,
      leftovers: now.leftovers,
      since: now.since!,
      own: [checkout, now.records],
      skip: [checkout, root, join(homedir(), ".mako")],
      ports: { first: 20028, last: 20037 },
      owner: async () => "unknown",
      history,
    })
    console.log(`main ${old} ms; branch ${ms(began)} ms (${view.changedBy}, ${view.changed.entries.length} changed folders, ${view.registered.length} registered)`)
  }
} finally {
  await processes.stop(key)
  rmSync(root, { recursive: true, force: true })
}
