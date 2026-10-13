/**
 * A digest of everything each decoder produces, so a change meant only to
 * make decoding faster can prove it changed nothing:
 *
 *   decode    each kept fixture and pair capture through a fresh recorded decoder: kinds and events
 *   host      each pair capture through the live engine, as the host hands the window
 *   saved     with `--real`, this Mac's settled saved sessions (untouched for 30 minutes) as the store readers read them
 *
 * Decoding a recording must also leave the recording as it was: a decoder
 * that keeps or changes the objects it was handed would draw differently on
 * a second read.
 *
 *   npm run decode:outputs -- --save before.json                     the kept recordings
 *   npm run decode:outputs -- --real --save before.json              and this Mac's stores, read-only
 *   npm run decode:outputs -- --real --against before.json           fails when any output differs
 */
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { PAIRS_FOLDER, liveUpdates, storeReader } from "./decode-compare"
import { decoders, FIXTURE_ROOT, readRecording, recorded, replayed } from "./native-decoding"

const { values } = parseArgs({
  options: {
    real: { type: "boolean", default: false },
    save: { type: "string" },
    against: { type: "string" },
  },
})

const DigestsSchema = z.record(z.string(), z.string())
const SETTLED_MS = 30 * 60_000
/** The largest sessions, where most decoding happens, and a spread of the rest. */
const LARGEST = 8
const SPREAD = 60

function digest(json: string): string {
  return createHash("sha1").update(json).digest("hex")
}

const digests: Record<string, string> = {}
const touched: string[] = []

for (const source of decoders()) {
  const folder = join(FIXTURE_ROOT, source.provider)
  const paths = [
    ...(await readdir(join(folder, PAIRS_FOLDER)).catch(() => [])).sort().map((name) => join(folder, PAIRS_FOLDER, name, "capture.jsonl")),
    ...(await readdir(folder)).filter((file) => file.endsWith(".json")).sort().map((file) => join(folder, file)),
  ]
  for (const path of paths) {
    const recording = await readRecording(path)
    const name = path.slice(FIXTURE_ROOT.length + 1)
    const before = JSON.stringify(recording.messages)
    const steps = [...replayed(source.open(recording.session), recording)].map(({ message, decoded }) => [source.kind(message), recorded(decoded)])
    digests[`decode ${name}`] = digest(JSON.stringify(steps))
    if (path.endsWith("capture.jsonl")) digests[`host ${name}`] = digest(JSON.stringify(liveUpdates(source.provider, recording)))
    if (JSON.stringify(recording.messages) !== before) touched.push(name)
  }
}

if (values.real) {
  const settled = Date.now() - SETTLED_MS
  for (const reader of ["claude", "codex", "cursor", "devin", "devin-ide", "grok", "opencode"]) {
    const provider = storeReader(reader, homedir())
    const files = (await provider.discover()).filter((file) => file.mtimeMs < settled).sort((left, right) => right.bytes - left.bytes)
    const picked = new Set([...files.slice(0, LARGEST), ...files.filter((_, index) => index % 7 === 3).slice(0, SPREAD)])
    for (const file of picked) {
      const thread = await provider.read(file.path).then((read) => JSON.stringify(read) ?? "undefined", (error: Error) => JSON.stringify(`error ${error.name}`))
      digests[`saved ${reader} ${file.path}`] = digest(thread)
    }
    console.error(`${reader}: ${picked.size} of ${files.length} settled sessions`)
  }
}

if (values.save) await writeFile(values.save, `${JSON.stringify(digests, null, 1)}\n`)
let failed = touched.length > 0
for (const name of touched) console.error(`decoding changed its input: ${name}`)
if (values.against) {
  const before = DigestsSchema.parse(JSON.parse(await readFile(values.against, "utf8")))
  const compared = Object.keys(digests).filter((key) => key in before)
  const differ = compared.filter((key) => before[key] !== digests[key])
  const unread = Object.keys(before).filter((key) => !(key in digests))
  console.log(`${Object.keys(digests).length} outputs, ${compared.length} compared with ${values.against}, ${differ.length} differ, ${unread.length} not read now`)
  for (const key of differ) console.error(`differs: ${key}`)
  failed ||= differ.length > 0
} else console.log(`${Object.keys(digests).length} outputs${values.save ? ` saved to ${values.save}` : ""}`)
if (failed) process.exitCode = 1
