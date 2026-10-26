import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveAssets, wholeField } from "@mako/host/conversations/live-assets"

/**
 * A call's field past the wire's preview limit goes out as its start and an
 * attachment holding all of it; `wholeField` reads it back whole from that
 * attachment, which is what `check-streams.ts` compares with the harness's
 * stream. A Devin `rg` of 65k characters once failed the check as "only the
 * stream" against Mako's preview.
 */

const root = mkdtempSync(join(tmpdir(), "mako-live-assets-"))
try {
  const assets = new LiveAssets(root)
  const output = Array.from({ length: 4_000 }, (_, line) => `src/file-${line}.ts:${line}: flag = ${line}`).join("\n")
  assert.ok(output.length > 64_000)
  const [sent] = assets.prepare({ kind: "tool", id: "call-1", title: "rg flag", status: "completed", input: "rg flag", output })
  assert.ok(sent?.kind === "tool" && sent.output !== undefined)
  assert.match(sent.output, /\[Preview shortened\. The complete output is attached as call-1-output\.txt\.\]$/u)
  const read = (path: string) => { try { return readFileSync(path, "utf8") } catch { return null } }
  assert.deepEqual(wholeField(sent.output, sent.attachments, read), { text: output, attachment: "call-1-output.txt" }, "the output reads back whole from its attachment")
  assert.deepEqual(wholeField("rg flag", sent.attachments, read), { text: "rg flag" }, "a field that wasn't shortened is as it was")
  assert.deepEqual(wholeField(sent.output, [], read), { text: sent.output }, "without its attachment the preview stays")
  rmSync(root, { recursive: true, force: true })
  assert.deepEqual(wholeField(sent.output, sent.attachments, read), { text: sent.output }, "with its file gone the preview stays")
  console.log("PASS: a shortened call field reads back whole from the attachment its preview names, and stays a preview without it")
} finally {
  rmSync(root, { recursive: true, force: true })
}

/**
 * A file an agent names is copied into Mako's store; one that is gone or can't be read is an attachment Mako
 * can't show, never a throw, which would read as a conversation Mako can't save and stop the agent's turn. A
 * prompt's attachment Mako can't read still refuses the prompt, saying why.
 */
const store = mkdtempSync(join(tmpdir(), "mako-live-assets-"))
try {
  const assets = new LiveAssets(join(store, "assets"))
  const image = join(store, "tide-report.png")
  writeFileSync(image, "png")
  const viewed = (path: string) => assets.prepare({ kind: "tool", id: "view-1", title: "View tide-report.png", status: "completed", output: "",
    attachments: [{ type: "attachment", name: "tide-report.png", mimeType: "image/png", source: { kind: "file", path } }] })
  const [copied] = viewed(image)
  const kept = copied?.kind === "tool" ? copied.attachments?.[0]?.source : undefined
  assert.ok(kept?.kind === "file" && kept.originalPath === image && readFileSync(kept.path, "utf8") === "png", "a readable file is copied into the store")
  for (const path of [join(store, "gone.png"), `file://${image}`]) {
    const [sent] = viewed(path)
    const source = sent?.kind === "tool" ? sent.attachments?.[0]?.source : undefined
    assert.deepEqual(source, { kind: "unavailable", reason: "tide-report.png could not be read (ENOENT)" }, `${path} is an attachment Mako can't show`)
  }
  assert.throws(() => assets.retainPrompt([{ name: "gone.png", mimeType: "image/png", path: join(store, "gone.png") }]), /gone\.png could not be read \(ENOENT\)/)
  console.log("PASS: a file the agent named that can't be read is an unavailable attachment, not a failure to save")
} finally {
  rmSync(store, { recursive: true, force: true })
}
