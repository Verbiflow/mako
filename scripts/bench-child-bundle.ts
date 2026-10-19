import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import { buildTranscript, ChildSidecars, childStateCounts, defaultCatalog, writeTranscript, type ChildSource, type TranscriptChild } from "@mako/sessions"
import { ContextBundles, prepareLiveContext } from "@mako/host/conversations/live-context"
import { LiveJournal } from "@mako/host/conversations/live-journal"

/**
 * What carrying a session's child agents costs a transcript, on a real
 * session, read-only: the transcript without its children, then with them,
 * each child built into its own folder the first time and reused the next,
 * and what the transcript says about the reports its children sent back.
 *
 * `--journal` measures the live path too: a copy of a Mako conversation's
 * journal (`<data>/conversations/<id>.sqlite`) goes through
 * `prepareLiveContext` the way a handoff to another harness does.
 *
 *   npm run bench:child-bundle -- <session path>
 *   npm run bench:child-bundle -- <session path> --keep /tmp/bundle   writes the bundle there to read
 *   npm run bench:child-bundle -- <session path> --journal <conversation .sqlite>
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { keep: { type: "string" }, journal: { type: "string" }, json: { type: "boolean", default: false } },
})
const path = positionals[0]
if (!path) {
  console.error("Usage: npm run bench:child-bundle -- <session path> [--journal <conversation .sqlite>] [--keep <folder>] [--json]")
  process.exit(2)
}

const timed = async <T>(work: () => Promise<T> | T): Promise<{ value: T; ms: number }> => {
  const started = performance.now()
  const value = await work()
  return { value, ms: Math.round(performance.now() - started) }
}

const catalog = defaultCatalog({ readOnly: true })
const root = options.keep ?? (await mkdtemp(join(tmpdir(), "mako-child-bundle-")))
try {
  const opened = await timed(() => catalog.open(path, false))
  const thread = opened.value
  if (!thread) throw new Error(`No reader opens ${path}`)
  const toolIds = new Set(thread.entries.flatMap((entry) => (entry.type === "tool" && entry.id ? [entry.id] : [])))
  const parents = [{ path, toolIds, whole: true }]
  const build = (children?: TranscriptChild[]) => buildTranscript({ entries: thread.entries, harness: thread.ref.harness, ...children && { children } })

  const before = await timed(() => build())
  const listed = await timed(() => catalog.children(path))
  const sidecars = new ChildSidecars(join(root, "children"))
  const source = { children: (at: string) => catalog.children(at), open: (at: string) => catalog.open(at, false) }
  const cold = await timed(() => sidecars.bundle(source, parents))
  const after = await timed(() => build(cold.value.children))
  const warm = await timed(() => new ChildSidecars(join(root, "children")).bundle(source, parents))
  const written = await writeTranscript(join(root, "transcripts"), after.value)
  const live = options.journal ? await liveBundles(options.journal, join(root, "live"), source) : null

  const reports = thread.entries.filter((entry) => (entry.type === "event" || entry.type === "provider-turn") && entry.cause?.kind === "agent")
  const children = cold.value.children
  const result = {
    session: { path, entries: thread.entries.length, openMs: opened.ms },
    before: { buildMs: before.ms, markdown: before.value.markdown.length, files: before.value.files.length },
    children: {
      listMs: listed.ms,
      listed: listed.value?.children.length ?? 0,
      carried: children.length,
      byState: listed.value ? childStateCounts(listed.value.children) : null,
      withTranscript: children.filter((child) => child.transcript).length,
      withLastWords: children.filter((child) => child.last).length,
      transcriptCharacters: children.reduce((sum, child) => sum + (child.transcript?.characters ?? 0), 0),
    },
    cold: { ...cold.value.stats, wallMs: cold.ms },
    warm: { ...warm.value.stats, wallMs: warm.ms },
    after: {
      buildMs: after.ms,
      markdown: after.value.markdown.length,
      files: after.value.files.length,
      indexed: count(after.value.markdown, /^### Child agent \d+/gm),
      linkedCalls: count(after.value.markdown, /^Child agent: /gm),
      reportEvents: count(after.value.markdown, /^Reports on child agent /gm),
      losses: after.value.losses,
    },
    reports: {
      agentEvents: reports.length,
      withBody: reports.filter((entry) => (entry.type === "event" || entry.type === "provider-turn") && entry.body).length,
    },
    bundle: written,
    live,
  }
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else console.log(formatted(result))
} finally {
  await catalog.stop()
  if (!options.keep) await rm(root, { recursive: true, force: true })
}

/**
 * The live path on a copy of a conversation's journal: its bundle without
 * children, with them cold (each child already rendered by the saved path is
 * reused, so the cold run gets its own folder) and warm.
 */
async function liveBundles(journal: string, folder: string, native: ChildSource) {
  const copy = join(folder, "journal")
  await mkdir(copy, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) await copyFile(`${journal}${suffix}`, join(copy, `${basename(journal)}${suffix}`)).catch(() => undefined)
  const store = new LiveJournal(copy, basename(journal, ".sqlite"))
  const snapshot = store.read()
  if (!snapshot) throw new Error(`No conversation in ${journal}`)
  const bundles = new ContextBundles(native)
  const prepare = (name: string, withNative: boolean) =>
    timed(() => prepareLiveContext({ snapshot, root: join(folder, name), fromBlock: 0, includesBase: true, bundles: withNative ? bundles : new ContextBundles() }))
  const before = await prepare("before", false)
  const cold = await prepare("after", true)
  const warm = await prepare("after", true)
  const measured = async (manifest: { file: string; resources?: string[] }, ms: number) => {
    const markdown = await readFile(manifest.file, "utf8")
    return {
      ms,
      markdown: markdown.length,
      resources: manifest.resources?.length ?? 0,
      reportEvents: count(markdown, /^Reports on child agent /gm),
      agentEventsWithoutBody: count(markdown, /^### (?:Event|Harness turn): Agent "[^"\n]*" (?:finished|failed|was stopped)\n(?:Reports on [^\n]*\n)?\n/gm),
      linkedCalls: count(markdown, /^Child agent: /gm),
      file: manifest.file,
    }
  }
  return {
    blocks: snapshot.blocks.length,
    before: await measured(before.value, before.ms),
    cold: await measured(cold.value, cold.ms),
    warm: await measured(warm.value, warm.ms),
  }
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function formatted(result: { session: { entries: number; openMs: number }; before: object; children: object; cold: object; warm: object; after: object; reports: object; bundle: string; live: object | null }): string {
  return [
    ...(result.live ? [`live (journal through prepareLiveContext): ${JSON.stringify(result.live)}`] : []),
    `session: ${result.session.entries} entries, opened in ${result.session.openMs} ms`,
    `before (no children): ${JSON.stringify(result.before)}`,
    `children: ${JSON.stringify(result.children)}`,
    `cold sidecars: ${JSON.stringify(result.cold)}`,
    `warm sidecars: ${JSON.stringify(result.warm)}`,
    `after (children carried): ${JSON.stringify(result.after)}`,
    `reports: ${JSON.stringify(result.reports)}`,
    `bundle: ${result.bundle}`,
  ].join("\n")
}
