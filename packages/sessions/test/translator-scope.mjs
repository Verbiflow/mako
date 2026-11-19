import assert from "node:assert/strict"
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ClaudeProvider, SessionCatalog, translatorOf, translatorScope } from "../dist/index.js"
import { makoToolWords } from "../dist/tool-identity.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

// Each harness's translation is fingerprinted by the code that decodes its records, not by the whole package: an
// update that changed the record store, sync, the catalog or another harness's decoder keeps every view of this
// harness's Threads. One hash over the package had every update decode every Thread again before its first page
// showed (13 to 18 s for a 20k-entry Thread, 2026-11-19).
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist")
const root = await mkdtemp(join(tmpdir(), "mako-translator-scope-"))
try {
  // What a harness's fingerprint covers: its readers and what they import, not the package's other work.
  const cursor = translatorScope(dist, ".js", "cursor")
  for (const covered of ["providers/cursor.js", "providers/cursor-records.js", "harnesses/cursor.js", "entries.js", "entry-sink.js", "format.js", "tool-identity.js"])
    assert.ok(cursor.includes(covered), `cursor's translation covers ${covered}`)
  for (const outside of ["record-store.js", "catalog.js", "view-cache.js", "daemon.js", "record-sync.js", "providers/claude.js", "harnesses/codex.js", "harnesses/claude.js", "mako-tools.js", "translator.js"])
    assert.ok(!cursor.includes(outside), `cursor's translation leaves out ${outside}`)
  assert.ok(translatorScope(dist, ".js", "devin").includes("providers/devin-cli.js") && translatorScope(dist, ".js", "devin").includes("providers/devin-local.js"), "Devin's two readers are both its translation")
  assert.ok(translatorScope(dist, ".js", "an-outside-reader").includes("record-store.js"), "a harness this package has no reader for is fingerprinted by the whole package")

  // A build that changed code outside a harness's translation keeps its fingerprint; one inside changes it, and only its.
  const copy = join(root, "dist")
  await cp(dist, copy, { recursive: true, filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") })
  const harnesses = ["claude", "codex", "cursor", "devin", "grok", "opencode", "an-outside-reader"]
  const fingerprints = () => Object.fromEntries(harnesses.map((harness) => [harness, translatorOf(copy, ".js", harness)]))
  const changed = (before, after) => harnesses.filter((harness) => before[harness] !== after[harness]).sort()
  let before = fingerprints()
  assert.equal(new Set(Object.values(before)).size, harnesses.length, "each harness has its own fingerprint")
  const edit = async (file) => {
    await appendFile(join(copy, file), `\n// ${file} changed\n`)
    const after = fingerprints()
    const moved = changed(before, after)
    before = after
    return moved
  }
  assert.deepEqual(await edit("record-store.js"), ["an-outside-reader"], "the record store changing keeps every harness's views")
  assert.deepEqual(await edit("catalog.js"), ["an-outside-reader"], "the catalog changing keeps them")
  assert.deepEqual(await edit("mako-tools.js"), ["an-outside-reader"], "Mako's own tools' words changing keeps them")
  assert.deepEqual(await edit("harnesses/codex.js"), ["an-outside-reader", "codex"], "Codex's vocabulary (a version bump) decodes only Codex's Threads again")
  assert.deepEqual(await edit("providers/cursor-records.js"), ["an-outside-reader", "cursor"], "Cursor's decoder changing decodes only Cursor's again")
  assert.deepEqual(await edit("entry-sink.js"), harnesses.slice().sort(), "what every decoder makes entries with changing decodes every harness's again")

  // `mako-tools.ts` is left out because no entry a decode makes holds its words: the window words each call as it draws it.
  const home = join(root, "home")
  const cwd = join(home, "work")
  const session = "a1b2c3d4-0000-4000-8000-000000000001"
  const folder = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  await mkdir(folder, { recursive: true })
  const args = { harness: "codex", prompt: "Review the parser", name: "parser-review" }
  const line = (value, at) => JSON.stringify({ sessionId: session, cwd, isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 19, 12, 0, at)).toISOString(), ...value })
  await writeFile(join(folder, `${session}.jsonl`), [
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Start a Fin" } }, 0),
    line({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__mako__agents_start", input: args }] } }, 1),
    line({ type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ id: "fin:parser-review" }) }] } }, 2),
  ].join("\n") + "\n")
  const read = await new ClaudeProvider(home, new NativeStores(false)).read(join(folder, `${session}.jsonl`))
  assert.ok(read?.entries.some((entry) => entry.type === "tool" && entry.name === "mcp__mako__agents_start"), "the call decodes")
  const words = makoToolWords("agents_start", args)
  const decoded = JSON.stringify(read.entries)
  for (const said of [words.label, words.running, words.done]) assert.ok(!decoded.includes(said), `no entry holds "${said}"`)

  // A catalog keeps a harness's views while only another harness's decoder changed, and decodes one whose decoder did.
  const sessions = { claude: join(root, "claude", "s"), cursor: join(root, "cursor", "s") }
  const reads = { claude: 0, cursor: 0 }
  const provider = (harness) => {
    const stamp = { path: sessions[harness], bytes: 100, mtimeMs: 1 }
    return {
      harness, displayName: harness, roots: () => [dirname(sessions[harness])],
      discover: async () => [stamp], stat: async () => stamp,
      peek: async (file) => ({ harness, nativeId: harness, path: file.path, bytes: 100 }),
      read: async (path) => {
        reads[harness] += 1
        // Slow enough to be kept on disk (`VIEW_MIN_DECODE_MS`).
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ref: { harness, nativeId: harness, path, bytes: 100 }, entries: [{ type: "user", id: `${harness}-1`, text: `Hello from ${harness}` }] }
      },
    }
  }
  const viewsPath = join(root, "views")
  const opened = async (translator) => {
    const catalog = new SessionCatalog([provider("claude"), provider("cursor")], { viewsPath, translator })
    await catalog.scan()
    const pages = { claude: await catalog.page(sessions.claude), cursor: await catalog.page(sessions.cursor) }
    await catalog.stop()
    return pages
  }
  const first = await opened((harness) => `${harness}-1`)
  assert.deepEqual([first.claude.translator, first.cursor.translator, reads.claude, reads.cursor], ["claude-1", "cursor-1", 1, 1])
  const cursorChanged = await opened((harness) => (harness === "cursor" ? "cursor-2" : `${harness}-1`))
  assert.equal(reads.claude, 1, "Claude's Thread is served from its view: only Cursor's decoder changed")
  assert.equal(cursorChanged.claude.translator, "claude-1")
  assert.deepEqual([reads.cursor, cursorChanged.cursor.translator], [2, "cursor-2"], "Cursor's is decoded again by its new decoder")
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("translator scope: ok")
