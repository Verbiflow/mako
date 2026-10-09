import assert from "node:assert/strict"
import { cursorCanvasPreview } from "../electron/providers/cursor/canvas-preview.ts"
import { artifactDocument, previewsFile, type ProviderArtifactPreview } from "../electron/providers/artifact-preview.ts"

const document = await cursorCanvasPreview.render(`
import { H1, Pill, Row, Table, useCanvasState } from "cursor/canvas";
export default function Test() {
  const [tab, setTab] = useCanvasState("tab", "Overview");
  return <><H1>Saved document</H1><Row><Pill active={tab === "Overview"} onClick={() => setTab("Overview")}>Overview</Pill><Pill active={tab === "Evidence"} onClick={() => setTab("Evidence")}>Evidence</Pill></Row>{tab === "Evidence" ? <Table headers={["Source"]} rows={[["Retained record"]]}/> : <p>Summary</p>}</>;
}`)
assert.match(document, /default-src 'none'/)
assert.match(document, /connect-src 'none'/)
assert.match(document, /Saved document/)
assert.doesNotMatch(document, /<script[^>]+src=/)
await assert.rejects(cursorCanvasPreview.render('import fs from "node:fs"; export default () => fs.readFileSync("/etc/passwd")'), /Unsupported Canvas import/)
await assert.rejects(cursorCanvasPreview.render('import Secret from "../../secrets"; export default Secret'), /Unsupported Canvas import/)
await assert.rejects(cursorCanvasPreview.render('export default function Empty(){return null}' + " ".repeat(256_000)), /size limit/)
const escaped = await cursorCanvasPreview.render('export default function Example(){return <p>{"</ScRiPt><script>alert(1)</script>"}</p>}')
assert.equal((escaped.match(/<\/script\s*>/gi) ?? []).length, 1, "Source strings cannot escape their script element")

assert.ok(previewsFile(cursorCanvasPreview, "notes/plan.canvas.tsx"))
assert.ok(!previewsFile(cursorCanvasPreview, "src/plan.tsx"))

// Reopening an unchanged canvas reuses its build; an edited one builds again.
const source = 'import { H1 } from "cursor/canvas"; export default function Reopened(){return <H1>Reopened</H1>}'
let started = performance.now()
const cold = await artifactDocument(cursorCanvasPreview, source)
const coldMs = performance.now() - started
started = performance.now()
const warm = await artifactDocument(cursorCanvasPreview, source)
const warmMs = performance.now() - started
assert.equal(warm, cold)
assert.ok(warmMs < coldMs / 10, `a reopen reuses the build (${warmMs.toFixed(2)} ms against ${coldMs.toFixed(1)} ms)`)
assert.notEqual(await artifactDocument(cursorCanvasPreview, source.replace("Reopened</H1>", "Edited</H1>")), cold)

// Two reads of one source share a build in flight; a failed build is tried again.
let builds = 0
let failing = true
const counted: ProviderArtifactPreview = { provider: "counted", name: "Counted", files: [".counted"], via: "test", render: async (text) => {
  builds++
  if (failing) throw new Error("not yet")
  return `<p>${text}</p>`
} }
await assert.rejects(Promise.all([artifactDocument(counted, "a"), artifactDocument(counted, "a")]), /not yet/)
assert.equal(builds, 1, "reads in flight share one build")
failing = false
assert.equal(await artifactDocument(counted, "a"), "<p>a</p>")
assert.equal(builds, 2, "a failed build isn't kept")
for (let index = 0; index < 40; index++) await artifactDocument(counted, `doc ${index}`)
const before = builds
await artifactDocument(counted, "a")
assert.equal(builds, before + 1, "the cache keeps the newest documents and lets the oldest go")

console.log(`Canvas compiles without executing source in the host; disk imports, oversized input, and script escapes are blocked; a reopen reuses its build (${coldMs.toFixed(0)} ms cold, ${warmMs.toFixed(2)} ms again)`)
