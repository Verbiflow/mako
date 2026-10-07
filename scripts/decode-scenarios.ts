import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import type { JsonObject } from "../electron/codex-app-json.ts"
import type { ScriptedReply } from "./scripted-model.ts"

/**
 * The turns `harness-decode-pairs.ts` records against every harness. A pair
 * kept under `fixtures/native-decoding/<harness>/pairs/<name>/` was recorded
 * from the scenario of that name.
 */
/** A function tool takes `arguments`; a freeform one (Codex's `apply_patch`) takes `input` text. */
export type Call = { name: string } & ({ arguments: JsonObject } | { input: string })

export type Todo = { id: string; content: string; status: "pending" | "in_progress" | "completed" }

/** A tool some harnesses lack: absent, with why, for one that has none as Mako launches it. */
export type Optional<Tool> = Tool | { absent: string }

/** A harness's own tools, as its model calls them. */
export interface ToolVocabulary {
  /** A read of `path`, or of `lines.limit` lines from line `lines.offset` (1-based). */
  read(path: string, lines?: LineRange): Call
  shell(command: string, description: string): Call
  edit(path: string, from: string, to: string): Call
  /** A look at an image file, whose result the model sees as the image. */
  viewImage(path: string): Call
  todos: Optional<(items: Todo[]) => Call>
  /** A search of the project's files for `pattern`, through the harness's own tool rather than the shell. */
  search: Optional<(pattern: string) => Call>
  /** A JavaScript cell that calls the harness's tools itself, and the model whose turns have one. */
  codeMode: Optional<CodeMode>
  /** A question for the person, with options; every recorder answers with the first. */
  ask: Optional<(question: Question) => Call>
  /** How a plan-mode turn proposes `plan`: the steps that end it, approved where the harness asks. */
  plan: Optional<(plan: string) => Step[]>
}

/** A type, not an interface, so it is JSON a call's arguments can carry. */
export type Question = {
  header: string
  question: string
  options: { label: string; description: string }[]
}

export interface CodeMode {
  model: string
  cell(source: string): Call
}

export interface LineRange {
  offset: number
  limit: number
}

export interface Turn {
  prompt: string
  steps: Step[]
  /** Stopped a second after its first tool starts, as a person pressing Stop while it runs. */
  stop?: true
  /** Run in the harness's plan mode; the turn after one without it runs in the session's own mode again. */
  plan?: true
  /** A manual compaction instead of a prompt, as Mako starts one; `prompt` is what a person types for it. */
  compact?: true
  /** Steered into the turn a second after its first tool starts, as a person sending a message while it runs. */
  steer?: string
  /**
   * A rewind instead of a prompt, to before the turn of this index (0-based,
   * counting only prompted turns), as a person rewinding in the harness's own
   * client. Mako draws nothing for it; `prompt` is what a person types for it.
   */
  rewind?: number
  /** Files of the scenario's `images` sent with the prompt, staged as Mako stages an attachment. */
  attachments?: string[]
}

/** How long a turn's first tool runs before it is stopped or steered. */
export const STOP_AFTER_MS = 1000

export interface Step {
  reasoning?: string
  text?: string
  /** The call, given the request the model is answering, whose instructions can name a path the call needs. */
  call?: (tools: ToolVocabulary, project: string, heard: string) => Call
  fail?: ScriptedReply["fail"]
  /** The harness's own steps for proposing this plan (`ToolVocabulary.plan`). */
  plan?: string
  /** Text the request this step answers must carry: a steered message the harness had to deliver. */
  hears?: string
}

/**
 * Turns a person could ask for, each answered by a scripted model step by
 * step. The prompts name what to do, so a harness's own model, which only
 * the prompt steers, takes the same path.
 */
export type Need = "todos" | "search" | "codeMode" | "ask" | "plan"

/** What a scenario does to a running session besides prompting it, which each recorder drives or says why it can't. */
export type Control = "steer" | "rewind" | "compact"

export interface Scenario {
  name: string
  about: string
  files: Record<string, string>
  /** Image files, written beside `files`. */
  images?: Record<string, Buffer>
  turns: Turn[]
  /** The optional tools its steps call; a harness without one skips the scenario. */
  needs?: Need[]
  controls?: Control[]
  /** Set on the harness, as a harness's own knob for this scenario. */
  env?: Record<string, string>
  /** Why its steps need the scripted model, for a scenario a harness's own model can't be steered through. */
  scripted?: string
}

function todos(tools: ToolVocabulary, items: Todo[]): Call {
  if ("absent" in tools.todos) throw new Error(tools.todos.absent)
  return tools.todos(items)
}

function search(tools: ToolVocabulary, pattern: string): Call {
  if ("absent" in tools.search) throw new Error(tools.search.absent)
  return tools.search(pattern)
}

function cell(tools: ToolVocabulary, source: string): Call {
  if ("absent" in tools.codeMode) throw new Error(tools.codeMode.absent)
  return tools.codeMode.cell(source)
}

function ask(tools: ToolVocabulary, question: Question): Call {
  if ("absent" in tools.ask) throw new Error(tools.ask.absent)
  return tools.ask(question)
}

const RELEASE_DAY: Question = {
  header: "Release day",
  question: "Which day should the release ship?",
  options: [
    { label: "Friday", description: "Keep the day notes.md names." },
    { label: "Monday", description: "Move it past the weekend." },
  ],
}

/**
 * The plan file a plan-mode turn's instructions name, which the harness reads
 * its proposed plan from: the model writes the plan there, then calls the
 * tool that proposes it with no plan of its own.
 */
export function planFile(harness: string, heard: string): string {
  // Grok 1.0.46: "Write your plan to <path>"; Claude Code 2.1.283: a file under its `plans` folder.
  const named = /Write your plan to (\/[^\s"'`\\]+?\.md)|(\/[^\s"'`\\]+\/plans\/[^\s"'`\\]+\.md)/.exec(heard)
  const path = named?.[1] ?? named?.[2]
  if (!path) throw new Error(`${harness}'s plan-mode request names no plan file: ${[...heard.matchAll(/.{0,160}plan file.{0,200}/gi)].map((match) => match[0]).slice(0, 3).join(" | ") || heard.slice(0, 400)}`)
  return path
}

const RELEASE_PLAN = "1. Change Friday to Monday in notes.md.\n2. Tell QA the new day."

const NOTES = "The release ships on Friday.\nQA signs off on Thursday.\n"

/** 3,000 numbered lines: past the 2,000 most harnesses read at once, and short enough to keep. */
/**
 * The summary the harness asks its model for, in the shape each checks: a
 * single `<summary>` block of at least 500 characters (Grok 1.0.46's
 * `MIN_SUMMARY_SEED_CHARS`) under OpenCode 2.0.1's template headings. Each
 * asks again when its summary lacks its shape.
 */
const COMPACT_SUMMARY = [
  "<summary>",
  "## Objective", "- Find out which day the release ships, as notes.md states it.",
  "## Requirements", "- Don't run commands; read notes.md only.",
  "## Decisions", "- Answer from notes.md alone, without changing it.",
  "## Work State",
  "### Completed", "- Read notes.md: \"The release ships on Friday.\" and \"QA signs off on Thursday.\"", "- Told the person the release ships on Friday.",
  "### Active", "- (none)",
  "### Blocked", "- (none)",
  "## Next Move", "1. Answer follow-up questions about the release day from this summary.",
  "## Relevant Files", "- `notes.md`: names the release day (Friday) and the QA sign-off day (Thursday).",
  "## Important Context", "- notes.md has two lines and nothing else; no file was changed.",
  "</summary>",
].join("\n")

const LONG_LOG = Array.from({ length: 3000 }, (_, index) => `entry ${index + 1}`).join("\n") + "\n"

/** A `size`-square PNG of one colour: small enough to keep in a pair, and an image every model reads. */
function solidPng(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const framing = Buffer.alloc(8)
    framing.writeUInt32BE(data.length, 0)
    framing.writeUInt32BE(crc32(body), 4)
    return Buffer.concat([framing.subarray(0, 4), body, framing.subarray(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits per channel
  header[9] = 2 // truecolour
  const row = Buffer.from([0, ...Array.from({ length: size }, () => [red, green, blue]).flat()])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export const SCENARIOS: Scenario[] = [
  {
    name: "read-and-answer",
    about: "Reasoning, text, a file read, then the answer.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "What do the notes in notes.md say?",
      steps: [
        { reasoning: "The answer is in notes.md, so read it first.", text: "I'll read the notes.", call: (tools, project) => tools.read(join(project, "notes.md")) },
        { reasoning: "The notes give a ship day and a sign-off day.", text: "The notes say the release ships on Friday, after QA signs off on Thursday." },
      ],
    }],
  },
  {
    name: "shell-and-edit",
    about: "A shell command with output, a file edit with its diff, then the answer.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Run `wc -l notes.md` in the shell, then edit notes.md so the release ships on Monday.",
      steps: [
        { text: "Counting first.", call: (tools) => tools.shell("wc -l notes.md", "Count the lines in notes.md") },
        { reasoning: "Two lines. The edit needs the file read.", call: (tools, project) => tools.read(join(project, "notes.md")) },
        { reasoning: "Now the edit.", call: (tools, project) => tools.edit(join(project, "notes.md"), "ships on Friday", "ships on Monday") },
        { text: "notes.md has two lines, and the release now ships on Monday." },
      ],
    }],
  },
  {
    name: "failed-read",
    about: "A read of a file that does not exist fails, and the answer says so.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Read missing.md and tell me what it says. Don't look for it anywhere else.",
      steps: [
        { call: (tools, project) => tools.read(join(project, "missing.md")) },
        { text: "There is no missing.md in this project." },
      ],
    }],
  },
  {
    name: "failing-shell",
    about: "A shell command that exits non-zero, which the harness may report as completed.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Run `grep -q Monday notes.md` in the shell and tell me from its exit code whether notes.md mentions Monday.",
      steps: [
        { call: (tools) => tools.shell("grep -q Monday notes.md", "Look for Monday in notes.md") },
        { text: "notes.md does not mention Monday." },
      ],
    }],
  },
  {
    name: "failing-shell-output",
    about: "A shell command that prints output and an error, then exits non-zero.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Run exactly this shell command once, with nothing added before or after it: `cat notes.md missing.md`. Then tell me what it printed and how it exited.",
      steps: [
        { call: (tools) => tools.shell("cat notes.md missing.md", "Print notes.md and missing.md") },
        { text: "It printed notes.md, then failed on missing.md." },
      ],
    }],
  },
  {
    name: "write-outside",
    about: "A command that writes outside the project, which a sandboxed harness refuses. Codex 0.159.3 sends no item for a command its sandbox refused; its rollout keeps the call.",
    files: { "notes.md": NOTES },
    scripted: "the model has to write outside the project on cue",
    turns: [{
      prompt: "Run `echo hi > ../outside.txt` in the shell and tell me whether it worked.",
      steps: [
        { call: (tools) => tools.shell("echo hi > ../outside.txt", "Write outside the project") },
        { text: "That is what the shell reported." },
      ],
    }],
  },
  {
    name: "long-read",
    about: "One read of a file longer than a harness shows at once, then the answer.",
    files: { "log.md": LONG_LOG },
    turns: [{
      prompt: "Read log.md with your file read tool, once and without an offset or limit, then tell me the last line you were shown. Don't run commands.",
      steps: [
        { call: (tools, project) => tools.read(join(project, "log.md")) },
        { text: "The read stopped before the end of log.md." },
      ],
    }],
  },
  {
    name: "ranged-read",
    about: "A read of lines 10 to 20 of a long file, so a harness's own cut can be told from one the model asked for.",
    files: { "log.md": LONG_LOG },
    turns: [{
      prompt: "Read only lines 10 to 20 of log.md with your file read tool, once, and tell me the last line you were shown. Don't run commands.",
      steps: [
        { call: (tools, project) => tools.read(join(project, "log.md"), { offset: 10, limit: 11 }) },
        { text: "The last line was entry 20." },
      ],
    }],
  },
  {
    name: "code-mode",
    about: "One JavaScript cell that reads, patches and counts a file through the harness's own tools, then the answer.",
    files: { "notes.md": NOTES },
    needs: ["codeMode"],
    turns: [{
      prompt: "In one code cell, run `cat notes.md`, patch Friday to Monday, then run `wc -l notes.md`, and tell me what happened.",
      steps: [
        {
          call: (tools, project) => cell(tools, [
            `const notes = await tools.exec_command({ cmd: "cat notes.md" })`,
            `await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${join(project, "notes.md")}\n@@\n-The release ships on Friday.\n+The release ships on Monday.\n*** End Patch\n`)})`,
            `const count = await tools.exec_command({ cmd: "wc -l notes.md" })`,
            `text(JSON.stringify(notes))`,
            `text(JSON.stringify(count))`,
          ].join("\n")),
        },
        { text: "The release now ships on Monday; notes.md still has two lines." },
      ],
    }],
  },
  {
    name: "question",
    about: "A question with two options, answered with the first, then the answer.",
    files: { "notes.md": NOTES },
    needs: ["ask"],
    turns: [{
      prompt: "Ask me with your question tool, once, whether the release should ship on Friday or Monday, then tell me what I picked. Don't run commands.",
      steps: [
        { call: (tools) => ask(tools, RELEASE_DAY) },
        { text: "You picked Friday." },
      ],
    }],
  },
  {
    name: "plan-mode",
    about: "A plan-mode turn that reads a file and proposes a plan, approved where the harness asks, then a turn in the session's own mode.",
    files: { "notes.md": NOTES },
    needs: ["plan"],
    turns: [
      {
        prompt: "Plan how to move the release to Monday. Read notes.md first; don't change any file. Propose the plan when it's ready.",
        plan: true,
        steps: [
          { call: (tools, project) => tools.read(join(project, "notes.md")) },
          { plan: RELEASE_PLAN },
        ],
      },
      {
        prompt: "Thanks. Without changing anything, tell me in one line what the plan's first step is.",
        steps: [{ text: "Change Friday to Monday in notes.md." }],
      },
    ],
  },
  {
    name: "cited-lines",
    about: "An answer that cites a file and a line of it, which Devin 3000.10.23's model marks up for its client to link.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Read notes.md, then tell me in one sentence what its second line says, citing the file and that line.",
      steps: [
        { call: (tools, project) => tools.read(join(project, "notes.md")) },
        { text: "Line 2 of notes.md says QA signs off on Thursday." },
      ],
    }],
  },
  {
    name: "compaction",
    about: "A turn, a manual compaction, then a turn that leans on the summary.",
    files: { "notes.md": NOTES },
    controls: ["compact"],
    turns: [
      {
        prompt: "Read notes.md and tell me the release day. Don't run commands.",
        steps: [
          { call: (tools, project) => tools.read(join(project, "notes.md")) },
          { text: "The release ships on Friday." },
        ],
      },
      { prompt: "/compact", compact: true, steps: [{ text: COMPACT_SUMMARY }] },
      {
        prompt: "Without reading anything, which day did notes.md name?",
        steps: [{ text: "Friday." }],
      },
    ],
  },
  {
    name: "server-error",
    about: "The model fails with a server error, the harness retries once and the turn fails.",
    files: {},
    // grok reads `GROK_MAX_RETRIES` (xai-grok-sampler `retry.rs`, default 15). With it at 1, grok 1.0.46 still
    // reported `max_retries: 3` and asked three times over about 40 seconds before its `failed` retry state.
    // Claude Code reads `CLAUDE_CODE_MAX_RETRIES` (default 10, with backoff past two minutes).
    env: { GROK_MAX_RETRIES: "1", CLAUDE_CODE_MAX_RETRIES: "1" },
    scripted: "the model has to fail on cue",
    turns: [{
      prompt: "Say hello.",
      steps: [{ fail: { status: 500, message: "The scripted model failed" } }],
    }],
  },
  {
    name: "todos-over-two-turns",
    about: "A todo list in the first turn, updated in the second.",
    needs: ["todos"],
    files: { "notes.md": NOTES },
    turns: [
      {
        prompt: "Use your todo list to plan the release in two items: QA sign-off, in progress, then shipping the release, pending. Don't run commands or change files.",
        steps: [
          { call: (tools) => todos(tools, [{ id: "qa", content: "QA sign-off", status: "in_progress" }, { id: "ship", content: "Ship the release", status: "pending" }]) },
          { text: "Two steps: QA signs off, then the release ships." },
        ],
      },
      {
        prompt: "QA signed off. Update the todo list: QA sign-off completed, shipping in progress. Don't run commands or change files.",
        steps: [
          { call: (tools) => todos(tools, [{ id: "qa", content: "QA sign-off", status: "completed" }, { id: "ship", content: "Ship the release", status: "in_progress" }]) },
          { text: "QA is done; shipping is next." },
        ],
      },
    ],
  },
  {
    name: "read-image",
    about: "A file read whose result is an image, then the answer.",
    files: {},
    images: { "swatch.png": solidPng(32, [220, 30, 30]) },
    turns: [{
      prompt: "Open swatch.png with your file read tool and tell me its colour. Don't run commands.",
      steps: [
        { call: (tools, project) => tools.viewImage(join(project, "swatch.png")) },
        { text: "swatch.png is a solid red square." },
      ],
    }],
  },
  {
    name: "image-prompt",
    about: "A prompt that carries an image, answered without a tool.",
    files: {},
    images: { "swatch.png": solidPng(32, [30, 90, 220]) },
    turns: [{
      prompt: "What colour is the attached image? Don't run commands.",
      attachments: ["swatch.png"],
      steps: [{ text: "The attached image is a solid blue square." }],
    }],
  },
  {
    name: "stopped-shell",
    about: "A long shell command the person stops while it runs.",
    files: {},
    turns: [{
      prompt: "Run `sleep 30` in the shell.",
      stop: true,
      steps: [{ text: "Waiting on the shell.", call: (tools) => tools.shell("sleep 30", "Wait thirty seconds") }],
    }],
  },
  {
    name: "search-files",
    about: "A file search matching in two files of three, one in a subdirectory, then the answer naming them.",
    needs: ["search"],
    files: { "notes.md": NOTES, "docs/plan.md": "Freeze the branch on Friday.\n", "todo.md": "Book the launch room.\n" },
    turns: [{
      prompt: "Without the shell, use your file search tools to find the Markdown files in this project, then search them for the word Friday and tell me which ones mention it.",
      steps: [
        { call: (tools) => search(tools, "Friday") },
        { text: "notes.md and docs/plan.md mention Friday." },
      ],
    }],
  },  {
    name: "steered-shell",
    about: "A message steered in while a shell command runs, which the harness reads at its next step, then the answer it asked for.",
    files: { "notes.md": NOTES },
    controls: ["steer"],
    turns: [{
      prompt: "Run `sleep 3` in the shell, then tell me how it went.",
      steer: "Also read notes.md and tell me the release day.",
      steps: [
        { text: "Waiting on the shell.", call: (tools) => tools.shell("sleep 3", "Wait three seconds") },
        { hears: "Also read notes.md and tell me the release day.", call: (tools, project) => tools.read(join(project, "notes.md")) },
        { text: "The shell finished, and notes.md says the release ships on Friday." },
      ],
    }],
  },
  {
    name: "rewound-turn",
    about: "Two turns, a rewind to before the second, then a turn that replaces it.",
    files: { "notes.md": NOTES },
    controls: ["rewind"],
    turns: [
      {
        prompt: "Read notes.md and tell me the release day. Don't run commands.",
        steps: [
          { call: (tools, project) => tools.read(join(project, "notes.md")) },
          { text: "The release ships on Friday." },
        ],
      },
      {
        prompt: "Which day does QA sign off? Answer without reading anything.",
        steps: [{ text: "QA signs off on Thursday." }],
      },
      { prompt: "/rewind", rewind: 1, steps: [] },
      {
        prompt: "Without reading anything, how many lines does notes.md have?",
        steps: [{ text: "notes.md has two lines." }],
      },
    ],
  },
]

/**
 * Each conversation request takes the next step, its call numbered in order.
 * A script that ends failing keeps failing: a server that is down stays down,
 * however many times the harness retries.
 */
export function script(scenario: Scenario, tools: ToolVocabulary, project: string): Script {
  const steps = scenario.turns.flatMap((turn) => turn.steps).flatMap((step) => {
    if (step.plan === undefined) return [step]
    if ("absent" in tools.plan) throw new Error(tools.plan.absent)
    return tools.plan(step.plan)
  })
  let next = 0
  const unheard: string[] = []
  return {
    unheard,
    reply: (heard) => {
      const step = steps[next++] ?? (steps.at(-1)?.fail ? steps.at(-1) : undefined)
      if (!step) return undefined
      if (step.hears && !heard.includes(step.hears)) unheard.push(`step ${next} never heard "${step.hears}"`)
      const call = step.call?.(tools, project, heard)
      return { reasoning: step.reasoning, text: step.text, call: call && { id: `call_${next}`, ...call }, fail: step.fail }
    },
  }
}

export interface Script {
  reply: (heard: string) => ScriptedReply | undefined
  /** Each step whose request lacked what it `hears`, which the run fails on once it ends. */
  unheard: string[]
}
