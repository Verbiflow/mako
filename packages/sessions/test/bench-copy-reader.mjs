import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { decompress } from "fzstd"
import { versionChunks } from "@mako/protocol/records"
import { ReadingCopies } from "../dist/reading-copies.js"
import { CopyReader, MemoryCopyStore } from "../dist/copy-reader.js"
import { ZstdFrames } from "../dist/zstd-frames.js"
import { MemoryRemote } from "./memory-remote.mjs"

/**
 * How fast a copy opens on another device (`CopyReader`): a Session of `--entries` entries, about `--mb` MB as Mako
 * draws it, written and captured as a Mac's `ReadingCopies` does, then read through a remote `--rtt` ms away. Says the
 * newest page's time cold (nothing kept) and kept (opened from the reader's store), what each fetched, the fill after,
 * and the zstd decode of every chunk by a browser's decoder (fzstd) against a Mac's (zlib).
 *
 *   npm run bench:copy-reader -- [--entries 20000] [--mb 5] [--rtt 60] [--runs 5]
 */
const { values } = parseArgs({ options: { entries: { type: "string", default: "20000" }, mb: { type: "string", default: "5" }, rtt: { type: "string", default: "60" }, runs: { type: "string", default: "5" } } })
const ENTRIES = Number(values.entries)
const RTT = Number(values.rtt)
const RUNS = Number(values.runs)
/** Each turn's thought, call and answer carry this many characters more, so the copy comes to about `--mb`. */
const PAD = Math.max(0, Math.round(2 * ((Number(values.mb) * 1024 * 1024) / ENTRIES - 130)))

const VOCABULARY = "the a schema column table export row read write port new old type null default index key value field check test pass fail drop keep move rename cast date time string number billing invoice account ledger amount currency total tax line item customer plan period refund credit debit batch job queue retry backoff error warning note migrate script node file path module function return await async const let if else for while map filter reduce".split(" ")
let seed = 7
/** `length` characters of words, the same each run: text that compresses as a transcript's does. */
function prose(length) {
  let text = ""
  while (text.length < length) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    text += `${VOCABULARY[seed % VOCABULARY.length]}${seed % 11 === 0 ? `_${seed % 977}` : ""} `
  }
  return text.slice(0, length)
}

/** A turn's five entries, as a long porting Session draws them: an ask, a thought, a command and its output, an answer. */
function entry(n) {
  const turn = Math.floor(n / 5)
  const at = 1_700_000_000_000 + n * 1000
  const words = prose(PAD)
  switch (n % 5) {
    case 0:
      return { id: `u-${n}`, type: "user", text: `Next table: export ${turn}.`, at }
    case 1:
      return { id: `r-${n}`, type: "thinking", text: `Read export ${turn}'s columns against the new schema. ${words}`, at }
    case 2:
      return { id: `t-${n}`, type: "tool", name: "exec_command", status: "completed", input: JSON.stringify({ cmd: `node scripts/port-export.mjs --table export_${turn}` }), output: `ported export_${turn}: 12 columns, 0 dropped\n${words}`, at }
    case 3:
      return { id: `m-${n}`, type: "text", text: `Export ${turn} reads the new schema. ${words.slice(0, PAD / 2)}`, at }
    default:
      return { id: `e-${n}`, type: "text", text: `Checked export ${turn}.`, at }
  }
}

/** A remote `rtt` ms away: each call waits that long before it's answered, as a phone's request to the account does. */
function distant(remote, rtt) {
  const asked = { calls: 0 }
  const proxy = new Proxy(remote, {
    get: (target, name) =>
      typeof target[name] !== "function"
        ? target[name]
        : async (...args) => {
            asked.calls++
            await new Promise((resolve) => setTimeout(resolve, rtt))
            return target[name](...args)
          },
  })
  return { proxy, asked }
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
const round = (ms) => Math.round(ms * 10) / 10

const folder = await mkdtemp(join(tmpdir(), "mako-bench-copy-reader-"))
const frames = new ZstdFrames()
try {
  const entries = Array.from({ length: ENTRIES }, (_, n) => entry(n))
  const remote = new MemoryRemote("gateway/d-studio")
  remote.answersHead = true
  const view = { total: entries.length, translator: "t-1", json: async (start, end) => entries.slice(start, end).map((each) => Buffer.from(JSON.stringify(each))) }
  const owner = new ReadingCopies(join(folder, "studio"), { view: async () => ({ view, ref: { harness: "codex", nativeId: "s-long", path: "/rail/s-long.jsonl", title: "Port the billing exports", cwd: "/Users/ana/billing" } }), stamp: () => "n:1", translator: () => "t-1" }, () => {}, { remote: () => remote })
  owner.scope({ sessions: [{ harness: "codex", nativeId: "s-long", path: "/rail/s-long.jsonl", thread: "t-1", busy: false, tier: "now" }], paused: false })
  owner.link({ id: "d-studio", base: "https://cloud.test/v1/devices/d-studio/records", authorization: "Bearer b" })
  await owner.settled()
  owner.stop()

  const decoders = { fzstd: (frame) => decompress(frame), zlib: (frame) => frames.decompress(frame) }
  const result = { entries: ENTRIES, rttMs: RTT }
  for (const [name, decode] of Object.entries(decoders)) {
    const cold = []
    const kept = []
    const fills = []
    let fetched
    for (let run = 0; run < RUNS; run++) {
      const { proxy, asked } = distant(remote, RTT)
      const store = new MemoryCopyStore()
      const began = performance.now()
      const copy = await new CopyReader({ remote: () => proxy, store, decode }).open("d-studio", "codex", "s-long")
      const page = await copy.page(undefined, 100)
      cold.push(performance.now() - began)
      const read = { calls: asked.calls, chunks: copy.chunkCount, size: copy.manifest.size, pageEntries: page.entries.length }
      const filling = performance.now()
      await copy.fill()
      fills.push(performance.now() - filling)
      // Opened again from what the store kept, as a phone opening a Thread it read before does: nothing asked first.
      const again = performance.now()
      const opened = await new CopyReader({ remote: () => proxy, store, decode, changed: () => {} }).open("d-studio", "codex", "s-long")
      await opened.page(undefined, 100)
      kept.push(performance.now() - again)
      fetched ??= read
    }
    const reader = new CopyReader({ remote: () => remote, decode })
    await reader.open("d-studio", "codex", "s-long")
    const { fetched: firstPageChunks, fetchedBytes: firstPageBytes } = reader.reads()[0]
    result.size ??= fetched.size
    result.chunks ??= fetched.chunks
    result.firstPage ??= { entries: fetched.pageEntries, chunks: firstPageChunks, bytes: firstPageBytes }
    result[name] = { coldFirstPageMs: round(median(cold)), keptFirstPageMs: round(median(kept)), fillMs: round(median(fills)), coldCalls: fetched.calls }
  }

  // Every chunk of the copy decoded once, by each decoder.
  const hashes = versionChunks((await remote.head("codex", "s-long")).units[0].versions.at(-1))
  const packed = await remote.readChunks(hashes)
  const compressed = packed.filter((chunk) => chunk.codec === 1)
  result.compressedChunks = compressed.length
  result.storedBytes = packed.reduce((total, chunk) => total + chunk.body.length, 0)
  for (const [name, decode] of Object.entries(decoders)) {
    const times = []
    for (let run = 0; run < RUNS; run++) {
      const began = performance.now()
      for (const chunk of compressed) await decode(chunk.body)
      times.push(performance.now() - began)
    }
    const ms = median(times)
    result[name].decodeAllMs = round(ms)
    result[name].decodeMBps = round(result.size / 1024 / 1024 / (ms / 1000))
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  frames.close()
  await rm(folder, { recursive: true, force: true })
}
