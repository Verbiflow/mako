import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * What a host under test needs in its environment for every process it and its Node children start to be written to
 * `file` (`scripts/fixtures/process-starts-preload.cjs`), and what was written.
 */
export function recordProcessStarts(file) {
  const preload = resolve(import.meta.dirname, "..", "fixtures", "process-starts-preload.cjs")
  return { MAKO_TEST_PROCESS_STARTS: file, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
}

/** The processes started from `since` on, each as `<who started it>: <program> <its first arguments>`. */
export async function processStarts(file, since = 0) {
  const text = await readFile(file, "utf8").catch(() => "")
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((start) => start.at >= since)
    .map((start) => `${start.by}: ${[start.file.split(/[\\/]/).at(-1), ...start.args.slice(0, 3)].join(" ")}`)
}

export const startsFile = (folder) => join(folder, "process-starts.jsonl")
