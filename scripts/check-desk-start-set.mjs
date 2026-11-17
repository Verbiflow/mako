import { build } from "vite"

/**
 * What the desk loads before it draws: every chunk `index.html` reaches by static imports in a production build of the
 * renderer, the twin of check-host-start-set.mjs for the window.
 *
 * The Office viewers (`@file-viewer/renderer-*`) load when a document opens (`office-document.tsx`), never at start.
 * With the file viewer plugin's `chunkStrategy: "renderer"` their groups took Vite's preload helper, and the desk's
 * start imported the PowerPoint viewer to reach it: about 330 KiB at every launch (#545, #919). A module of theirs in
 * the start set fails here with the chain that brings it in, and so does a start set past `START_BYTES`: a reviewed
 * change to this number, never a side effect of an import.
 *
 * It builds the renderer in memory (`write: false`), about a minute.
 */
const START_BYTES = 1_320_000
const LAZY = /[\\/]@file-viewer[\\/]renderer-/

const result = await build({ logLevel: "error", build: { write: false, reportCompressedSize: false } })
const outputs = (Array.isArray(result) ? result : [result]).flatMap((each) => each.output)
const chunks = new Map(outputs.filter((item) => item.type === "chunk").map((chunk) => [chunk.fileName, chunk]))
const entries = [...chunks.values()].filter((chunk) => chunk.isEntry && chunk.facadeModuleId?.endsWith("index.html"))
if (!entries.length) throw new Error("The renderer build has no index.html entry")

/** Each chunk the start loads, with the chunk that imported it, by static imports only. */
const parent = new Map(entries.map((chunk) => [chunk.fileName, undefined]))
const queue = entries.map((chunk) => chunk.fileName)
while (queue.length) {
  const file = queue.shift()
  for (const next of chunks.get(file)?.imports ?? [])
    if (!parent.has(next)) {
      parent.set(next, file)
      queue.push(next)
    }
}
const chain = (file) => {
  const files = []
  for (let at = file; at; at = parent.get(at)) files.unshift(at)
  return files.join(" → ")
}

let failed = false
let bytes = 0
for (const file of parent.keys()) {
  const chunk = chunks.get(file)
  if (!chunk) continue
  bytes += Buffer.byteLength(chunk.code)
  const lazy = chunk.moduleIds.filter((id) => LAZY.test(id))
  if (lazy.length) {
    failed = true
    console.error(`An Office viewer loads with the desk's start: ${file} holds ${lazy.length} of its modules (${lazy[0].replace(/^.*node_modules[\\/]/, "")}…), through ${chain(file)}. Load it where it's used, as office-document.tsx does, and keep vite.config.ts's file viewer chunkStrategy at "none".`)
  }
}
if (bytes > START_BYTES) {
  failed = true
  console.error(`The desk's start set is ${bytes.toLocaleString("en-US")} bytes, past its ${START_BYTES.toLocaleString("en-US")}. Find what joined it (a static import of something only some views need), or raise START_BYTES in scripts/check-desk-start-set.mjs if the window can't draw without it.`)
}
if (failed) process.exit(1)
console.log(`desk start set: ${parent.size} chunks, ${bytes.toLocaleString("en-US")} bytes of ${START_BYTES.toLocaleString("en-US")}, no Office viewer`)
