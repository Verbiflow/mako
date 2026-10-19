import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { buildTranscript, defaultCatalog, writeTranscript, type Thread } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"

/**
 * What building a transcript costs (`buildTranscript`, then
 * `writeTranscript`): synthetic conversations of 1,000, 10,000 and 100,000
 * entries, and real sessions. Each case runs in a process of its own, so its
 * peak memory is its own: the RSS with the entries loaded, and the peak
 * through its first build and write; the build's time is its first run and
 * the best of three after. Tokens are counted with o200k_base where
 * `gpt-tokenizer` is installed (`MAKO_TOKENIZER` names its encoding module).
 *
 *   npm run bench:transcript                          synthetic 1k, 10k, 100k
 *   npm run bench:transcript -- <session path>…       and those sessions
 *   npm run bench:transcript -- --json <thread.json>  a thread saved as JSON
 */
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { one: { type: "string" }, json: { type: "string", multiple: true }, sizes: { type: "string", default: "1000,10000,100000" } },
})

const TOKENIZER = process.env.MAKO_TOKENIZER ?? join(process.env.HOME ?? "", "flage/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js")

/** A conversation of `count` entries shaped like agent work: prompts, thinking, answers, calls with short and long outputs, markers. */
function synthetic(count: number): Entry[] {
  const entries: Entry[] = []
  for (let index = 0; entries.length < count; index++) {
    const at = Date.UTC(2026, 9, 1) + index * 60_000
    const turn = Math.floor(index / 12)
    switch (index % 12) {
      case 0: entries.push({ type: "user", id: `u${index}`, at, text: `Turn ${turn}: fix the failing parser test in src/parser-${turn}.ts and explain the cause.` }); break
      case 1: entries.push({ type: "thinking", id: `t${index}`, at, model: "model-a", text: `Looking at parser ${turn}. ${"The tokenizer splits on the wrong boundary. ".repeat(index % 7 === 0 ? 80 : 4)}` }); break
      case 2: case 4: case 6: entries.push({ type: "tool", id: `c${index}`, at, name: "Bash", status: "completed", input: JSON.stringify({ command: `rg -n "tokenize" src/parser-${turn}.ts`, description: "Find the tokenizer" }), output: Array.from({ length: 12 }, (_, line) => `src/parser-${turn}.ts:${line * 7}: const tokens = tokenize(input, ${line})`).join("\n") }); break
      case 3: entries.push({ type: "tool", id: `c${index}`, at, name: "Read", status: "completed", input: JSON.stringify({ file_path: `/work/src/parser-${turn}.ts` }), output: Array.from({ length: 400 }, (_, line) => `${line + 1}\texport function step${line}(input: string): number { return input.length * ${line} }`).join("\n") }); break
      case 5: entries.push({ type: "tool", id: `c${index}`, at, name: "Edit", status: "completed", input: JSON.stringify({ file_path: `/work/src/parser-${turn}.ts`, old_string: "return input.length * 3\n}", new_string: "return input.trim().length * 3\n}" }), output: "The file has been updated." }); break
      case 7: entries.push({ type: "tool", id: `c${index}`, at, name: "Bash", status: index % 5 === 0 ? "failed" : "completed", input: JSON.stringify({ command: "npm test", description: "Run the tests" }), output: `${Array.from({ length: 60 }, (_, line) => `  ✓ parser ${turn} case ${line} (${line % 9} ms)`).join("\n")}\n\n60 passing` }); break
      case 8: entries.push({ type: "event", id: `e${index}`, at, label: "Context compacted", detail: "Automatic · 400k → 20k tokens", ...index % 24 === 8 && { body: `Summary:\n${"- what was decided and why\n".repeat(120)}` } }); break
      case 9: entries.push({ type: "text", id: `a${index}`, at, text: `The cause was the tokenizer's boundary in parser ${turn}.\n\n## What changed\n\n- \`src/parser-${turn}.ts\`: trim before measuring.\n- Tests: 60 passing.\n` }); break
      case 10: entries.push({ type: "plan", id: `p${index}`, at, entries: [{ content: "Find the cause", status: "completed" }, { content: "Fix it", status: "completed" }, { content: "Ship", status: "pending" }] }); break
      default: entries.push({ type: "text", id: `a${index}`, at, text: "Done." })
    }
  }
  return entries
}

async function tokens(text: string): Promise<number | null> {
  if (!existsSync(TOKENIZER)) return null
  // SAFETY: gpt-tokenizer's encoding modules export `countTokens(text): number`; the path names one.
  const { countTokens } = (await import(TOKENIZER)) as { countTokens(text: string): number }
  return countTokens(text)
}

/** One case, in this process: build twice (the first warms the code), write once, count. */
async function one(spec: string): Promise<void> {
  let thread: Thread
  if (spec.startsWith("synthetic:")) {
    const count = Number(spec.slice("synthetic:".length))
    thread = { ref: { harness: "claude", nativeId: "synthetic", path: "synthetic" }, entries: synthetic(count) }
  } else if (spec.startsWith("json:")) {
    // SAFETY: a thread saved with JSON.stringify by a script of this checkout, read back as written.
    thread = JSON.parse(await readFile(spec.slice(5), "utf8")) as Thread
  } else {
    const catalog = defaultCatalog({ readOnly: true })
    try {
      const read = await catalog.open(spec.slice("session:".length), false)
      if (!read) throw new Error(`No reader opens ${spec}`)
      thread = read
    } finally {
      catalog.stop()
    }
  }
  const input = { entries: thread.entries, harness: thread.ref.harness, ...thread.ref.title !== undefined && { title: thread.ref.title } }
  globalThis.gc?.()
  const loaded = process.memoryUsage().rss
  // The first build and its write, alone: their peak is this case's memory, before the timed builds add garbage.
  const cold = performance.now()
  let built = await buildTranscript(input)
  const coldMs = performance.now() - cold
  const root = await mkdtemp(join(tmpdir(), "mako-bench-transcript-"))
  const writing = performance.now()
  await writeTranscript(root, built)
  const writeMs = performance.now() - writing
  const peak = process.resourceUsage().maxRSS * 1024
  const again = performance.now()
  await writeTranscript(root, built)
  const rewriteMs = performance.now() - again
  await rm(root, { recursive: true, force: true })
  const builds: number[] = []
  for (let run = 0; run < 3; run++) {
    const started = performance.now()
    built = await buildTranscript(input)
    builds.push(performance.now() - started)
  }
  const fileBytes = built.files.reduce((sum, file) => sum + file.bytes.length, 0)
  console.log(JSON.stringify({
    case: spec.replace(/^session:.*\//, "session:…/"),
    entries: thread.entries.length,
    turns: built.turns,
    coldMs: Math.round(coldMs),
    buildMs: Math.round(Math.min(...builds)),
    usPerEntry: Number(((Math.min(...builds) * 1000) / thread.entries.length).toFixed(2)),
    writeMs: Math.round(writeMs),
    rewriteMs: Number(rewriteMs.toFixed(2)),
    loadedMB: Math.round(loaded / 1e6),
    peakMB: Math.round(peak / 1e6),
    transcriptMB: Number((Buffer.byteLength(built.markdown) / 1e6).toFixed(2)),
    files: built.files.length,
    filesMB: Number((fileBytes / 1e6).toFixed(2)),
    transcriptTokens: await tokens(built.markdown),
  }))
}

if (options.one) await one(options.one)
else {
  const specs = [
    ...options.sizes.split(",").filter(Boolean).map((size) => `synthetic:${size}`),
    ...(options.json ?? []).map((file) => `json:${file}`),
    ...positionals.map((path) => `session:${path}`),
  ]
  const rows: unknown[] = specs.map((spec) => JSON.parse(execFileSync(process.execPath, [...process.execArgv, "--expose-gc", process.argv[1]!, "--one", spec], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").at(-1)!))
  console.table(rows)
}
