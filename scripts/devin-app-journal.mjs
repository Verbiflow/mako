import { readFileSync } from "node:fs"
import { createRequire, register } from "node:module"

/**
 * Writes a Devin.app journal with Devin.app's own message store, run by the
 * app's Electron as Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 /Applications/Devin.app/Contents/MacOS/Devin scripts/devin-app-journal.mjs < spec.json
 *
 * `spec` is `{ app, file, events }`: the app's folder, the journal to write,
 * and in order what the app's workbench hands its store for a session: each
 * `session/update`'s update (`{ ingest }`), and around a `session/load`
 * `{ beginReplay: true }` then `{ endReplay: { meta } }` with the load reply's
 * `_meta`. The store is the shared process's `AcpMessageStore` (schema 6 in
 * 3.10.23), exported by the hooks without changing the app's files.
 * `endReplay` gets the mode and cursor the workbench gives it
 * (`_sendAgentRequest`): `tail` when the reply says Devin dropped part of
 * the replay, `replace` otherwise.
 */

const spec = JSON.parse(readFileSync(0, "utf8"))
const out = `${spec.app}/Contents/Resources/app/out`
register(new URL("./devin-app-journal-hooks.mjs", import.meta.url), { data: { store: `${out}/vs/code/electron-utility/sharedProcess/sharedProcessMain.js` } })
process.parentPort = { once() {}, postMessage() {} }
globalThis._VSCODE_NLS_MESSAGES = JSON.parse(readFileSync(`${out}/nls.messages.json`, "utf8"))
const { AcpMessageStore } = await import(`file://${out}/vs/code/electron-utility/sharedProcess/sharedProcessMain.js`)
const acp = createRequire(`${spec.app}/Contents/Resources/app/package.json`)("@exa/windsurf-acp")

const problems = []
const log = { info() {}, trace() {}, debug() {}, flush() {}, warn: (...args) => problems.push(args.map(String).join(" ")), error: (...args) => problems.push(args.map(String).join(" ")) }
const store = new AcpMessageStore(log, undefined)
const file = { fsPath: spec.file, path: spec.file, toString: () => `file://${spec.file}` }
for (const event of spec.events) {
  if (event.ingest) await store.ingest(file, event.ingest)
  else if (event.beginReplay) await store.beginReplay(file)
  else if (event.endReplay) {
    const meta = event.endReplay.meta ?? undefined
    const dropped = meta?.["cognition.ai/host/replayDropped"]
    await store.endReplay(file, true, { mode: typeof dropped === "number" && dropped >= 0 ? "tail" : "replace", replyCursor: acp.getHostLogCursorMeta(meta) })
  }
}
await store.flush(file)
await store.unloadSession(file)
process.stdout.write(`${JSON.stringify({ problems })}\n`)
process.exit(0)
