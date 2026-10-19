import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
