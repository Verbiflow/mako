import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { buildTranscript, defaultCatalog, type Thread } from "@mako/sessions"
// @ts-expect-error The checker is plain JavaScript shared with the package's own tests.
import { checkTranscript } from "../packages/sessions/test/transcript-checker.mjs"

/**
 * Builds the transcript of real sessions on this Mac and reads each back
 * (`transcript-checker.mjs`): every entry's content is recovered from
 * transcript.md and its files, turn for turn. Read-only; nothing is written.
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/check-transcript-lossless.ts              the largest sessions of each harness
 *   … --per 5                                                                               five of each
 *   … <session path> [<session path>…]                                                      those sessions
 *   … --json <thread.json>                                                                  a thread saved as JSON
 */
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { per: { type: "string", default: "2" }, json: { type: "string", multiple: true } },
})

interface Row {
  harness: string
  path: string
  entries: number
  turns: number
  buildMs: number
  markdown: number
  files: number
  fileBytes: number
  moved: number
}

const rows: Row[] = []
let failed = 0

async function check(thread: Thread): Promise<void> {
  const started = performance.now()
  const built = await buildTranscript({ entries: thread.entries, harness: thread.ref.harness, ...thread.ref.title !== undefined && { title: thread.ref.title }, ...thread.ref.cwd !== undefined && { cwd: thread.ref.cwd } })
  const buildMs = Math.round(performance.now() - started)
  try {
    const counts: { moved: number } = checkTranscript(thread.entries, built)
    rows.push({ harness: thread.ref.harness, path: thread.ref.path, entries: thread.entries.length, turns: built.turns, buildMs, markdown: built.markdown.length, files: built.files.length, fileBytes: built.files.reduce((sum, file) => sum + file.bytes.length, 0), moved: counts.moved })
  } catch (error) {
    failed += 1
    console.error(`FAILED ${thread.ref.harness} ${thread.ref.path}\n  ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const file of options.json ?? []) {
  // SAFETY: a thread saved with JSON.stringify by a script of this checkout, read back as written.
  const thread = JSON.parse(await readFile(file, "utf8")) as Thread
  await check(thread)
}
const catalog = defaultCatalog({ readOnly: true })
try {
  if (positionals.length || options.json?.length) {
    for (const path of positionals) {
      const thread = await catalog.open(path, false)
      if (thread?.entries.length) await check(thread)
    }
  } else {
    await catalog.scan()
    const per = Number(options.per)
    const checked = new Map<string, number>()
    // OpenCode's `bytes` is a revision stamp, not a size, so its newest stand in for its largest.
    // An empty session (a Devin IDE database with no messages) is passed over, so each harness gets its `per`.
    for (const ref of catalog.list().sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0))) {
      if ((checked.get(ref.harness) ?? 0) >= per) continue
      const thread = await catalog.open(ref.path, false)
      if (!thread?.entries.length) continue
      checked.set(ref.harness, (checked.get(ref.harness) ?? 0) + 1)
      await check(thread)
    }
  }
} finally {
  catalog.stop()
}
console.table(rows)
console.log(failed ? `${failed} of ${rows.length + failed} transcripts lost content` : `${rows.length} transcripts read back whole`)
process.exitCode = failed ? 1 : 0
