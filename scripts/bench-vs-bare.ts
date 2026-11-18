import "./lib/scratch-git.mjs"
/**
 * What each step of Mako's pipeline costs against the same harness run by itself: `npm run bench:vs-bare`.
 *
 * One scripted answer (`scripted-model.ts`, or `scripted-windsurf.ts` for Devin: no account, nothing leaves this
 * machine) is run two ways and timed on one clock, the machine's monotonic one, which every process here reads
 * (`process.hrtime`):
 *
 * A. Bare. The harness's own CLI in a sealed scratch home, in the non-interactive mode closest to a person running it
 *    by itself with streaming output (`BARE`: Claude Code's `-p` with stream-json in and out, the build Mako itself
 *    runs; `codex exec --json`; `grok -p --output-format streaming-json`; `opencode run --format json`; `devin -p`).
 *    Cold is a new process and its first message, warm a second message to that process, wake a new process resuming
 *    that session. Only Claude's mode takes a second message, so warm has no bare run for the others. Codex and
 *    OpenCode print an answer a message or a block at a time in every non-interactive mode they have, so their bare
 *    first token is that whole part; the model's own stamps (when it was asked, when it wrote each token) are the same
 *    for both sides whatever the output's grain, and `harness asked its model` is the like-for-like row.
 * B. Through Mako. This checkout's host (`packages/host/dist/mako-host.js`) on a scratch home and data root, the bench
 *    attached to its socket as a window is (`subscribeRuntime` in the window's live form, `mako:live-start`,
 *    `mako:live-prompt`). Cold is a new conversation's first message, warm its second, wake a message to it once the
 *    host hibernated its provider. Other conversations finish a short turn before anything is measured, so the host
 *    has launched the harness before, as an app in use has. Their next turns leave the measured conversation the
 *    oldest idle one past the host's warm limit (`warm-limit.ts`, read from `mako:provider-residency` when a wake is
 *    due, and as many of them as it says), which is what hibernates it. Wake is the plain one, a person's send to a
 *    sleeping conversation: no window here prewarms it (`mako:live-prewarm`, which a person's typing sets off), the
 *    host's own wake ahead is for an agent's message, and each wake's row says its connection at the send and whether
 *    a wake ahead was logged.
 *    The host's side of each boundary is stamped by a module loaded into it (`lib/bench-vs-bare-probe.mjs`), which
 *    hears the host's diagnostics channels: `mako:host-call`, `mako:live-stage`, `mako:native-frame`,
 *    `mako:live-driver-event`, `mako:live-batch-emitted`, `mako:stream-write` and `mako:host-log` (provider launch
 *    phases, checkpoints, residency). The model's side is stamped here, where the scripted model runs. A second
 *    reader attaches in the compact form, as the gateway's link reads: it hears the batches and none of the text a
 *    window is told ahead of them (`LiveAhead`), so its row is the pace a phone and the journal get.
 * C. Under load. B again while `--others` conversations work on the same host, each streaming text at the same pace
 *    and writing a file every few seconds for as long as the measurement runs. The bare runs of that pass run beside
 *    the same load, so the machine is as busy for both. The bare run is the yardstick: once it is itself slower than
 *    with nobody else at work (`YARDSTICK_FIRST`, `YARDSTICK_TOKEN_MS`), that count's differences are marked not
 *    measurable here and higher counts aren't run.
 * F. The host's first launch (`--scenarios first`): a new host process each run on one scratch home, nothing launched
 *    on it before, its first conversation sent the moment the host is ready; then a second new conversation on that
 *    host. A table sets each launch phase's own duration (`ProviderLaunchTrace`) for the first beside the later one:
 *    the difference is paid once a host, the rest every launch.
 *
 * `--tuning` sends what the composer sends on a normal send with nothing changed (`settingsForSend` in
 * `src/state/composer-settings.ts`): the settings `resolveSessionSettings` gives from the harness's profile
 * (`mako:harness-tuning`) for a new conversation, and from the conversation's own session settings for a later
 * message. Each run then sends once without and once with it, the order turning each run, and a block sets each step's
 * median with it beside without. The tables above it are the sends without.
 *
 * The answer: `--words` of text at `--pace` ms a token (past `LONG_ANSWER_CHARS` in one block), a write into the
 * scratch workspace by the tool each harness's sealed tests script, then more text. Each table row is a boundary, in
 * the order it was reached: when (ms after the send, the median of `--runs` with the least and the worst), how long
 * since the row before, and the same boundary bare where it has one. Under each table: the spread of the first token
 * and of the model's request, and the run from which each median stayed within `SETTLED` of where it ended. The last
 * blocks rank what Mako adds, and set the harnesses side by side. Nothing printed is assumed: a row with no
 * measurement prints `-`.
 *
 * D, the window's own cost, is `npm run bench:window` (`scripts/bench-window.mjs`): it replays what a window was sent
 * here into the production transcript in a browser. `--record <file>` keeps that for it: for each measured turn
 * through Mako, every line the window's stream carried for the conversation, as it was received and when (ms after
 * the send), and the conversation's snapshot from right before the send, which a replay starts from (a cold turn has
 * none). `--answer markdown` makes the first part of the answer several thousand characters of Markdown with fenced
 * code and a table, where `prose` (the default) is paragraphs alone. What the composer does before it calls the host
 * (`settingsForSend`, `saveMessage` in `src/state/acp-queue.ts`) is renderer time too and is measured by neither.
 *
 *   npm run bench:vs-bare -- [--harness claude,codex,grok,opencode,devin | all] [--runs 5] [--first-runs <runs>]
 *                            [--others 0,5,15,30] [--pace 20] [--words 340] [--files 300] [--gap 1500]
 *                            [--scenarios first,cold,warm,wake] [--tuning] [--json <file>] [--record <file>]
 *                            [--answer prose|markdown]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { cpus, loadavg, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import { resolveExecutable } from "@mako/host/base/executable"
import { LIVE_AHEAD_MS, LIVE_FRAME_MS } from "@mako/host/contracts/live-conversations"
import { LONG_ANSWER_CHARS, LONG_ANSWER_FLUSH_MS } from "@mako/host/conversations/answer-pace"
import { claudeRuntime } from "@mako/host/harnesses/claude/runtime"
import { resolveCodexExecutable } from "@mako/host/harnesses/codex/executable"
import { devinExecutable } from "@mako/host/harnesses/devin/executable"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { openCodeExecutable } from "@mako/host/harnesses/opencode/installation"
import { invokeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { COMPACT_LIVE_FORM, WINDOW_LIVE_FORM } from "@mako/protocol/live-form"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { resolveSessionSettings, SessionModelSchema, SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { processesUsingSync, removeScratchSync } from "./lib/scratch-processes.mjs"
import { assertScratchEnvironment, scratchKeychain, seedScratchHome, type ScratchHome } from "./scratch-harness-home.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { benchHostReady, benchHostScript, benchNow, startBenchHost, type ProbeLine } from "./lib/bench-host.ts"
import { scriptedModel, words, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "claude" },
    runs: { type: "string", default: "5" },
    "first-runs": { type: "string" },
    others: { type: "string", default: "0,5,15" },
    pace: { type: "string", default: "20" },
    words: { type: "string", default: "340" },
    files: { type: "string", default: "300" },
    gap: { type: "string", default: "1500" },
    scenarios: { type: "string", default: "cold,warm,wake" },
    tuning: { type: "boolean", default: false },
    json: { type: "string" },
    record: { type: "string" },
    answer: { type: "string", default: "prose" },
  },
})
const Scenario = z.enum(["first", "cold", "warm", "wake"])
type Scenario = z.infer<typeof Scenario>
const RUNS = z.coerce.number().int().min(1).parse(values.runs)
const FIRST_RUNS = z.coerce.number().int().min(1).parse(values["first-runs"] ?? values.runs)
const Others = z.coerce.number().int().min(0)
const OTHERS = values.others.split(",").map((count) => Others.parse(count))
const PACE = z.coerce.number().int().min(1).parse(values.pace)
const WORDS = z.coerce.number().int().min(40).parse(values.words)
const FILES = z.coerce.number().int().min(1).parse(values.files)
const GAP_MS = z.coerce.number().int().min(0).parse(values.gap)
const ASKED = values.scenarios.split(",").map((name) => Scenario.parse(name))
/** The scenarios of a pass on a host in use; `first` is a pass of its own, a new host each run. */
const SCENARIOS = ASKED.filter((scenario) => scenario !== "first")
const FIRST_LAUNCH = ASKED.includes("first")
const TUNING = values.tuning
const ANSWER = z.enum(["prose", "markdown"]).parse(values.answer)
const say = (line = "") => process.stdout.write(`${line}\n`)
const note = (line: string) => process.stderr.write(`${line}\n`)
/** Milliseconds on the machine's monotonic clock, which the host's probe and every child share. */
const now = benchNow

/* ------------------------------------------------------------------ harnesses */

/** What a line (or, for a CLI that prints the answer itself, a chunk) of a bare run's output says. */
interface BareLine { text?: string; ended?: boolean; session?: string }

/** How one harness runs by itself, in the non-interactive mode closest to a person running it with streaming output: what A needs of it. */
interface BareHarness {
  /** The CLI, as Mako's own driver finds it. */
  executable(env: NodeJS.ProcessEnv): string | null | undefined | Promise<string | null | undefined>
  /** The bare run's command, as the report names it, and the finest grain its output gives of an answer. */
  runs: string
  grain: string
  /**
   * `stdin`: one process takes each message as a line of its input, so a second message to it (warm) has a bare run.
   * `argument`: a process takes one message as an argument and exits when its turn ends, so warm has none.
   */
  input: "stdin" | "argument"
  /** Whether the session's id is the bench's to give (`given`), read from the output (`read`), or the folder's latest (`latest`). */
  session: "given" | "read" | "latest"
  args(run: { session: string | undefined; resume: boolean; prompt: string }): string[]
  /** A message, as a line of its input (`stdin`). */
  message?(text: string): string
  /** What a line of its output says; `plain`: its output is the answer's text itself, read a chunk at a time once the model was asked. */
  read(line: string): BareLine
  plain?: true
  /** The tool call that writes `content` to `path`, as the harness's sealed tests script its model. */
  write(id: string, path: string, content: string): NonNullable<ScriptedReply["call"]>
  /** The same over a file that may exist, where `write`'s tool only makes new ones (Codex's `apply_patch` adds a file). */
  rewrite?(id: string, path: string, content: string): NonNullable<ScriptedReply["call"]>
  /** Mako's mode with no approvals, so the write runs unasked on both sides. */
  mode: string
  /** What the CLI's own sign-in needs in a scratch home beyond `pointAt`, for the bare run and for what the host runs of the CLI itself (its profile's discovery). */
  seal?(home: string, url: string): void
}

const ClaudeLine = z.union([
  z.object({ type: z.literal("stream_event"), event: z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }) }) }).transform((line) => ({ text: line.event.delta.text })),
  z.object({ type: z.literal("result") }).transform(() => ({ ended: true })),
])
const CodexLine = z.union([
  z.object({ type: z.literal("thread.started"), thread_id: z.string() }).transform((line) => ({ session: line.thread_id })),
  z.object({ type: z.literal("item.completed"), item: z.object({ type: z.literal("agent_message"), text: z.string() }) }).transform((line) => ({ text: line.item.text })),
])
const GrokLine = z.union([
  z.object({ type: z.literal("text"), data: z.string() }).transform((line) => ({ text: line.data })),
  z.object({ type: z.literal("end") }).transform(() => ({ ended: true })),
])
const OpenCodeLine = z.union([
  z.object({ type: z.literal("text"), sessionID: z.string(), part: z.object({ text: z.string() }) }).transform((line) => ({ text: line.part.text, session: line.sessionID })),
  z.object({ sessionID: z.string() }).transform((line) => ({ session: line.sessionID })),
])
/** A line of JSON read by `schema`; anything else says nothing. */
function jsonLine(schema: z.ZodType<BareLine>, line: string): BareLine {
  try { return schema.safeParse(JSON.parse(line)).data ?? {} } catch { return {} }
}
/** A shell command that writes `content` to `path`; neither holds a quote. */
const shellWrite = (path: string, content: string) => `printf %s '${content}' > '${path}'`
/** Mako's mode id for full access, which each of these harnesses' drivers maps to its own. */
const FULL_ACCESS = "access:full"

const BARE = {
  claude: {
    executable: (env) => claudeRuntime(env)?.executable,
    runs: "`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` (the build Mako runs)",
    grain: "each token (`stream_event` text deltas)",
    input: "stdin",
    session: "given",
    args: ({ session, resume }) => [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--dangerously-skip-permissions", ...(resume ? ["--resume", session ?? ""] : ["--session-id", session ?? ""]),
    ],
    message: (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
    read: (line) => jsonLine(ClaudeLine, line),
    write: (id, path, content) => ({ id, name: "Write", arguments: { file_path: path, content } }),
    mode: "bypassPermissions",
  },
  codex: {
    executable: (env) => resolveCodexExecutable(env),
    runs: "`codex exec --json --dangerously-bypass-approvals-and-sandbox` (wake: `codex exec resume <thread>`)",
    grain: "each whole message (`item.completed` of an `agent_message`): `codex exec` prints no text deltas in either output form",
    input: "argument",
    session: "read",
    args: ({ session, resume, prompt }) => ["exec", ...(resume ? ["resume", session ?? "--last"] : []), "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt],
    read: (line) => jsonLine(CodexLine, line),
    write: (id, path, content) => ({ id, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch\n` }),
    rewrite: (id, path, content) => ({ id, name: "exec_command", arguments: { cmd: shellWrite(path, content) } }),
    mode: FULL_ACCESS,
  },
  grok: {
    executable: (env) => resolveExecutable("grok", env),
    runs: "`grok -p <message> --output-format streaming-json --permission-mode bypassPermissions` (wake: `-r <session>`)",
    grain: "each token (`text` lines)",
    input: "argument",
    session: "given",
    args: ({ session, resume, prompt }) => ["-p", prompt, "--output-format", "streaming-json", "--permission-mode", "bypassPermissions", ...(resume ? ["-r", session ?? ""] : ["-s", session ?? ""])],
    read: (line) => jsonLine(GrokLine, line),
    write: (id, path, content) => ({ id, name: "write", arguments: { file_path: path, content } }),
    mode: FULL_ACCESS,
  },
  opencode: {
    executable: (env) => openCodeExecutable(env),
    runs: "`opencode run --standalone --format json --auto <message>` (a server of its own rather than the background service, so nothing outlives the run; wake: `--session <id>`)",
    grain: "each whole block of text (`text` events carry a finished part): `opencode run` prints no text deltas in either format",
    input: "argument",
    session: "read",
    args: ({ session, resume, prompt }) => ["run", "--standalone", "--format", "json", "--auto", ...(resume && session ? ["--session", session] : []), prompt],
    read: (line) => jsonLine(OpenCodeLine, line),
    write: (id, path, content) => ({ id, name: "shell", arguments: { command: shellWrite(path, content) } }),
    mode: FULL_ACCESS,
  },
  devin: {
    executable: (env) => devinExecutable(env),
    runs: "`devin -p <message> --permission-mode dangerous --respect-workspace-trust false` (wake: `-c`, the folder's latest conversation)",
    grain: "each token, as plain text (`-p` has no structured output; what it prints once its model was asked is the answer)",
    input: "argument",
    session: "latest",
    args: ({ resume, prompt }) => ["-p", prompt, "--permission-mode", "dangerous", "--respect-workspace-trust", "false", ...(resume ? ["-c"] : [])],
    // The line's end the CLI prints after its answer isn't the answer's.
    read: (chunk) => chunk === "\n" ? {} : { text: chunk },
    plain: true,
    write: (id, path, content) => ({ id, name: "exec", arguments: { command: shellWrite(path, content) } }),
    // Devin's session lists its own modes by their native ids; `bypass` is the one its source places at full access.
    mode: "bypass",
    // `devin -p` signs in from its key file alone (`devin auth status` reads no key from the environment, which its ACP
    // server does): a made-up key for the stand-in's address, in the scratch home only.
    seal: (home, url) => {
      mkdirSync(join(home, ".local", "share", "devin"), { recursive: true })
      writeFileSync(join(home, ".local", "share", "devin", "credentials.toml"), `windsurf_api_key = "bench-vs-bare-not-a-key"\napi_server_url = "${url}"\n`, { mode: 0o600 })
    },
  },
  cursor: { skip: "it can't be pointed at the scripted model: `pointAt` has no stand-in for Cursor's service, which its SDK reaches over its own protocol with the person's sign-in, and no test here runs it sealed" },
} satisfies Record<string, BareHarness | { skip: string }>

/** A table's entry for a name that came from outside it, if it has one. */
function entry<Value>(table: Readonly<Record<string, Value>>, name: string): Value | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/* ------------------------------------------------------------------- the answer */

const VOCABULARY = "the stream of a long answer lands one word after another and each batch carries what a reader sees next while the host keeps its journal and the window paints every frame it can so nothing waits behind work that could run later".split(" ")
/** `count` words of prose in paragraphs, the same every run: `seed` only moves where it starts in the vocabulary. */
function prose(count: number, seed: number): string {
  let text = ""
  for (let index = 0; index < count; index += 1) {
    const word = VOCABULARY[(index * 7 + seed) % VOCABULARY.length]!
    const last = index === count - 1
    const paragraph = (index + 1) % 85 === 0
    const sentence = (index + 1) % 17 === 0
    text += `${index % 17 === 0 ? word[0]!.toUpperCase() + word.slice(1) : word}${last || sentence ? "." : ""}${last ? "" : paragraph ? "\n\n" : " "}`
  }
  return text
}
/**
 * A long answer as Markdown, the same every run: prose around a fenced block of code, a numbered list, a table and a
 * second fenced block, which a window parses and draws as it streams. It starts on a word, so `words` covers all of it.
 */
function markdown(count: number, seed: number): string {
  const part = Math.max(40, Math.round(count / 3))
  const word = (index: number) => VOCABULARY[(index * 5 + seed) % VOCABULARY.length]!
  const code = Array.from({ length: 14 }, (_, index) => `  const ${word(index)}${index} = frames[${index}] ?? ${index * 16}`).join("\n")
  const steps = Array.from({ length: 6 }, (_, index) => `${index + 1}. ${prose(9, index + seed)}`).join("\n")
  const rows = Array.from({ length: 8 }, (_, index) => `| ${word(index)} | ${index * 50} | ${index * 16} | ${prose(4, index)} |`).join("\n")
  const commands = Array.from({ length: 6 }, (_, index) => `npm run bench:${word(index)} -- --runs ${index + 1} --json out-${index}.json`).join("\n")
  return [
    "## What the stream does",
    prose(part, seed),
    `\`\`\`ts\nexport function paint(frames: number[]): number {\n${code}\n  return frames.length\n}\n\`\`\``,
    prose(part, seed + 5),
    "### Each step",
    steps,
    `| Reader | Batch ms | Ahead ms | Sees |\n| --- | ---: | ---: | --- |\n${rows}`,
    prose(part, seed + 9),
    `\`\`\`bash\n${commands}\n\`\`\``,
    prose(part, seed + 13),
  ].join("\n\n")
}
const FIRST = ANSWER === "markdown" ? markdown(WORDS, 3) : prose(WORDS, 3)
const SECOND = prose(Math.max(20, Math.round(WORDS / 4)), 11)
const TOKENS = [...words(FIRST), ...words(SECOND)]
const FIRST_TOKENS = words(FIRST).length
/** Where each token ends in the answer's text, so a reader's count of characters says which tokens it holds. */
const ENDS = TOKENS.reduce<number[]>((ends, token) => [...ends, (ends.at(-1) ?? 0) + token.length], [])
const LOAD_STEP = Array.from({ length: 120 }, (_, index) => `~load${(index + 1) % 8 === 0 ? "\n\n" : " "}`).join("")

const ModelDelta = z.union([
  z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }) }).transform((event) => event.delta.text),
  z.object({ type: z.literal("response.output_text.delta"), delta: z.string() }).transform((event) => event.delta),
  // Chat Completions (Grok's wire), and the Windsurf stand-in's text (Devin's).
  z.object({ object: z.literal("chat.completion.chunk"), choices: z.tuple([z.object({ delta: z.object({ content: z.string().min(1) }) })]) }).transform((event) => event.choices[0].delta.content),
  z.object({ type: z.literal("delta_text"), delta: z.string() }).transform((event) => event.delta),
])

/** One measured turn as the model saw it: when it heard each request, and when it wrote each token. */
interface ModelTurn { tag: string; file: string; heard: number[]; tokens: number[] }

/* --------------------------------------------------------------- what a run keeps */

interface Mark { key: string; at: number }
/** `first`: a new host each run, nothing launched on it before; `load`: a host in use, `others` conversations at work. */
type Pass = "first" | "load"
interface Sample {
  harness: string
  pass: Pass
  side: "bare" | "mako"
  scenario: Scenario
  others: number
  run: number
  /** Whether the send carried the composer's `tuning` (`--tuning`); never for a bare run. */
  tuned: boolean
  /** The send: the call to the host, or the process's start or the write to its input. */
  sent: number
  /** Each boundary reached, in ms after `sent`. */
  marks: Mark[]
  /** For each token of the answer, ms after `sent`: written by the model, out of the harness, at the reader. */
  model: number[]
  out: number[]
  reader: number[]
  /** The same for a reader of the batches alone, as a phone's link and the journal get them; empty bare. */
  device: number[]
  deviceArrivals: number[]
  /** When each batch (or bare, each output chunk) carrying answer text reached the reader. */
  arrivals: number[]
  /** Model's last token before the write to the request carrying its result. */
  toolMs: number | undefined
  notes: Record<string, string | number | null>
  raw: z.infer<typeof ProbeLine>[]
  batches: { at: number; revision: number; bytes: number; characters: number }[]
}

const Update = z.object({ kind: z.string(), id: z.string().optional(), text: z.string().optional(), replace: z.boolean().optional() }).loose()
const BatchBody = z.object({ id: z.string(), revision: z.number(), updates: z.array(Update).optional() }).loose()
const AheadLine = z.object({ type: z.literal("live-ahead"), ahead: z.object({ revision: z.number(), more: z.string() }) })
const BatchLine = z.union([z.object({ type: z.literal("live-batch"), batch: BatchBody }).loose().transform((line) => line.batch), BatchBody])
const Words = z.string()
const Amount = z.number()
const Catalog = z.object({ ready: z.boolean() }).loose()
const LiveState = z.object({ status: z.string(), connection: z.string().optional() }).loose()
const PhaseFields = z.object({ conversation: z.string(), phase: z.string(), state: z.string(), attempt: z.string().optional(), step: z.number().optional() }).loose()
const CheckpointFields = z.object({ request: z.string(), kind: z.string().optional(), heldMs: z.number().nullable().optional(), savedMs: z.number().optional(), waitedMs: z.number().optional() }).loose()
/** `mako:provider-residency`: the idle providers the host keeps warm now. */
const Residency = z.object({ warmLimit: z.number().int().min(1) }).loose()
/** `mako:harness-tuning`: the harness's models and defaults in a folder, which the composer resolves a send's settings against. */
const Profile = z.object({ available: z.boolean(), pending: z.boolean().optional(), models: z.array(SessionModelSchema), settings: SessionSettingsSchema.optional(), error: z.string().optional(), configurationError: z.string().optional() }).loose()
/** What a conversation's snapshot says its session runs on. */
const SessionOf = z.object({ session: z.object({ settings: SessionSettingsSchema.optional() }).loose() }).loose()
const Rss = z.coerce.number()
/** What another conversation's file holds: the step that wrote it. */
const StepFile = z.string().regex(/^step \d+$/).transform((text) => Number(text.slice(5)))

/** How much answer text a reader holds, from the updates it was given: each block's length, appended to or replaced. */
class Held {
  private readonly blocks: { kind: string; id: string | undefined; length: number }[] = []
  take(kind: string, id: string | undefined, length: number, replace: boolean): void {
    if (kind === "user") return
    const last = this.blocks.at(-1)
    if (kind === "more") {
      if (last) last.length += length
      return
    }
    if (kind !== "text" && kind !== "thinking") {
      this.blocks.push({ kind, id, length: 0 })
      return
    }
    const block = id === undefined ? (last?.kind === kind && last.id === undefined ? last : undefined) : this.blocks.findLast((each) => each.kind === kind && each.id === id)
    if (!block) this.blocks.push({ kind, id, length })
    else block.length = replace ? length : block.length + length
  }
  get characters(): number {
    return this.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.length : 0), 0)
  }
}

/** For each token, when a reader first held all of it, given how many characters it held at each moment. */
function tokenTimes(held: readonly { at: number; characters: number }[]): number[] {
  const times: number[] = []
  let next = 0
  for (const { at, characters } of held) while (next < ENDS.length && characters >= ENDS[next]!) times[next++] = at
  return times
}

/* -------------------------------------------------------------------- cleanup */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-vs-bare-")))
const children = new Set<ChildProcess>()
const homes: ScratchHome[] = []
const closers: (() => void | Promise<void>)[] = []
let finishing: Promise<never> | undefined

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs)
  await exited.catch(() => undefined)
  clearTimeout(timer)
}

/** Ends what a stopped host or CLI left running in a scratch folder: named, then ended. Whether anything was left. */
async function endLeft(folder: string, who: string): Promise<boolean> {
  let any = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const left = processesUsingSync(folder)
    if (!left.length) break
    any = true
    note(`still running in ${who} after its owner stopped: ${left.map(({ pid }) => pid).join(", ")}; ending ${attempt ? "them again" : "them"}`)
    for (const { pid } of left) try { process.kill(pid, "SIGKILL") } catch { /* It ended meanwhile. */ }
    await delay(500)
  }
  return any
}

/** Stops everything this run started and removes its scratch, however the run ends. */
function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    let failed = false
    const began = Date.now()
    await Promise.all([...children].map((child) => stopChild(child, 20_000)))
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => { failed = true })
    // What a stopped host or CLI left running in the scratch folders is this run's too.
    await endLeft(root, "the scratch folder")
    for (const home of homes) home.dispose()
    try { removeScratchSync(root) } catch (error) {
      failed = true
      note(`scratch kept: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Date.now() - began > 15_000) note(`cleaning up took ${Math.round((Date.now() - began) / 1000)} s`)
    process.exit(code || (failed ? 1 : 0))
  })()
  return finishing
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void finish(130))

/* ---------------------------------------------------------------------- setup */

function makeProject(path: string): string {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Bench", "-c", "user.email=bench", ...args], { cwd: path, stdio: "ignore" })
  git("init", "-q")
  for (let index = 0; index < FILES; index += 1) {
    const folder = join(path, "src", `part${index % 20}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line\n".repeat(40)}`)
  }
  git("add", "-A")
  git("commit", "-qm", "initial")
  return path
}

/** A scratch home with no sign-in of the person's in it, pointed at the scripted model. */
async function sealedHome(folder: string, harness: string, url: string): Promise<ScratchHome> {
  mkdirSync(folder, { recursive: true })
  const home = seedScratchHome(folder, {})
  homes.push(home)
  mkdirSync(join(folder, "tmp"), { recursive: true })
  home.env.TMPDIR = join(folder, "tmp")
  await pointAt(harness, { root: folder, home: home.home, project: folder, env: home.env, scrub: (text) => text }, url, home.env, "bench-vs-bare")
  assertScratchEnvironment(home.env, `bench:vs-bare ${harness}`)
  return home
}

/** What the processes at work in a scratch folder hold in memory now, in MB, and how many they are. */
function footprint(folder: string) {
  const pids = processesUsingSync(folder).map(({ pid }) => pid)
  if (!pids.length) return { processes: 0, megabytes: 0 }
  let kilobytes = 0
  try {
    for (const line of execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" }).split("\n")) kilobytes += Rss.safeParse(line.trim() || undefined).data ?? 0
  } catch { /* Every one of them ended meanwhile. */ }
  return { processes: pids.length, megabytes: Math.round(kilobytes / 1024) }
}

/* ------------------------------------------------------------------ the model */

/** The harness whose turns the model is answering: its tool call for a write. */
let cli: BareHarness | undefined
const turns = new Map<string, ModelTurn>()
const steps = new Map<string, number>()
let recording: ModelTurn | undefined
let loadStopped = false
let loadFolder = root
let sequence = 0

function reply(heard: string): ScriptedReply {
  const tag = [...heard.matchAll(/VS([MLF])-(\w+)/g)].at(-1)
  if (!tag || !cli) return { text: "~untagged" }
  const [name, kind] = tag
  // A call's id comes back with its result, after the message: it holds no tag, or it would be read as one.
  const step = steps.get(name) ?? 0
  steps.set(name, step + 1)
  if (kind === "F") return { text: "~ok" }
  // Four files a conversation, written over in turn, so the load folder doesn't grow with the run.
  if (kind === "L") return loadStopped ? { text: "~stopped" } : { text: LOAD_STEP, pace: PACE, call: (cli.rewrite ?? cli.write)(`call_${name.slice(4)}_${step}`, join(loadFolder, `${name}-${step % 4}.txt`), `step ${step}`) }
  const turn = turns.get(name)
  if (!turn) return { text: "~unknown" }
  turn.heard.push(now())
  if (step === 0) return { text: FIRST, pace: PACE, call: cli.write(`call_${name.slice(4)}`, turn.file, "written by the bench") }
  return step === 1 ? { text: SECOND, pace: PACE } : { text: "~extra" }
}
function sent(event: JsonObject): void {
  const text = ModelDelta.safeParse(event).data
  if (text !== undefined && !text.startsWith("~")) recording?.tokens.push(now())
}
function turnFor(project: string): ModelTurn {
  const tag = `VSM-t${++sequence}`
  const turn: ModelTurn = { tag, file: join(project, `bench-out-${sequence}.txt`), heard: [], tokens: [] }
  turns.set(tag, turn)
  recording = turn
  return turn
}
const prompt = (turn: ModelTurn) => `${turn.tag} Explain what you are about to do, write the file, then say what you did.`
async function until(what: string, done: () => boolean | Promise<boolean>, timeoutMs = 180_000, everyMs = 25): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !(await done()); await delay(everyMs)) if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
}

/** The stand-in a harness's model requests go to: Windsurf's API server for Devin, the scripted model for the rest. One of each a run. */
const standIns = new Map<string, Promise<{ url: string }>>()
function standIn(harness: string): Promise<{ url: string }> {
  const kind = harness === "devin" ? "windsurf" : "model"
  const made = standIns.get(kind) ?? (async () => {
    const model = kind === "windsurf" ? await scriptedWindsurf({ aside: "~aside", reply, sent }) : await scriptedModel({ answers: SCRIPTED_GETS, aside: "~aside", reply, sent })
    closers.push(() => model.close())
    return model
  })()
  standIns.set(kind, made)
  return made
}

/* ----------------------------------------------------------------------- a host */

const MARK = "bbbbbbbb"
interface Heard { at: number; conversation: string; payload: string }
/** This checkout's host on a scratch home and data root, the bench attached to it as a window and as a reader of the batches alone. */
interface Host {
  dataRoot: string
  client: string
  call(channel: string, ...args: unknown[]): ReturnType<typeof invokeRuntime>
  probe: z.infer<typeof ProbeLine>[]
  received: Heard[]
  batchesOnly: Heard[]
  state(id: string): Promise<z.infer<typeof LiveState>>
  idle(id: string): Promise<boolean>
  /** From its process's start until it answered ready with its catalog read and both streams attached. */
  readyMs: number
  /** What its own log ends with, for a pass that couldn't be measured. */
  logTail(): string | undefined
  stop(): Promise<void>
}

async function startHost(folder: string, home: ScratchHome): Promise<Host> {
  const dataRoot = join(folder, "data")
  assertScratchEnvironment({ ...home.env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: runtimeLocation(dataRoot).socket }, "bench:vs-bare host")
  const began = now()
  // The host and its probe, as `bench:actions` starts them too (`lib/bench-host.ts`).
  const started = startBenchHost({ dataRoot, env: home.env, mark: MARK })
  const { child: host, socket, probe } = started
  children.add(host)
  host.once("exit", () => children.delete(host))
  let stopping = false
  const unsubscribes: (() => void)[] = []
  const stop = async () => {
    stopping = true
    for (const unsubscribe of unsubscribes) unsubscribe()
    await stopChild(host, 30_000)
    // The next host starts with none of this one's harness processes still at work.
    for (const { pid } of processesUsingSync(folder)) try { process.kill(pid, "SIGKILL") } catch { /* It ended meanwhile. */ }
  }
  const logTail = () => {
    const log = join(dataRoot, "logs", "host.log")
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => !line.includes(" provider-startup phase ")).slice(-40).map((line) => line.slice(0, 320)).join("\n") : undefined
  }
  try {
    await benchHostReady(started)
    const client = randomUUID()
    const call = (channel: string, ...args: unknown[]) => invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 300_000 })
    await until("the host to read its catalog", async () => Catalog.parse(await call("mako:threads")).ready, 180_000, 250)
    const received: Heard[] = []
    const batchesOnly: Heard[] = []
    let streaming = false
    unsubscribes.push(subscribeRuntime(socket, client, (packet) => {
      const at = now()
      if (packet.channel === "ready") streaming = true
      else if (packet.channel === "event" && (packet.type === "live-batch" || packet.type === "live-ahead") && packet.conversation?.startsWith(MARK)) received.push({ at, conversation: packet.conversation, payload: packet.payload })
    }, (end) => { if (!stopping) note(`the bench's event stream ended: ${end.why}`) }, { history: true, live: WINDOW_LIVE_FORM }))
    // A second reader that says the compact form, as the gateway's link does: it hears the batches and nothing ahead
    // of them, so its pace is the one a phone and the journal get.
    let reading = false
    unsubscribes.push(subscribeRuntime(socket, randomUUID(), (packet) => {
      const at = now()
      if (packet.channel === "ready") reading = true
      else if (packet.channel === "event" && packet.type === "live-batch" && packet.conversation?.startsWith(MARK)) batchesOnly.push({ at, conversation: packet.conversation, payload: packet.payload })
    }, () => undefined, { history: true, live: COMPACT_LIVE_FORM }))
    await until("the bench's event streams", () => streaming && reading, 30_000)
    const state = async (id: string) => LiveState.parse(await call("mako:live-state", id))
    const idle = async (id: string) => (await state(id)).status !== "running" && (await state(id)).status !== "starting"
    return { dataRoot, client, call, probe, received, batchesOnly, state, idle, readyMs: now() - began, logTail, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/* ------------------------------------------------------------------ one harness */

/** One measured turn as `--record` keeps it: the window's lines in order, each when it came (ms after the send) and as it came. */
interface RecordedTurn {
  scenario: Scenario; others: number; run: number; conversation: string
  /** `mako:live-snapshot` right before the send; null for a cold turn, whose conversation didn't exist yet. */
  snapshot: Awaited<ReturnType<typeof invokeRuntime>>
  lines: { at: number; payload: string }[]
}
const recorded: RecordedTurn[] = []
/** What the yardstick, the bare run, read in one pass: what a later pass's is held against. */
interface Yardstick {
  others: number; first: number | undefined; token: number | undefined; pace: number | undefined; megabytes: number; processes: number
  /** The fewest steps any other conversation had asked its model for by the pass's end, and the earliest "latest step" any one's files held. */
  steps: number | undefined; files: number | undefined
}
/** A bare run under load is no yardstick once its first token is this much later than with nobody else at work, or each token this many ms later. */
const YARDSTICK_FIRST = 1.25
const YARDSTICK_TOKEN_MS = PACE

async function measure(harness: string, bare: BareHarness): Promise<{ samples: Sample[]; yardsticks: Yardstick[]; unmeasured: string[] }> {
  cli = bare
  const model = await standIn(harness)
  const base = join(root, harness)

  /* A: the harness by itself. */
  const bareHome = await sealedHome(join(base, "bare"), harness, model.url)
  bare.seal?.(bareHome.home, model.url)
  const bareProject = makeProject(join(base, "bare", "project"))
  const found = await bare.executable(bareHome.env)
  if (!found) throw new Error(`${harness}'s CLI wasn't found`)
  const executable: string = found
  async function bareRun(pass: Pass, others: number, run: number, scenarios: readonly Scenario[]): Promise<Sample[]> {
    const samples: Sample[] = []
    let session: string | undefined = bare.session === "given" ? randomUUID() : undefined
    let child: ChildProcess | undefined
    let turn: ModelTurn | undefined
    let heard: { at: number; text?: string; ended?: boolean; first: boolean }[] = []
    const start = (resume: boolean, text: string): ChildProcess => {
      assertScratchEnvironment(bareHome.env, `bare ${harness}`)
      const started: ChildProcess = spawn(executable, bare.args({ session, resume, prompt: text }), { cwd: bareProject, env: bareHome.env, stdio: [bare.input === "stdin" ? "pipe" : "ignore", "pipe", "ignore"] })
      children.add(started)
      started.once("exit", () => children.delete(started))
      let pending = ""
      started.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        const at = now()
        // A CLI that prints the answer itself: what it says before its model was asked (a greeting) isn't the answer.
        if (bare.plain) {
          const said = { at, first: true }
          if (turn?.heard.length) Object.assign(said, bare.read(chunk))
          return void heard.push(said)
        }
        const lines = (pending + chunk).split("\n")
        pending = lines.pop() ?? ""
        lines.forEach((line, index) => {
          const { session: named, ...said } = bare.read(line)
          if (bare.session === "read") session ??= named
          heard.push({ at, first: index === 0, ...said })
        })
      })
      return started
    }
    for (const scenario of scenarios) {
      const fresh = scenario === "cold" || scenario === "first"
      if (!fresh && !samples.length) continue
      // A process that takes one message has no second message to take.
      if (scenario === "warm" && bare.input === "argument") continue
      turn = turnFor(bareProject)
      heard = []
      if (!fresh) await delay(GAP_MS)
      // A wake resumes in a new process, and a second new conversation is a new process and session too.
      if (scenario !== "warm" && child) {
        child.stdin?.end()
        await stopChild(child, 5_000)
      }
      if (fresh && samples.length) session = bare.session === "given" ? randomUUID() : undefined
      const sentAt = now()
      if (scenario !== "warm") child = start(scenario === "wake", prompt(turn))
      const running = child
      if (!running) continue
      if (bare.message) running.stdin?.write(bare.message(prompt(turn)))
      await until(`bare ${harness} to finish its ${scenario} turn`, () => {
        if (heard.some((line) => line.ended)) return true
        if (running.exitCode === null && running.signalCode === null) return false
        if (bare.input === "argument" && running.exitCode === 0) return true
        throw new Error(`bare ${harness} exited (${running.exitCode ?? running.signalCode}) before its ${scenario} turn ended`)
      })
      const held = new Held()
      const out = heard.flatMap((line) => {
        if (line.text === undefined) return []
        held.take("text", undefined, line.text.length, false)
        return [{ at: line.at, characters: held.characters }]
      })
      const harnessTimes = tokenTimes(out)
      const marks: Mark[] = []
      const mark = (key: string, at: number | undefined) => { if (at !== undefined) marks.push({ key, at: at - sentAt }) }
      mark("frame", heard[0]?.at)
      mark("modelHeard", turn.heard[0])
      mark("modelFirst", turn.tokens[0])
      mark("textFrame", harnessTimes[0])
      mark("received", harnessTimes[0])
      samples.push({
        harness, pass, side: "bare", scenario, others, run, tuned: false, sent: sentAt, marks, model: turn.tokens.map((at) => at - sentAt), out: harnessTimes.map((at) => at - sentAt), reader: harnessTimes.map((at) => at - sentAt), device: [], deviceArrivals: [],
        arrivals: heard.filter((line) => line.text !== undefined && line.first).map((line) => line.at - sentAt),
        toolMs: turn.heard[1] === undefined || turn.tokens[FIRST_TOKENS - 1] === undefined ? undefined : turn.heard[1] - turn.tokens[FIRST_TOKENS - 1]!,
        notes: { characters: held.characters, expected: ENDS.at(-1) ?? 0, wrote: existsSync(turn.file) ? "yes" : "no" }, raw: [], batches: [],
      })
    }
    if (child) {
      child.stdin?.end()
      await stopChild(child, 5_000)
    }
    return samples
  }

  /** The composer's `tuning` for a send with nothing changed: what `settingsForSend` resolves from the harness's profile and, for a conversation that exists, its session's own settings. */
  async function tuningFor(host: Host, project: string, id: string | undefined): Promise<SessionSettings | undefined> {
    let profile = Profile.parse(await host.call("mako:harness-tuning", harness, project))
    for (const deadline = Date.now() + 60_000; profile.pending && Date.now() < deadline; await delay(250)) profile = Profile.parse(await host.call("mako:harness-tuning", harness, project))
    if (!profile.available || profile.pending) throw new Error(`${harness}'s profile isn't available, so the composer could resolve no settings: ${profile.error ?? profile.configurationError ?? "still pending"}`)
    const session = id === undefined ? undefined : SessionOf.parse(await host.call("mako:live-snapshot", id)).session.settings
    return resolveSessionSettings({ models: profile.models, context: id === undefined ? "new" : "existing", phase: id === undefined ? "launch" : "turn", defaults: profile.settings, session }).settings
  }

  /** One measured turn through Mako: a new conversation's first message (`first`, `cold`) or a message to `id`. */
  async function makoTurn(host: Host, input: { pass: Pass; scenario: Scenario; others: number; run: number; id: string; project: string; tuned: boolean; notes: Sample["notes"] }): Promise<Sample> {
    const { pass, scenario, others, run, id, project, notes } = input
    const fresh = scenario === "cold" || scenario === "first"
    // The composer holds the profile and the session before a send, so resolving them is before the clock starts; how
    // long the host took to answer here is kept, since on a new host that read is the profile's first.
    const resolving = now()
    // A harness whose profile the host can't read in this sealed home has no settings for a composer to send: said
    // once, and its sends go without from there.
    const tuning = !input.tuned || tuningOff !== undefined ? undefined : await tuningFor(host, project, fresh ? undefined : id).catch((error: Error) => {
      tuningOff = error.message
      note(`  ${harness}: --tuning isn't sent: ${tuningOff}`)
      return undefined
    })
    const tuned = input.tuned && tuningOff === undefined
    if (tuned) {
      notes.tuning = JSON.stringify(tuning ?? null)
      notes.tuningReadMs = now() - resolving
    }
    // For `--record`: the conversation as a window opening it now would hold it, and its stream's lines from here.
    const recordFrom = host.received.length
    const before = values.record === undefined || fresh ? null : await host.call("mako:live-snapshot", id)
    const turn = turnFor(project)
    const request = randomUUID()
    const probeFrom = host.probe.length
    const receivedFrom = host.received.length
    const batchesFrom = host.batchesOnly.length
    const sentAt = now()
    if (fresh) await host.call("mako:live-start", harness, project, { conversationId: id, modeId: bare.mode, title: "Bench vs bare", ...(tuning && { tuning }), initialRequest: { id: request, text: prompt(turn), attachments: [] } })
    else await host.call("mako:live-prompt", id, request, prompt(turn), [], ...(tuning ? [tuning] : []))
    const answered = now()
    let looked = 0
    await until(`Mako's ${scenario} turn to stream its answer`, async () => {
      // Twice a second, so a start that failed says why rather than timing out.
      if (Date.now() - looked > 500) {
        looked = Date.now()
        const session = await host.state(id)
        if (session.status === "failed" || session.status === "closed") throw new Error(`Mako's ${scenario} turn didn't run: its session is ${session.status}: ${Words.safeParse(session.error).data ?? "no reason given"}`)
      }
      return turn.tokens.length >= TOKENS.length
    })
    await until(`Mako's ${scenario} turn to end`, () => host.idle(id), 120_000, 50)
    // The turn's last batches and its checkpoint's line are a moment behind its status.
    await until("the turn's checkpoint to be saved", () => host.probe.slice(probeFrom).some((line) => line.s === "log" && line.scope === "checkpoints" && line.fields?.request === request), 15_000, 50).catch(() => undefined)
    await delay(150)
    const sample = makoSample({ harness, pass, scenario, others, run, tuned, sent: sentAt, answered, turn, request, id, client: host.client, notes, lines: host.probe.slice(probeFrom), heard: host.received.slice(receivedFrom), batchesOnly: host.batchesOnly.slice(batchesFrom) })
    if (values.record !== undefined && !tuned) recorded.push({ scenario, others, run, conversation: id, snapshot: before ?? null, lines: host.received.slice(recordFrom).filter((line) => line.conversation === id).map((line) => ({ at: line.at - sentAt, payload: line.payload })) })
    return sample
  }
  /** With `--tuning`, each run sends once without and once with it, the order turning each run. */
  const variants = (run: number) => !TUNING || tuningOff !== undefined ? [false] : run % 2 ? [false, true] : [true, false]
  let tuningOff: string | undefined

  /* B and C: through Mako on a host in use, with `others` conversations at work beside it. */
  async function loadPass(others: number): Promise<{ samples: Sample[]; megabytes: number; processes: number; steps: number | undefined; files: number | undefined }> {
    const folder = join(base, `n${others}`)
    loadStopped = false
    const home = await sealedHome(folder, harness, model.url)
    bare.seal?.(home.home, model.url)
    scratchKeychain(home.home)
    const project = makeProject(join(folder, "project"))
    loadFolder = makeProject(join(folder, "load"))
    const host = await startHost(folder, home)
    try {
      // One after another, each once the one before asked its model: two started in the same moment in one folder
      // didn't both run on every harness, and a person opens them one at a time.
      const load = Array.from({ length: others }, (_, index) => ({ id: randomUUID(), tag: `VSL-${harness}n${others}i${index}` }))
      const running = (each: { id: string; tag: string }, what: string, asked: number) => until(what, async () => {
        const session = await host.state(each.id)
        if (session.status === "failed" || session.status === "closed") throw new Error(`${what}: its session is ${session.status}: ${Words.safeParse(session.error).data ?? "no reason given"}`)
        return (steps.get(each.tag) ?? 0) >= asked
      }, 180_000, 100)
      for (const each of load) {
        await host.call("mako:live-start", harness, loadFolder, { conversationId: each.id, modeId: bare.mode, title: `Load ${each.tag}`, initialRequest: { id: randomUUID(), text: `${each.tag} keep working`, attachments: [] } })
        await running(each, "another conversation to start streaming", 1)
      }
      for (const each of load) await running(each, `${others} other conversations to be streaming and writing`, 2)
      if (others) note(`  ${others} other conversations are streaming and writing`)
      // Conversations that finish a short turn first: the host has then launched this harness before, as an app in use
      // has, and their later turns leave a measured conversation the oldest idle one past the warm limit, so its
      // provider hibernates. The limit is the host's own (`warm-limit.ts`), read when a wake is due.
      const fillers: { id: string; tag: string }[] = []
      const fill = async (count: number) => {
        const added = Array.from({ length: Math.max(0, count - fillers.length) }, (_, index) => ({ id: randomUUID(), tag: `VSF-${harness}n${others}i${fillers.length + index}` }))
        // One after another, as a person opens conversations, and one that didn't start says why.
        for (const each of added) {
          await host.call("mako:live-start", harness, loadFolder, { conversationId: each.id, modeId: bare.mode, title: `Filler ${each.tag}`, initialRequest: { id: randomUUID(), text: `${each.tag} say ok`, attachments: [] } })
          await until("a filler conversation's first turn", async () => {
            const session = await host.state(each.id)
            if (session.status === "failed" || session.status === "closed") throw new Error(`a filler conversation didn't run: its session is ${session.status}: ${Words.safeParse(session.error).data ?? "no reason given"}`)
            return (steps.get(each.tag) ?? 0) >= 1 && session.status !== "running" && session.status !== "starting"
          }, 180_000, 200)
        }
        fillers.push(...added)
      }
      await fill(2)
      const held = footprint(folder)
      const samples: Sample[] = []
      for (let run = 1; run <= RUNS; run += 1) {
        note(`  ${harness} run ${run}/${RUNS} with ${others} others: bare`)
        samples.push(...await bareRun("load", others, run, SCENARIOS))
        for (const tuned of variants(run)) {
          note(`  ${harness} run ${run}/${RUNS} with ${others} others: through Mako${tuned ? ", with the composer's tuning" : ""}`)
          const id = `${MARK}${randomUUID().slice(8)}`
          let started = false
          for (const scenario of SCENARIOS) {
            if (scenario !== "cold" && !started) continue
            const notes: Sample["notes"] = {}
            if (scenario !== "cold") await delay(GAP_MS)
            const asked = host.probe.length
            if (scenario === "wake") {
              const limit = Residency.parse(await host.call("mako:provider-residency")).warmLimit
              await fill(Math.max(2, limit))
              const askedAt = Date.now()
              for (const each of fillers) await host.call("mako:live-prompt", each.id, randomUUID(), `${each.tag} say ok again`, [])
              const hibernated = await until("the measured conversation's provider to hibernate", async () => (await host.state(id)).connection === "hibernated", 120_000, 200).then(() => true, () => false)
              if (!hibernated) {
                note(`  wake: the host didn't hibernate the conversation within 120 s of ${fillers.length} others' turns, its warm limit ${limit} (${(await host.state(id)).connection}); the wake send isn't measured this run`)
                continue
              }
              notes.hibernatedBecause = Words.safeParse(host.probe.slice(asked).find((line) => line.s === "log" && line.message === "provider hibernated" && line.fields?.conversation === id)?.fields?.reason).data ?? null
              notes.hibernatedAfterMs = Date.now() - askedAt
              notes.warmLimit = limit
              notes.fillers = fillers.length
              await delay(GAP_MS)
              // Nothing woke it ahead of the send: no window here prewarms, and the host only does for a message of its own.
              notes.connectionAtSend = (await host.state(id)).connection ?? null
            }
            const sample = await makoTurn(host, { pass: "load", scenario, others, run, id, project, tuned, notes })
            if (scenario === "wake") sample.notes.prewarmed = host.probe.slice(asked).some((line) => line.s === "log" && line.message === "prewarm waking" && line.fields?.conversation === id) ? "yes" : "no"
            samples.push(sample)
            started = true
          }
          if (started) await host.call("mako:live-close", id).catch(() => undefined)
        }
      }
      // Whether the others were still at work when the last measured run ended: each one's steps asked of the model by
      // then, and the latest step its files hold.
      const asked = load.map((each) => steps.get(each.tag) ?? 0)
      const written = load.map((each) => Math.max(-1, ...readdirSync(loadFolder).filter((name) => name.startsWith(`${each.tag}-`)).map((name) => StepFile.safeParse(readFileSync(join(loadFolder, name), "utf8")).data ?? -1)))
      loadStopped = true
      return { samples, ...held, steps: least(asked), files: least(written) }
    } catch (error) {
      const tail = host.logTail()
      if (tail) note(`the host's log ends:\n${tail}`)
      throw error
    } finally {
      await host.stop()
    }
  }

  /**
   * The host's very first launch: a new host process each run (on one scratch home and data root, as an app started
   * again), nothing launched on it before, its first conversation measured like a cold one the moment the host is ready;
   * then a second new conversation on that host, the `cold` this pass's `first` is read against.
   */
  async function firstPass(): Promise<Sample[]> {
    const folder = join(base, "first")
    const home = await sealedHome(folder, harness, model.url)
    bare.seal?.(home.home, model.url)
    scratchKeychain(home.home)
    const project = makeProject(join(folder, "project"))
    const samples: Sample[] = []
    for (let run = 1; run <= FIRST_RUNS; run += 1) {
      note(`  ${harness} first launch ${run}/${FIRST_RUNS}: bare, then a new host`)
      const bareSamples = await bareRun("first", 0, run, ["first", "cold"])
      const host = await startHost(folder, home)
      try {
        // One first launch a host: with `--tuning`, every other run's sends carry it.
        const tuned = TUNING && run % 2 === 0
        for (const scenario of ["first", "cold"] as const) {
          const id = `${MARK}${randomUUID().slice(8)}`
          samples.push(await makoTurn(host, { pass: "first", scenario, others: 0, run, id, project, tuned, notes: { hostReadyMs: Math.round(host.readyMs) } }))
          await host.call("mako:live-close", id).catch(() => undefined)
        }
        samples.push(...bareSamples)
      } catch (error) {
        const tail = host.logTail()
        if (tail) note(`the host's log ends:\n${tail}`)
        throw error
      } finally {
        await host.stop()
      }
    }
    return samples
  }

  const samples: Sample[] = []
  const yardsticks: Yardstick[] = []
  const unmeasured: string[] = []
  say()
  say(`${harness}: the answer is ${TOKENS.length} tokens (${ENDS.at(-1)} characters) at ${PACE} ms a token, in two parts around a write`)
  say(`${harness}: bare is ${bare.runs}; its output's grain: ${bare.grain}${bare.input === "argument" ? "; a process takes one message, so warm (a second message to the same process) has no bare run and its bare cells print `-`" : ""}`)
  if (FIRST_LAUNCH) {
    note(`${harness} pass: the host's first launch, ${FIRST_RUNS} new hosts (load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores)`)
    const first = await firstPass()
    samples.push(...first)
    report(harness, "first", 0, first, ["first", "cold"])
    firstReport(harness, first)
  }
  if (SCENARIOS.length) for (const others of OTHERS) {
    const degraded = yardsticks.find((each) => yardstickDegraded(each, yardsticks[0]!))
    if (degraded) {
      unmeasured.push(`${others} others: not run, the bare run was no yardstick at ${degraded.others}`)
      say()
      say(`${harness}, ${others} other conversations: not measurable here. The bare run stopped being a yardstick at ${degraded.others} others (below), so a difference against it at ${others} would say nothing about Mako.`)
      continue
    }
    // What the count before held says this one would: more than half the machine's memory isn't started.
    const before = yardsticks.findLast((each) => each.processes > 0)
    const would = before ? before.megabytes / before.processes * (others + before.processes - before.others) : 0
    if (would > totalmem() / 2 ** 21) {
      unmeasured.push(`${others} others: not run, its processes would hold about ${Math.round(would)} MB, over half this machine's memory`)
      say()
      say(`${harness}, ${others} other conversations: not run. At ${before?.others} others the host's tree held ${before?.megabytes} MB in ${before?.processes} processes, so ${others} would hold about ${Math.round(would)} MB, over half of this machine's ${Math.round(totalmem() / 2 ** 20)} MB.`)
      continue
    }
    note(`${harness} pass: ${others} other conversations on the host (load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores)`)
    const pass = await loadPass(others)
    samples.push(...pass.samples)
    const stick: Yardstick = { ...yardstickOf(others, pass.samples), megabytes: pass.megabytes, processes: pass.processes, steps: pass.steps, files: pass.files }
    yardsticks.push(stick)
    if (yardstickDegraded(stick, yardsticks[0]!)) unmeasured.push(`${others} others: the bare run was no yardstick (first token ${ms(stick.first, 0)} ms against ${ms(yardsticks[0]!.first, 0)}, a token ${ms(stick.token, 0)} ms behind the model against ${ms(yardsticks[0]!.token, 0)})`)
    report(harness, "load", others, pass.samples, SCENARIOS, yardstickDegraded(stick, yardsticks[0]!) ? yardsticks[0] : undefined)
  }
  if (yardsticks.length) scaleReport(harness, yardsticks)
  if (tuningOff !== undefined) {
    unmeasured.push(`--tuning: not sent, ${tuningOff}`)
    say()
    say(`${harness}: --tuning wasn't sent. ${tuningOff}`)
  }
  return { samples, yardsticks, unmeasured }
}

/* ----------------------------------------------------------------------- main */

async function main(): Promise<number> {
  // Refused before anything starts when the host isn't built.
  benchHostScript()
  const names = values.harness === "all" ? Object.keys(BARE) : values.harness.split(",")
  const drivers = createHarnessHost(detachedHarnessContext(new NativeStores(false))).liveDrivers.list()
  const all: Sample[] = []
  const skipped: string[] = []
  const scales: { harness: string; yardsticks: Yardstick[]; unmeasured: string[] }[] = []
  let failed = 0
  for (const harness of names) {
    const bare = entry<BareHarness | { skip: string }>(BARE, harness)
    const why = !bare ? "Mako has no harness of that name"
      : "skip" in bare ? bare.skip
      : drivers.find((driver) => driver.provider === harness)?.available(process.cwd()) ? undefined
      : "it isn't installed here (npx tsx scripts/harnesses-installed.ts)"
    if (why !== undefined || !bare || "skip" in bare) {
      say(`${harness}: skipped, ${why}`)
      skipped.push(`${harness}: ${why}`)
      continue
    }
    // One harness that can't be measured says why and leaves the others their tables.
    try {
      const { samples, yardsticks, unmeasured } = await measure(harness, bare)
      all.push(...samples)
      scales.push({ harness, yardsticks, unmeasured })
    } catch (error) {
      failed += 1
      say(`${harness}: not measured, ${error instanceof Error ? error.message : String(error)}`)
      note(error instanceof Error ? error.stack ?? error.message : String(error))
      skipped.push(`${harness}: failed, ${error instanceof Error ? error.message : String(error)}`)
      await Promise.all([...children].map((child) => stopChild(child, 20_000)))
      await endLeft(join(root, harness), `${harness}'s scratch folder`)
    }
  }
  crossReport(all, skipped)
  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ harnesses: names, runs: RUNS, firstRuns: FIRST_RUNS, others: OTHERS, scenarios: ASKED, tuning: TUNING, pace: PACE, tokens: TOKENS.length, characters: ENDS.at(-1), files: FILES, memoryBytes: totalmem(), cores: cpus().length, skipped, scales, samples: all }, null, 1)}\n`)
    say(`every timestamp: ${values.json}`)
  }
  if (values.record !== undefined) {
    writeFileSync(values.record, `${JSON.stringify({ harness: names[0], answer: ANSWER, pace: PACE, tokens: TOKENS.length, characters: ENDS.at(-1), turns: recorded })}\n`)
    say(`what the window was sent, for \`npm run bench:window\`: ${values.record}`)
  }
  return failed ? 1 : 0
}

/* ------------------------------------------------------- one turn through Mako */

interface MakoTurn {
  harness: string; pass: Pass; scenario: Scenario; others: number; run: number; tuned: boolean; sent: number; answered: number; turn: ModelTurn; request: string; id: string; client: string
  notes: Sample["notes"]; lines: z.infer<typeof ProbeLine>[]
  /** What the window's stream carried, and what a stream that reads the batches alone did. */
  heard: Heard[]; batchesOnly: Heard[]
}

/**
 * What a reader of a conversation's stream held as each line arrived: its batches reduced, and, for a window, the text
 * said ahead of the next batch drawn over the batch it was said of (`LiveAhead`), as the window draws it.
 */
function readerOf(heard: readonly Heard[], sent: number) {
  const held = new Held()
  const batches: Sample["batches"] = []
  const arrivals: number[] = []
  const reader: { at: number; characters: number }[] = []
  let firstText: number | undefined
  let revision: number | undefined
  let shown = 0
  let ahead = 0
  for (const { at, payload } of heard) {
    const json: z.infer<ReturnType<typeof z.json>> = JSON.parse(payload)
    const said = AheadLine.safeParse(json).data?.ahead
    const line = said ? undefined : BatchLine.safeParse(json).data
    if (said) {
      // Read only against the batch it was said of, as a window reads it.
      if (said.revision !== revision || held.characters + said.more.length <= shown) continue
      ahead += 1
      shown = held.characters + said.more.length
    } else if (line) {
      for (const update of line.updates ?? []) held.take(update.kind, update.id, update.text?.length ?? 0, update.replace === true)
      revision = line.revision
      batches.push({ at: at - sent, revision: line.revision, bytes: Buffer.byteLength(payload), characters: held.characters })
      if (held.characters > 0) firstText ??= line.revision
      if (held.characters <= shown) continue
      shown = held.characters
    } else continue
    arrivals.push(at - sent)
    reader.push({ at, characters: shown })
  }
  return { batches, arrivals, reader, firstText, ahead }
}

function makoSample({ harness, pass, scenario, others, run, tuned, sent, answered, turn, request, id, client, notes, lines, heard, batchesOnly }: MakoTurn): Sample {
  const marks: Mark[] = []
  const mark = (key: string, at: number | undefined) => { if (at !== undefined) marks.push({ key, at: at - sent }) }
  const stage = (name: string, evidence?: string) => lines.find((line) => line.s === name && line.q === request && (evidence === undefined || line.evidence === evidence))
  mark("call", stage("call")?.t)
  mark("answered", answered)
  for (const name of ["submit", "admitted", "dispatching", "gate", "assembled"]) mark(name, stage(name)?.t)
  const submitted = stage("delivery", "submitted")?.t
  mark("submitted", submitted)
  mark("accepted", stage("delivery", "accepted")?.t)
  notes.gate = stage("gate")?.kind ?? null
  // The provider's launch, phase by phase, as the host's own trace logged it; `launch` is the whole of it. A phase's
  // row is when its last step ended.
  const spans: { phase: string; from: number; to?: number; key: string }[] = []
  for (const line of lines) {
    const phase = line.s === "log" && line.scope === "provider-startup" ? PhaseFields.safeParse(line.fields).data : undefined
    if (!phase || phase.conversation !== id) continue
    const key = `${phase.attempt}:${phase.step}`
    if (phase.state === "started") spans.push({ phase: phase.phase, from: line.t, key })
    else if (phase.state === "done") {
      const span = spans.find((each) => each.key === key)
      if (span) span.to = line.t
    }
    if (phase.phase === "launch") mark(phase.state === "started" ? "launchStarted" : "launchDone", line.t)
    else if (phase.state === "done") {
      const at = marks.find((each) => each.key === `launch:${phase.phase}`)
      if (at) at.at = line.t - sent
      else mark(`launch:${phase.phase}`, line.t)
    }
  }
  // Where the launch's time went (`phase:`): each phase's own time, less the steps that ran inside it (Claude's
  // `configuration` holds its `mcp-preparation`), and the time inside the launch that no phase covers, named by the
  // phase that began when it ended (`outside, before spawn`).
  const whole = spans.find((span) => span.phase === "launch" && span.to !== undefined)
  const inner = spans.flatMap((span) => span.phase === "launch" || span.to === undefined ? [] : [{ phase: span.phase, from: span.from, to: span.to }]).sort((a, b) => a.from - b.from)
  const add = (key: string, amount: number) => { notes[key] = (Amount.safeParse(notes[key]).data ?? 0) + amount }
  if (whole?.to !== undefined) {
    add("phase:launch", whole.to - whole.from)
    for (const span of inner) add(`phase:${span.phase}`, span.to - span.from - inner.reduce((sum, other) => other !== span && other.from >= span.from && other.to <= span.to ? sum + other.to - other.from : sum, 0))
    let covered = whole.from
    for (const span of [...inner, { phase: "its end", from: whole.to, to: whole.to }]) {
      if (span.from - covered > 0.05) add(`phase:outside, before ${span.phase}`, span.from - covered)
      covered = Math.max(covered, span.to)
    }
  }
  mark("woke", lines.find((line) => line.s === "log" && line.message === "provider woke" && line.fields?.conversation === id)?.t)
  const from = submitted ?? sent
  mark("frame", lines.find((line) => line.s === "frame" && line.t >= from)?.t)
  mark("modelHeard", turn.heard[0])
  mark("modelFirst", turn.tokens[0])
  // What the host decoded: each text update with the frame it was decoded from, the last one recorded before it.
  const decodedHeld = new Held()
  const decoded: { at: number; characters: number }[] = []
  const framed: { at: number; characters: number }[] = []
  let frameAt: number | undefined
  for (const line of lines) {
    if (line.t < from) continue
    if (line.s === "frame") frameAt = line.t
    if (line.s !== "decoded" || !line.u) continue
    const before = decodedHeld.characters
    for (const [kind, block, length, replace] of line.u) decodedHeld.take(kind, block ?? undefined, length, replace === 1)
    if (decodedHeld.characters === before) continue
    decoded.push({ at: line.t, characters: decodedHeld.characters })
    framed.push({ at: frameAt ?? line.t, characters: decodedHeld.characters })
  }
  const harnessTimes = tokenTimes(framed)
  mark("textFrame", harnessTimes[0])
  mark("decoded", tokenTimes(decoded)[0])
  // What the window was sent, and what a reader of the batches alone was (a phone's link, the journal).
  const window = readerOf(heard, sent)
  const device = readerOf(batchesOnly, sent)
  const { batches, arrivals, firstText } = window
  mark("batch", lines.find((line) => line.s === "batch" && line.r === firstText)?.t)
  mark("wrote", lines.find((line) => line.s === "wrote" && line.r === firstText && line.client?.endsWith(client))?.t)
  const readerTimes = tokenTimes(window.reader)
  const deviceTimes = tokenTimes(device.reader)
  mark("received", readerTimes[0])
  notes.aheadFrames = window.ahead
  const checkpoint = lines.map((line) => line.s === "log" && line.scope === "checkpoints" ? { message: line.message, fields: CheckpointFields.safeParse(line.fields).data } : undefined).filter((line) => line?.fields?.request === request)
  const saved = checkpoint.find((line) => line?.message === "a turn's checkpoint was saved")?.fields
  notes.checkpoint = saved?.kind ?? null
  notes.checkpointHeldMs = saved?.heldMs ?? null
  notes.checkpointSavedMs = saved?.savedMs ?? null
  notes.wentBeforeCheckpoint = checkpoint.find((line) => line?.message?.includes("before its checkpoint"))?.message ?? null
  notes.characters = batches.at(-1)?.characters ?? 0
  notes.deviceCharacters = device.batches.at(-1)?.characters ?? 0
  notes.deviceBatches = device.arrivals.length
  notes.expected = ENDS.at(-1) ?? 0
  notes.wrote = existsSync(turn.file) ? "yes" : "no"
  notes.loopHeld = lines.filter((line) => line.s === "log" && line.scope === "loop").length
  return {
    harness, pass, side: "mako", scenario, others, run, tuned, sent, marks: marks.sort((a, b) => a.at - b.at), model: turn.tokens.map((at) => at - sent), out: harnessTimes.map((at) => at - sent), reader: readerTimes.map((at) => at - sent),
    device: deviceTimes.map((at) => at - sent), deviceArrivals: device.arrivals,
    arrivals, toolMs: turn.heard[1] === undefined || turn.tokens[FIRST_TOKENS - 1] === undefined ? undefined : turn.heard[1] - turn.tokens[FIRST_TOKENS - 1]!,
    notes, raw: lines.filter((line) => line.s !== "frame" && line.s !== "decoded"), batches,
  }
}

/* --------------------------------------------------------------------- report */

/** What each boundary is, and what the code does to reach it from the one before. `own`: the harness's or the model's time, which bare has too. */
interface Row { label: string; why: string; own?: true }
const ROWS = {
  call: { label: "1 call received by the host", why: "the window's HTTP call crosses the host's socket and its arguments are decoded (`transport/server.ts`)" },
  submit: { label: "  settings resolved, in order", why: "the method parses its arguments, `profiles.resolveLaunch` reads the folder and account, and `admitInOrder` waits for sends ahead" },
  admitted: { label: "2 admitted and journaled", why: "`LiveConversations.submit` fingerprints the request and `admit` commits it to the journal and emits its batch" },
  answered: { label: "  the call's answer reached the window", why: "the method's value is encoded and written back (not on the message's path)" },
  launchStarted: { label: "  provider launch begins", why: "`LiveLaunches.launch` makes the conversation's tools (`dependencies.tools`) and its thread environment before the driver starts; a wake reaches `wakeNow`" },
  launchDone: { label: "  provider launch ended", why: "the driver patches the session ready, and admission checks the account again (`assertCurrent`)" },
  woke: { label: "  provider woke", why: "`LiveHibernation.wakeNow` binds the resumed session and flushes" },
  dispatching: { label: "  left the queue for its turn", why: "the launch's session lands on the conversation and is flushed; `LiveDispatch.drain` takes the queued message, marks it dispatching and journals it" },
  gate: { label: "3 checkpoint gate released", why: "`LiveCheckpoints.prepare` checks the workspace can be checkpointed (`assertAvailable`) and starts the capture" },
  assembled: { label: "4 prompt assembled, admission passed", why: "`drain`'s run reads control instructions, rules and context and joins Mako's note to the message" },
  submitted: { label: "5 handed to the harness process", why: "admission checks the account again (`ready`), the driver builds the input and tunes the session, and the handoff is journaled before the send" },
  accepted: { label: "  harness echoed the message", why: "the harness read its input and said so (`acknowledge`)", own: true },
  frame: { label: "6 first native message after the send", why: "the harness's first output of any kind", own: true },
  modelHeard: { label: "  harness asked the model", why: "the harness's own work from its input to its model request", own: true },
  modelFirst: { label: "  model wrote its first text token", why: "the scripted model's pace", own: true },
  textFrame: { label: "  first text token out of the harness", why: "the harness's own relay of the model's token to its output", own: true },
  decoded: { label: "7 first text token decoded", why: "the driver's loop runs its observers on the frame, then the decoder and the engine hand the update to the conversation" },
  batch: { label: "8 first batch with text emitted", why: `\`schedule\` flushes a turn's first words at once and later ones each ${LIVE_FRAME_MS} ms; the flush commits to the journal and builds the batch` },
  wrote: { label: "9 batch written to the window's stream", why: "the event is encoded once per live form (`encodeRuntimeEvent`) and written to each subscriber (`send`)" },
  received: { label: "10 received by the window", why: "the line crosses the socket and is assembled (`subscribeRuntime`)" },
} satisfies Record<string, Row>
type Phase = Omit<Row, "label">
/** A phase no table below has: what the trace itself says of it. */
const PHASE: Phase = { why: "a phase of the driver's start (`ProviderLaunchTrace`)" }
/** The two phases every driver's launch passes before its own code (`execution-admission.ts`). */
const ADMISSION = {
  account: { why: "`admission.resolve` picks the account the launch runs on and its environment (`execution-admission.ts`)" },
} satisfies Record<string, Phase>
/**
 * Each phase of a driver's start the host's trace names (`ProviderLaunchTrace`), by what that driver's code runs in it:
 * Claude's `sdk-driver.ts` and `sdk-options.ts`, Codex's `codex-app.ts`, OpenCode's `live-driver.ts` and `native-api.ts`,
 * and `acp.ts` for Grok and Devin, which launch through it.
 */
const ACP_PHASES = {
  ...ADMISSION,
  "sdk-load": { why: "the ACP client package is loaded on its first use (`heavy.acpSdk.load`)" },
  "runtime-discovery": { why: "the oldest version Mako runs is checked (`floor.before`), the source says how to launch (`source.launch`), and the CLI's version is read (`readRuntimeVersion`)" },
  "mcp-preparation": { why: "`mcpSnapshot()` reads the folder's MCP servers and the source prepares them for the CLI (`spec.prepareMcp`)" },
  observation: { why: "the source sets up its watch on native approvals (`spec.prepareApprovals`) and on the harness's own agents (`agents.observe`)" },
  spawn: { why: "the CLI is spawned as an ACP server (`spawnProviderProcess`)" },
  handshake: { why: "the CLI answers ACP's `initialize`", own: true },
  "session-open": { why: "the CLI answers `session/new`", own: true },
  "session-resume": { why: "the source readies the stored session (`resuming.beforeLoad`) and the CLI answers `session/load`", own: true },
  settings: { why: "the launch's model and options are applied (`applyTuning`) and its mode set (`session/set_mode`)" },
} satisfies Record<string, Phase>
const PHASES = {
  claude: {
    ...ADMISSION,
    "runtime-discovery": { why: "the harness's executable is found (`claudeRuntime`) and held to the oldest version Mako runs (`RuntimeFloor.before`)" },
    "mcp-preparation": { why: "`mcpSnapshot(cwd)` reads the folder's MCP servers for the launch" },
    configuration: { why: "the rest of `claudeSdkOptions`: the environment, the MCP servers, Mako's in-process server and the system prompt" },
    observation: { why: "the write-hold check (`personCodeRuns`), then `prepareApprovals` sets up the watch on native approvals" },
    spawn: { why: "the CLI is spawned (`spawnClaudeProcess`), called by the Agent SDK's `query`, which the driver awaits before it, outside this phase" },
    "sdk-initialization": { why: "the CLI boots and answers the SDK's initialize", own: true },
    "session-resume": { why: "`transcript.locate` finds the resumed session's transcript" },
  },
  codex: {
    ...ADMISSION,
    "mcp-preparation": { why: "`mcpSnapshot()` reads the folder's MCP servers for the launch" },
    "runtime-discovery": { why: "the oldest version Mako runs is checked (`floor.before`), then the CLI is found (`resolveCodexExecutable`) and its launch built (`codexChildLaunch`)" },
    spawn: { why: "`codex app-server` is spawned (`spawnProviderProcess`)" },
    handshake: { why: "`codex app-server` answers `initialize`", own: true },
    settings: { why: "the write-hold check: whether code of the person's runs beside Mako's hook (`codexPersonCodeRuns`)" },
    identity: { why: "who the CLI is signed in as is read beside the launch (`observeNativeIdentity`)" },
    "session-open": { why: "the app-server answers `thread/start`", own: true },
    "session-resume": { why: "the app-server answers `thread/resume`", own: true },
  },
  opencode: {
    ...ADMISSION,
    "runtime-discovery": { why: "the oldest version Mako runs is checked (`floor.before`) and the installation resolved (`resolveOpenCodeInstallation`)" },
    "mcp-preparation": { why: "the launch's MCP servers are read (`mcpServers`) and each is handed to OpenCode's server" },
    spawn: { why: "OpenCode's server is spawned (`spawnProviderProcess`)" },
    handshake: { why: "OpenCode's server process comes up and says who it is (`native API readiness`, `serverIdentity`)", own: true },
    observation: { why: "the driver follows the server's event stream (`follow`), restores approvals seen before (`interactions.restore`) and waits for its agents' reader (`agents.ready`)" },
    "sdk-initialization": { why: "OpenCode activates its plugins, Mako's among them (`awaitOpenCodePlugins`)", own: true },
    "model-discovery": { why: "the server's model catalog is read beside the launch (`loadCatalog`)" },
    settings: { why: "the write-hold check (`openCodePersonCodeRuns`), and a resumed session's agent and model are switched to the launch's" },
    "session-open": { why: "the server answers `session.create`", own: true },
    "session-resume": { why: "the stored session is verified (`verifyOpenCodeSession`) and the server answers `session.get` (and `session.move` when the folder changed)", own: true },
  },
  grok: ACP_PHASES,
  devin: ACP_PHASES,
} satisfies Record<string, Record<string, Phase>>
const row = (harness: string, key: string): Row => entry<Row>(ROWS, key) ?? (key.startsWith("launch:")
  ? { label: `  launch: ${key.slice(7)}`, ...(entry<Phase>(entry<Record<string, Phase>>(PHASES, harness) ?? {}, key.slice(7)) ?? PHASE) }
  : { label: key, why: "" })
/** Rows that say when something off the message's path happened; they take no step of it. */
const BESIDE = new Set(["answered", "accepted", "frame"])

const median = (numbers: readonly number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : undefined
}
const quantile = (numbers: readonly number[], q: number) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : undefined
}
const worst = (numbers: readonly number[]) => numbers.length ? Math.max(...numbers) : undefined
const least = (numbers: readonly number[]) => numbers.length ? Math.min(...numbers) : undefined
const ms = (value: number | undefined, width = 8) => (value === undefined || Number.isNaN(value) ? "-" : value.toFixed(Math.abs(value) < 100 ? 1 : 0)).padStart(width)
const gaps = (times: readonly number[]) => times.slice(1).map((at, index) => at - times[index]!)
const defined = (numbers: readonly (number | undefined)[]) => numbers.flatMap((value) => value === undefined ? [] : [value])
const less = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? undefined : a - b
const markAt = (set: readonly Sample[], key: string) => defined(set.map((sample) => sample.marks.find((each) => each.key === key)?.at))
const lag = (set: readonly Sample[], from: "model" | "out", to: "out" | "reader" | "device") => set.flatMap((sample) => defined(sample[to].map((at, index) => sample[from][index] === undefined || at === undefined ? undefined : at - sample[from][index]!)))
const three = (numbers: readonly number[]) => `p50 ${ms(quantile(numbers, 0.5), 6)}  p95 ${ms(quantile(numbers, 0.95), 6)}  max ${ms(worst(numbers), 6)}`

/** A median has settled once every later run leaves it within this of where it ended: 5%, or 5 ms where that is more. */
const SETTLED = (final: number) => Math.max(5, Math.abs(final) * 0.05)
interface Settling { running: number[]; at: number | undefined; final: number | undefined }

/**
 * Where a row's median stopped moving: the median over the first k runs for each k, and the first k from which it
 * stays within `SETTLED` of the median over all of them. `at` is undefined when only the last run brought it there.
 */
function settling(numbers: readonly number[]): Settling {
  const running = numbers.map((_, index) => median(numbers.slice(0, index + 1))!)
  const final = running.at(-1)
  if (final === undefined) return { running, at: undefined, final }
  let at = running.length
  while (at > 1 && Math.abs(running[at - 2]! - final) <= SETTLED(final)) at -= 1
  return { running, at: at < running.length || running.length === 1 ? at : undefined, final }
}
/** A row's spread and where its median settled, as one line. */
function settlingLine(name: string, numbers: readonly number[]): string {
  const { running, at, final } = settling(numbers)
  const shown = [1, 2, 3, 5, 8, 10, 15, 20, 30, 40, 50].filter((k) => k < running.length).map((k) => `${k}:${ms(running[k - 1], 0)}`).join(" ")
  const spread = `min ${ms(least(numbers), 0)}  q1 ${ms(quantile(numbers, 0.25), 0)}  median ${ms(final, 0)}  q3 ${ms(quantile(numbers, 0.75), 0)}  max ${ms(worst(numbers), 0)}`
  const verdict = numbers.length < 3 ? "too few runs to say" : at === undefined ? `still moving at run ${numbers.length}` : `within ${ms(final === undefined ? undefined : SETTLED(final), 0)} ms of its last value from run ${at} of ${numbers.length}`
  return `    ${name.padEnd(34)}${spread}; median over the first k runs ${shown || "-"}; ${verdict}`
}

function yardstickOf(others: number, samples: readonly Sample[]): Pick<Yardstick, "others" | "first" | "token" | "pace"> {
  const bare = samples.filter((sample) => sample.side === "bare")
  const cold = bare.filter((sample) => sample.scenario === "cold")
  return { others, first: median(markAt(cold.length ? cold : bare, "received")), token: quantile(lag(bare, "model", "out"), 0.95), pace: quantile(bare.flatMap((sample) => [...gaps(sample.model.slice(0, FIRST_TOKENS)), ...gaps(sample.model.slice(FIRST_TOKENS))]), 0.95) }
}
function yardstickDegraded(stick: Yardstick, against: Yardstick): boolean {
  if (stick === against) return false
  const late = stick.first !== undefined && against.first !== undefined && stick.first > against.first * YARDSTICK_FIRST
  const slow = stick.token !== undefined && against.token !== undefined && stick.token > against.token + YARDSTICK_TOKEN_MS
  return late || slow
}

function report(harness: string, pass: Pass, others: number, samples: readonly Sample[], scenarios: readonly Scenario[], degradedAgainst?: Yardstick): void {
  const ranked: { scenario: Scenario; label: string; added: number; why: string }[] = []
  const where = pass === "first" ? "a new host each run" : `${others} other conversations at work`
  if (degradedAgainst) {
    say()
    say(`${harness}, ${where}: THE YARDSTICK DEGRADED. The bare run beside this load was itself slower than with ${degradedAgainst.others} others by more than the bench allows (first token over ${YARDSTICK_FIRST}x, or a token over ${YARDSTICK_TOKEN_MS} ms later), so the differences below say how the machine coped, not what Mako adds. Read them as not measurable here.`)
  }
  for (const scenario of scenarios) {
    const mako = samples.filter((sample) => sample.side === "mako" && sample.scenario === scenario && !sample.tuned)
    const tuned = samples.filter((sample) => sample.side === "mako" && sample.scenario === scenario && sample.tuned)
    const bare = samples.filter((sample) => sample.side === "bare" && sample.scenario === scenario)
    say()
    say(`${harness}, ${scenario}, ${where}: ${mako.length} runs through Mako, ${bare.length} bare (ms after the send; the median with the least and the worst run; a step is each run's own time since the row above on the message's path, so medians need not add up)`)
    if (!mako.length) {
      say("  not measured")
      continue
    }
    if (!bare.length) say(`  bare: not comparable. ${scenario === "warm" ? "This CLI's non-interactive mode takes one message a process, so a second message to the same process has no bare run" : "No bare run of this scenario finished"}; the bare cells print \`-\` and Mako's side is measured.`)
    const keys = [...new Set(mako.flatMap((sample) => sample.marks.map((each) => each.key)))].sort((a, b) => (median(markAt(mako, a)) ?? 0) - (median(markAt(mako, b)) ?? 0))
    const path = keys.filter((key) => !BESIDE.has(key))
    /** In each run, how long after the boundary before it on the path this one was reached. */
    const step = (set: readonly Sample[], key: string) => defined(set.map((sample) => {
      const here = sample.marks.find((each) => each.key === key)?.at
      const before = path[path.indexOf(key) - 1]
      const there = before === undefined ? 0 : sample.marks.find((each) => each.key === before)?.at
      return here === undefined || there === undefined ? undefined : here - there
    }))
    say(`  ${"boundary".padEnd(40)}${"bare".padStart(8)}${"Mako".padStart(8)}${"least".padStart(8)}${"worst".padStart(8)}${"step".padStart(8)}${"worst".padStart(8)}${"diff".padStart(8)}  what Mako does to get here`)
    let ownMako = 0
    for (const key of keys) {
      const { label, why, own } = row(harness, key)
      const bareAt = median(markAt(bare, key)), makoAt = median(markAt(mako, key))
      const stepped = BESIDE.has(key) ? undefined : median(step(mako, key))
      say(`  ${label.padEnd(40)}${ms(bareAt)}${ms(makoAt)}${ms(least(markAt(mako, key)))}${ms(worst(markAt(mako, key)))}${ms(stepped)}${ms(BESIDE.has(key) ? undefined : worst(step(mako, key)))}${ms(less(makoAt, bareAt))}  ${own ? `(the harness's own) ${why}` : why}`)
      if (stepped === undefined) continue
      if (own) ownMako += stepped
      else ranked.push({ scenario, label: label.trim(), added: stepped, why })
    }
    const ownBare = median(markAt(bare, "textFrame"))
    if (ownBare !== undefined) ranked.push({ scenario, label: "the harness's own steps, run by Mako rather than by itself", added: ownMako - ownBare, why: `its launch, its model request and its first token took ${ms(ownMako, 0)} ms in Mako's rows marked so, ${ms(ownBare, 0)} ms bare from the send to its first token` })
    const first = (set: readonly Sample[]) => median(markAt(set, "received"))
    const asked = (set: readonly Sample[]) => median(markAt(set, "modelHeard"))
    say(`  first token visible: bare ${ms(first(bare), 0)} ms, Mako ${ms(first(mako), 0)} ms, Mako adds ${ms(less(first(mako), first(bare)), 0)} ms; the harness asked its model: bare ${ms(asked(bare), 0)} ms, Mako ${ms(asked(mako), 0)} ms, Mako adds ${ms(less(asked(mako), asked(bare)), 0)} ms (the model's side is stamped the same for both, whatever grain the bare output has)`)
    // Each run's own difference, where a run has both sides: the pair shares its minute, which medians across the pass don't.
    const paired = (key: string) => defined(mako.map((sample) => less(sample.marks.find((each) => each.key === key)?.at, bare.find((each) => each.run === sample.run)?.marks.find((each) => each.key === key)?.at)))
    say("  spread, and where each median settled:")
    say(settlingLine("first token visible, bare", markAt(bare, "received")))
    say(settlingLine("first token visible, Mako", markAt(mako, "received")))
    say(settlingLine("  added, run by run", paired("received")))
    say(settlingLine("harness asked its model, bare", markAt(bare, "modelHeard")))
    say(settlingLine("harness asked its model, Mako", markAt(mako, "modelHeard")))
    say(settlingLine("  added, run by run", paired("modelHeard")))
    const each = (set: readonly Sample[], read: (sample: Sample) => number[]) => set.flatMap(read)
    const line = (name: string, numbers: number[]) => `  ${name.padEnd(54)}${three(numbers)}  (${numbers.length} tokens)`
    say("  the stream, per token:")
    say(line("bare: model wrote it -> out of the harness", lag(bare, "model", "out")))
    say(line("Mako: model wrote it -> host received it", lag(mako, "model", "out")))
    say(line("Mako: host received it -> window received it", lag(mako, "out", "reader")))
    say(line("Mako: model wrote it -> window received it", lag(mako, "model", "reader")))
    say(line("Mako: host received it -> reader of batches alone", lag(mako, "out", "device")))
    const said = (key: string) => [...new Set(mako.map((sample) => String(sample.notes[key] ?? "none")))].join(", ")
    const number = (key: string) => median(defined(mako.map((sample) => Amount.safeParse(sample.notes[key]).data)))
    /** The longest wait for more of the answer while text was streaming: the write's own pause, between the two parts, is left out. */
    const longest = (set: readonly Sample[], read: (sample: Sample) => number[], tokens: boolean) => worst(each(set, (sample) => {
      const times = read(sample)
      if (tokens) return [...gaps(times.slice(0, FIRST_TOKENS)), ...gaps(times.slice(FIRST_TOKENS))]
      const pause = sample.model[FIRST_TOKENS - 1], resumed = sample.model[FIRST_TOKENS]
      return pause === undefined || resumed === undefined ? gaps(times) : [...gaps(times.filter((at) => at < resumed)), ...gaps(times.filter((at) => at >= resumed))]
    }))
    say(`  longest gap while text streamed: between tokens bare ${ms(longest(bare, (sample) => sample.out, true), 0)} ms; between tokens as the model wrote them ${ms(longest(mako, (sample) => sample.model, true), 0)} ms; between batches the window received ${ms(longest(mako, (sample) => sample.arrivals, false), 0)} ms (${ms(median(mako.map((sample) => sample.arrivals.length)), 0)} arrivals with new text a turn for ${TOKENS.length} tokens, ${ms(number("aheadFrames"), 0)} of them said ahead of a batch every ${LIVE_AHEAD_MS} ms); between batches a reader of the batches alone received ${ms(longest(mako, (sample) => sample.deviceArrivals, false), 0)} ms (${ms(number("deviceBatches"), 0)} text batches a turn; a long answer flushes each ${LONG_ANSWER_FLUSH_MS} ms past ${LONG_ANSWER_CHARS} characters)`)
    const tool = (set: readonly Sample[]) => median(defined(set.map((sample) => sample.toolMs)))
    say(`  the write, from the model's last token before it to the request carrying its result: bare ${ms(tool(bare), 0)} ms, Mako ${ms(tool(mako), 0)} ms`)
    say(`  checkpoint: gate ${said("gate")} (${said("gate") === "held" ? "the message went at once and the agent's first write waited on the checkpoint" : "the message waited for its checkpoint"}); before-point ${said("checkpoint")}; held the workspace ${ms(number("checkpointHeldMs"), 0)} ms and was saved ${ms(number("checkpointSavedMs"), 0)} ms after it began; went ahead of it: ${said("wentBeforeCheckpoint")}`)
    if (scenario === "wake") say(`  the plain wake, a person's send to a sleeping conversation: hibernated because ${said("hibernatedBecause")}, ${ms(number("hibernatedAfterMs"), 0)} ms after ${said("fillers")} other conversations were sent a short turn (the host's warm limit read ${said("warmLimit")}); at the send its connection read ${said("connectionAtSend")}, and a wake started ahead of the send (\`mako:live-prewarm\`, or the host's own for an agent's message) was logged: ${said("prewarmed")}`)
    if (pass === "first") say(`  the host: ready ${ms(number("hostReadyMs"), 0)} ms after its process started (its catalog read, both streams attached), and the send followed at once`)
    const whole = [...mako, ...tuned, ...bare].filter((sample) => sample.notes.characters !== sample.notes.expected || sample.notes.wrote !== "yes")
    say(whole.length ? `  CHECK: ${whole.length} turns did not deliver the whole answer or the file (${whole.map((sample) => `${sample.side} run ${sample.run}: ${sample.notes.characters}/${sample.notes.expected} characters, file ${sample.notes.wrote}`).join("; ")})` : `  every turn delivered all ${ENDS.at(-1)} characters and wrote its file; the host logged ${mako.reduce((sum, sample) => sum + (Amount.safeParse(sample.notes.loopHeld).data ?? 0), 0)} held-loop lines during them`)
    if (tuned.length) {
      say(`  with the composer's tuning (${tuned.length} sends carrying ${[...new Set(tuned.map((sample) => String(sample.notes.tuning)))].join(" or ")}) against ${mako.length} without, alternating in this pass: each step's median`)
      say(`  ${"boundary".padEnd(40)}${"without".padStart(9)}${"with".padStart(9)}${"adds".padStart(9)}`)
      for (const key of path) {
        const without = median(step(mako, key)), withIt = median(step(tuned, key))
        if (Math.abs(less(withIt, without) ?? 0) >= 1 || key === "received") say(`  ${row(harness, key).label.padEnd(40)}${ms(without, 9)}${ms(withIt, 9)}${ms(less(withIt, without), 9)}`)
      }
      say(`  ${"first token visible".padEnd(40)}${ms(first(mako), 9)}${ms(first(tuned), 9)}${ms(less(first(tuned), first(mako)), 9)}   (steps that moved under 1 ms aren't listed)`)
      say(settlingLine("first token visible, with tuning", markAt(tuned, "received")))
      say(`    before each of those sends the bench read what the composer already holds (the profile from \`mako:harness-tuning\`, and for a later message the snapshot), which took the host ${ms(median(defined(tuned.map((sample) => Amount.safeParse(sample.notes.tuningReadMs).data))), 0)} ms (median, worst ${ms(worst(defined(tuned.map((sample) => Amount.safeParse(sample.notes.tuningReadMs).data))), 0)}) and is outside the send's clock${pass === "first" && scenario === "first" ? "; on a new host that read is the profile's first, and it runs before the first launch here" : ""}`)
    }
  }
  say()
  say(`${harness}, ${where}: what Mako adds before the first token is visible, largest first (median ms)`)
  for (const entry of ranked.sort((a, b) => b.added - a.added)) say(`  ${ms(entry.added)}  ${entry.scenario.padEnd(5)} ${entry.label}: ${entry.why}`)
}

/** The first launch on a new host beside a later one on the same host: what each phase and step cost each, so the difference says what is paid once a host. */
function firstReport(harness: string, samples: readonly Sample[]): void {
  const of = (scenario: Scenario) => samples.filter((sample) => sample.side === "mako" && sample.scenario === scenario && !sample.tuned)
  const first = of("first"), cold = of("cold")
  say()
  say(`${harness}: the host's first launch against a later new conversation on the same host (${first.length} and ${cold.length} runs; each phase's own time between its trace's lines, less the steps inside it; median ms, with each side's least and worst)`)
  if (!first.length || !cold.length) return void say("  not measured")
  const phases = [...new Set([...first, ...cold].flatMap((sample) => Object.keys(sample.notes).filter((key) => key.startsWith("phase:"))))]
  const took = (set: readonly Sample[], key: string) => defined(set.map((sample) => Amount.safeParse(sample.notes[key]).data))
  say(`  ${"phase".padEnd(28)}${"first".padStart(8)}${"least".padStart(8)}${"worst".padStart(8)}${"cold".padStart(8)}${"least".padStart(8)}${"worst".padStart(8)}${"once".padStart(8)}  what runs in it`)
  const rows = phases.map((key) => ({ key, first: median(took(first, key)), cold: median(took(cold, key)) })).sort((a, b) => (less(b.first, b.cold) ?? 0) - (less(a.first, a.cold) ?? 0))
  for (const { key, first: firstMs, cold: coldMs } of rows) {
    const name = key.slice(6)
    if ((firstMs ?? 0) < 0.5 && (coldMs ?? 0) < 0.5) continue
    const { why, own } = name === "launch" ? { why: "the whole launch: the rows below add up to it, where no two phases ran at once", own: undefined }
      : name.startsWith("outside, ") ? { why: "inside the launch and outside every phase its trace names", own: undefined }
      : entry<Phase>(entry<Record<string, Phase>>(PHASES, harness) ?? {}, name) ?? PHASE
    say(`  ${name.padEnd(28)}${ms(firstMs)}${ms(least(took(first, key)))}${ms(worst(took(first, key)))}${ms(coldMs)}${ms(least(took(cold, key)))}${ms(worst(took(cold, key)))}${ms(less(firstMs, coldMs))}  ${own ? `(the harness's own) ${why}` : why}`)
  }
  say("  `once` is first less cold: what the first launch on a host pays that a later one doesn't. `cold` is what every launch pays. Rows under 0.5 ms on both sides aren't listed.")
  const keys = [...new Set(first.flatMap((sample) => sample.marks.map((each) => each.key)))].filter((key) => !BESIDE.has(key) && !key.startsWith("launch:")).sort((a, b) => (median(markAt(first, a)) ?? 0) - (median(markAt(first, b)) ?? 0))
  say(`  ${"boundary (ms after the send)".padEnd(40)}${"first".padStart(8)}${"cold".padStart(8)}${"once".padStart(8)}`)
  for (const key of keys) say(`  ${row(harness, key).label.padEnd(40)}${ms(median(markAt(first, key)))}${ms(median(markAt(cold, key)))}${ms(less(median(markAt(first, key)), median(markAt(cold, key))))}`)
  const bare = samples.filter((sample) => sample.side === "bare")
  say(`  first token visible: first launch ${ms(median(markAt(first, "received")), 0)} ms, later launch ${ms(median(markAt(cold, "received")), 0)} ms, bare ${ms(median(markAt(bare, "received")), 0)} ms (${bare.length} bare runs beside them)`)
}

/** What the bare run read at each count of other conversations, against the first count's: where it stopped being a yardstick. */
function scaleReport(harness: string, yardsticks: readonly Yardstick[]): void {
  const against = yardsticks[0]!
  say()
  say(`${harness}: the yardstick under load. The bare run beside each count of other conversations, against ${against.others} others (first token over ${YARDSTICK_FIRST}x, or a token's p95 over ${YARDSTICK_TOKEN_MS} ms later, and it is no yardstick)`)
  say(`  ${"others".padEnd(8)}${"bare first token".padStart(18)}${"bare token p95".padStart(16)}${"model's gap p95".padStart(17)}${"processes".padStart(11)}${"MB held".padStart(9)}${"steps".padStart(7)}${"wrote".padStart(7)}  verdict`)
  for (const stick of yardsticks) say(`  ${String(stick.others).padEnd(8)}${ms(stick.first, 18)}${ms(stick.token, 16)}${ms(stick.pace, 17)}${String(stick.processes).padStart(11)}${String(stick.megabytes).padStart(9)}${String(stick.steps ?? "-").padStart(7)}${String(stick.files ?? "-").padStart(7)}  ${yardstickDegraded(stick, against) ? "degraded: not measurable here" : "a yardstick"}`)
  say(`  (processes and MB: the host's scratch tree once the others were streaming, before any measured run; the model's gap is between tokens as the stand-in wrote them during bare runs, ${PACE} ms asked; steps: the fewest any other conversation had asked its model for when the last measured run ended; wrote: the latest step the files of the one furthest behind held then)`)
}

/** Across the harnesses measured: what Mako adds to the first token and to each token, with nobody else at work where that was run. */
function crossReport(all: readonly Sample[], skipped: readonly string[]): void {
  const harnesses = [...new Set(all.map((sample) => sample.harness))]
  if (!harnesses.length && !skipped.length) return
  say()
  say("across harnesses: what Mako adds (median ms; each harness's pass with the fewest other conversations; `-` where a side wasn't measured or has no bare run)")
  const cell = (set: readonly Sample[], scenario: Scenario, key: string) => {
    const of = (side: Sample["side"]) => median(markAt(set.filter((sample) => sample.side === side && sample.scenario === scenario && !sample.tuned), key))
    return `${ms(less(of("mako"), of("bare")), 7)}${`(${ms(of("mako"), 0).trim()})`.padStart(8)}`
  }
  say(`  ${"".padEnd(10)}${"first token visible: added (Mako's own)".padEnd(60)}${"model asked: added (Mako's own)".padEnd(60)}`)
  say(`  ${"harness".padEnd(10)}${["first", "cold", "warm", "wake"].map((name) => name.padStart(15)).join("")}${["first", "cold", "warm", "wake"].map((name) => name.padStart(15)).join("")}`)
  for (const harness of harnesses) {
    const mine = all.filter((sample) => sample.harness === harness)
    const fewest = least(mine.filter((sample) => sample.pass === "load").map((sample) => sample.others))
    const load = mine.filter((sample) => sample.pass === "load" && sample.others === fewest)
    const first = mine.filter((sample) => sample.pass === "first")
    const cells = (key: string) => `${cell(first, "first", key)}${cell(load, "cold", key)}${cell(load, "warm", key)}${cell(load, "wake", key)}`
    say(`  ${harness.padEnd(10)}${cells("received")}${cells("modelHeard")}`)
  }
  say("  (first token visible is held against the bare CLI's own output, so where that output comes a message or a block at a time, the bare first token is the whole first part and the difference is negative: `model asked` is the like-for-like row there)")
  say()
  say("across harnesses: each token, from the host receiving it (ms; every scenario of the same pass)")
  say(`  ${"harness".padEnd(10)}${"others".padEnd(8)}${"bare: model -> out of the harness".padEnd(42)}${"Mako: model -> host".padEnd(42)}${"host -> window".padEnd(42)}${"host -> reader of batches alone".padEnd(42)}`)
  for (const harness of harnesses) {
    const mine = all.filter((sample) => sample.harness === harness && sample.pass === "load")
    for (const others of [...new Set(mine.map((sample) => sample.others))]) {
      const mako = mine.filter((sample) => sample.others === others && sample.side === "mako" && !sample.tuned)
      const bare = mine.filter((sample) => sample.others === others && sample.side === "bare")
      say(`  ${harness.padEnd(10)}${String(others).padEnd(8)}${three(lag(bare, "model", "out")).padEnd(42)}${three(lag(mako, "model", "out")).padEnd(42)}${three(lag(mako, "out", "reader")).padEnd(42)}${three(lag(mako, "out", "device")).padEnd(42)}`)
    }
  }
  for (const line of skipped) say(`  not in these tables: ${line}`)
}

const code = await main().catch((error) => {
  note(error instanceof Error ? error.stack ?? error.message : String(error))
  return 1
})
await finish(code)
