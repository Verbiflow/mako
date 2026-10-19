/**
 * Reads a built transcript back and holds it to the entries it was built
 * from: every entry's content is recovered from transcript.md and the
 * files beside it, in its turn and in its place. Shared by the unit tests
 * (`transcript.mjs`) and the run over this Mac's sessions
 * (`scripts/check-transcript-lossless.ts`).
 *
 * Checked whole: a prompt's, an answer's, a thought's and a plan's words, a
 * call's arguments (as the JSON value they were, or the text), its output,
 * the diffs and places it reported that its arguments don't already hold,
 * an event's label, detail and body, a raw record, and each attachment's
 * bytes. Checked by presence: names, titles, statuses and models, which sit
 * on a marker line.
 */
import assert from "node:assert/strict"

const TURN = /^## (?:Turn (\d+)(?: \(its end\))?|Before turn 1)(?: · .*)?$/
const FENCE = /^`{3,}$/
const MOVED = /^(?:("(?:[^"\\]|\\.)*"|[^\s"]\S*?): )?→ ((?:payloads|attachments)\/\S+) \((.+)\) starts:$/
/** The markers the builder opens an entry with; a heading inside content that could pass for one is fenced. */
const MARKER = /^### (?:User|Agent|Thinking|Call \d|Event|Plan$|Proposed plan|Unread record|Harness turn|Attachment)/
const KEY = /^("(?:[^"\\]|\\.)*"|[A-Za-z_$@][\w.$@/-]*):(?: (.*))?$/
const LITERAL = /^(?:["[{]|(?:true|false|null)$|-?\d[\d.eE+-]*$)/
const DETAIL_LINE = /^(?:Input:|Diff: |Location: |Terminal: |Plan:$|Review:|Attachment: |\(The page |Output:$)/

/** Entries into turns, as the builder groups them. */
export function turnsOf(entries) {
  const turns = []
  let current
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const previous = entries[index - 1]
    const continued = entry.type === "user" && previous?.type === "user" && entry.messageId !== undefined && entry.messageId === previous.messageId
    const opens = entry.type === "provider-turn" || (entry.type === "user" && !entry.steeringFor && !continued)
    if (opens || !current) {
      current = { lead: !opens, entries: [] }
      turns.push(current)
    }
    current.entries.push(entry)
  }
  return turns
}

/** The transcript's lines from its first turn on, cut into turns and their entries' blocks, fences kept whole. */
function sections(markdown) {
  const lines = markdown.split("\n")
  const turns = []
  let turn
  let block
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (FENCE.test(line) && turn) {
      const end = lines.indexOf(line, index + 1)
      assert.ok(end > index, `an unclosed fence at line ${index + 1}`)
      for (let at = index; at <= end; at++) block?.lines.push(lines[at])
      index = end
      continue
    }
    const heading = TURN.exec(line)
    if (heading) {
      turn = { heading: line, number: heading[1] === undefined ? 0 : Number(heading[1]), blocks: [], line: index + 1 }
      turns.push(turn)
      block = undefined
      continue
    }
    if (!turn) continue
    if (MARKER.test(line)) {
      block = { marker: line, lines: [] }
      turn.blocks.push(block)
      continue
    }
    block?.lines.push(line)
  }
  // Each block ends with the blank line that separates it from the next marker.
  for (const each of turns)
    for (const one of each.blocks) {
      assert.equal(one.lines.at(-1), "", `block "${one.marker}" doesn't end with a blank line`)
      one.lines.pop()
    }
  return turns
}

/** Reads the transcript's own lines: a fenced block, a moved payload, or text to the end of `lines`. */
class Reader {
  constructor(lines, files, where) {
    this.lines = lines
    this.at = 0
    this.files = files
    this.where = where
  }

  done() {
    return this.at >= this.lines.length
  }

  peek() {
    return this.lines[this.at]
  }

  next() {
    return this.lines[this.at++]
  }

  /** A file the transcript names, checked against its size and preview. */
  file(name, stated, label) {
    const bytes = this.files.get(name)
    assert.ok(bytes, `${this.where}: ${label} names ${name}, which isn't beside the transcript`)
    const previews = []
    while (this.peek()?.startsWith("> ")) previews.push(this.next().slice(2))
    if (name.startsWith("payloads/")) {
      const text = bytes.toString("utf8")
      const shown = text.split("\n").filter((line) => line.trim()).slice(0, 3)
      assert.ok(previews.length > 0 || !text.trim(), `${this.where}: ${name} is named with no preview`)
      for (const [index, preview] of previews.entries()) {
        const line = shown[index] ?? ""
        assert.ok(preview === line || (preview.endsWith("…") && line.startsWith(preview.slice(0, -1))), `${this.where}: ${name}'s preview line ${index + 1} isn't how it starts`)
      }
      assert.match(stated, /chars, \d[\d,]* lines?$/, `${this.where}: ${name} is named without its size`)
      return text
    }
    return bytes
  }

  /** What follows a label: a fence, or a moved payload on the label's own line. */
  labelled(label) {
    const line = this.next()
    const moved = MOVED.exec(line)
    if (moved && moved[1] === label.replace(/:$/, "")) return this.file(moved[2], moved[3], label)
    assert.equal(line, label, `${this.where}: expected "${label}"`)
    return this.fenced()
  }

  fenced() {
    const open = this.next()
    assert.ok(FENCE.test(open ?? ""), `${this.where}: expected a fence, found ${JSON.stringify(open)}`)
    const body = []
    while (this.peek() !== open) {
      assert.ok(!this.done(), `${this.where}: an unclosed fence`)
      body.push(this.next())
    }
    this.next()
    return body.join("\n")
  }

  /** Content that runs to the end of the block: fenced, moved, or as it is. */
  rest() {
    const first = this.peek()
    if (first !== undefined && FENCE.test(first)) {
      const text = this.fenced()
      assert.ok(this.done(), `${this.where}: lines after fenced content`)
      return text
    }
    const moved = first === undefined ? null : MOVED.exec(first)
    if (moved && moved[1] === undefined) {
      this.next()
      const text = this.file(moved[2], moved[3], "content")
      assert.ok(this.done(), `${this.where}: lines after a moved payload's preview`)
      return text
    }
    const text = this.lines.slice(this.at).join("\n")
    this.at = this.lines.length
    return text
  }
}

function parseValue(raw) {
  if (LITERAL.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** `key: value` lines back into the object they were written from. */
function readArguments(reader) {
  const value = {}
  while (!reader.done() && !DETAIL_LINE.test(reader.peek())) {
    const line = reader.next()
    const moved = MOVED.exec(line)
    if (moved && moved[1] !== undefined) {
      const key = moved[1].startsWith("\"") ? JSON.parse(moved[1]) : moved[1]
      const text = reader.file(moved[2], moved[3], key)
      value[key] = moved[2].endsWith(".json") ? JSON.parse(text) : text
      continue
    }
    const pair = KEY.exec(line)
    assert.ok(pair, `${reader.where}: "${line}" isn't an argument line`)
    const key = pair[1].startsWith("\"") ? JSON.parse(pair[1]) : pair[1]
    value[key] = pair[2] === undefined ? reader.fenced() : parseValue(pair[2])
  }
  return value
}

function parseObject(text) {
  if (!text.trimStart().startsWith("{") || /\d{16,}/.test(text)) return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The strings a call's arguments hold by name, as the builder reads them for repeated diffs and places. */
function strings(value) {
  return new Set(Object.values(value).filter((item) => typeof item === "string"))
}

function attachmentLine(reader, attachment, files) {
  const line = reader.next()
  assert.ok(line?.startsWith(`Attachment: ${attachment.name.replace(/\s*[\r\n]+\s*/g, " ")}`), `${reader.where}: attachment ${attachment.name} isn't named (${line})`)
  const copied = / → (attachments\/\S+)$/.exec(line)
  if (attachment.source.kind === "inline") {
    assert.ok(copied, `${reader.where}: inline attachment ${attachment.name} wasn't copied`)
    assert.ok(files.get(copied[1]).equals(Buffer.from(attachment.source.data, "base64")), `${reader.where}: ${copied[1]} isn't the attachment's bytes`)
  }
  if (attachment.source.kind === "url") assert.ok(line.endsWith(attachment.source.url))
  return copied?.[1]
}

/**
 * Holds `built` to `entries`: the turns newest first and complete, the index
 * one line per turn, and each entry's content recovered whole. Returns what
 * it checked.
 */
export function checkTranscript(entries, built, { firstTurn = 1 } = {}) {
  const files = new Map(built.files.map((file) => [file.name, file.bytes]))
  const expected = turnsOf(entries)
  const parsed = sections(built.markdown)
  const counts = { entries: 0, turns: parsed.length, moved: 0 }
  assert.equal(parsed.length, expected.length, "every turn has a section")
  const carried = expected.filter((turn) => !turn.lead).length
  assert.equal(built.turns, carried, "the count of turns")

  // Newest first, numbered from `firstTurn`.
  const numbers = parsed.map((turn) => turn.number)
  const want = expected.map((turn, index) => (turn.lead ? firstTurn - 1 : firstTurn + index - (expected[0].lead ? 1 : 0))).reverse()
  assert.deepEqual(numbers, want, "turns run newest first")

  // The index: one line per turn, newest first, before the first turn.
  const head = built.markdown.slice(0, built.markdown.indexOf(parsed[0]?.heading ?? "\u0000"))
  const index = head.split("\n").filter((line) => /^- \d+: /.test(line)).map((line) => Number(/^- (\d+):/.exec(line)[1]))
  assert.deepEqual(index, want, "the index lists every turn, newest first")

  for (const [position, section] of parsed.entries()) {
    const turn = expected[expected.length - 1 - position]
    let block = 0
    let model
    let named = true
    for (const entry of turn.entries) {
      const where = `turn ${section.number}, ${entry.type}${entry.id ? ` ${entry.id}` : ""}`
      const reply = ["text", "thinking", "attachment", "proposed-plan", "tool"].includes(entry.type)
      if (reply && entry.model !== undefined && entry.model !== model) {
        model = entry.model
        named = false
      }
      if ((entry.type === "text" && !entry.text) || (entry.type === "thinking" && !entry.text.trim())) continue
      const current = section.blocks[block++]
      assert.ok(current, `${where}: no block`)
      const reader = new Reader(current.lines, files, where)
      counts.entries += 1
      counts.moved += current.lines.filter((line) => MOVED.test(line)).length
      if (reply && !named) {
        assert.ok(current.marker.endsWith(` · ${model}`), `${where}: the model it changed to isn't named`)
        named = true
      }
      switch (entry.type) {
        case "user": {
          assert.match(current.marker, /^### User/, where)
          if (entry.contextFiles?.length) assert.equal(reader.next(), `Context files: ${entry.contextFiles.join(", ")}`, where)
          for (const attachment of entry.attachments ?? []) attachmentLine(reader, attachment, files)
          assert.equal(reader.rest(), entry.text, `${where}: the prompt's words`)
          break
        }
        case "text":
          assert.match(current.marker, /^### Agent/, where)
          assert.equal(reader.rest(), entry.text, `${where}: the answer's words`)
          break
        case "thinking":
          assert.match(current.marker, /^### Thinking/, where)
          assert.equal(reader.rest(), entry.text, `${where}: the thought`)
          break
        case "proposed-plan":
          assert.ok(current.marker.startsWith(`### Proposed plan (${entry.status}`), where)
          assert.equal(reader.rest(), entry.text, `${where}: the plan`)
          break
        case "plan": {
          assert.equal(current.marker, "### Plan", where)
          const marks = { completed: "[x]", pending: "[ ]", in_progress: "[~]" }
          assert.deepEqual(current.lines, entry.entries.map((item) => `- ${marks[item.status] ?? `[${item.status}]`} ${item.content}`), where)
          reader.at = current.lines.length
          break
        }
        case "attachment":
          assert.match(current.marker, /^### Attachment/, where)
          attachmentLine(reader, entry.attachment, files)
          break
        case "unread": {
          assert.ok(current.marker.startsWith(`### Unread record: ${entry.kind}`), where)
          if (entry.raw === undefined) break
          const line = reader.next()
          const moved = MOVED.exec(line)
          assert.deepEqual(JSON.parse(moved ? reader.file(moved[2], moved[3], "raw") : line), entry.raw, `${where}: the raw record`)
          break
        }
        case "event":
        case "provider-turn": {
          const label = entry.type === "event" ? entry.label : entry.reason
          const marker = /^### (?:Event|Harness turn)(?: \([^)]*\))*:(?: (.*))?$/.exec(current.marker)
          assert.ok(marker, `${where}: "${current.marker}" isn't an event's marker`)
          if (marker[1] === undefined) {
            assert.equal(reader.labelled("Label:"), label, `${where}: the label`)
            if (entry.detail !== undefined) assert.equal(reader.labelled("Detail:"), entry.detail, `${where}: the detail`)
          } else assert.equal(marker[1], entry.detail === undefined ? label : `${label} — ${entry.detail}`, `${where}: label and detail`)
          if (reader.peek()?.startsWith("Reports on ")) reader.next()
          if (entry.body) assert.equal(reader.rest(), entry.body, `${where}: the body`)
          else assert.ok(reader.done(), `${where}: lines after an event with no body`)
          break
        }
        case "tool": {
          const name = (entry.name ?? entry.title ?? "call").replace(/\s*[\r\n]+\s*/g, " ")
          assert.match(current.marker, /^### Call \d+: /, where)
          assert.ok(current.marker.includes(name), `${where}: the call's name`)
          if (entry.status && entry.status !== "completed") assert.ok(current.marker.includes(entry.status), `${where}: its status`)
          while (/^(?:Child agent|Names): /.test(reader.peek() ?? "")) reader.next()
          const object = entry.input === undefined ? undefined : parseObject(entry.input)
          let held = new Set()
          if (object) {
            assert.deepEqual(readArguments(reader), object, `${where}: the arguments`)
            held = strings(object)
          } else if (entry.input) {
            assert.equal(reader.labelled("Input:"), entry.input, `${where}: the input`)
            held.add(entry.input)
          }
          for (const detail of entry.details ?? []) {
            if (detail.type === "diff") {
              if (held.has(detail.newText) && (!detail.oldText || held.has(detail.oldText))) continue
              assert.ok(reader.next().startsWith(`Diff: ${detail.path}`), `${where}: the diff's path`)
              if (detail.oldText !== null) assert.equal(reader.labelled("before:"), detail.oldText, `${where}: the diff's before`)
              assert.equal(reader.labelled("after:"), detail.newText, `${where}: the diff's after`)
            } else if (detail.type === "location") {
              if (detail.line === undefined && held.has(detail.path)) continue
              assert.equal(reader.next(), `Location: ${detail.path}${detail.line === undefined ? "" : `:${detail.line}`}`, where)
            } else if (detail.type === "terminal") assert.equal(reader.next(), `Terminal: ${detail.terminalId}`, where)
            else if (detail.type === "plan") {
              assert.equal(reader.next(), "Plan:", where)
              for (let item = 0; item < detail.entries.length; item++) reader.next()
            } else reader.labelled("Review:")
          }
          for (const attachment of entry.attachments ?? []) attachmentLine(reader, attachment, files)
          while (reader.peek()?.startsWith("(The page ")) reader.next()
          if (entry.output) {
            assert.equal(reader.next(), "Output:", `${where}: no output`)
            assert.equal(reader.rest(), entry.output, `${where}: the output`)
          }
          break
        }
      }
      assert.ok(reader.done(), `${where}: lines left in its block: ${JSON.stringify(current.lines.slice(reader.at, reader.at + 3))}`)
    }
    assert.equal(block, section.blocks.length, `turn ${section.number}: blocks no entry accounts for`)
  }

  // Every file beside it is named in it.
  for (const name of files.keys()) assert.ok(built.markdown.includes(name), `${name} isn't named in the transcript`)
  return counts
}
