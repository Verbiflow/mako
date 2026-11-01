import { createHash } from "node:crypto"

/**
 * A long `cursor-agent` chat as its store holds one, made up: a system prompt, then `turns` prompts of `steps` tool
 * steps each, every message a content-addressed blob, and after each step a new root naming every message so far (the
 * protobuf's repeated field 1). Every eighth step reads a file of some 320 KB, every twelfth returns 660 KB and keeps a
 * snapshot of 650 KB beside it (field 2), as a real chat's reads and checkpoints do. Its text is words, so it
 * compresses as a chat's does. A headless agent's chat is a prompt or two and hundreds of steps: its last exchange is
 * most of it, as here by default (2 prompts of 80 steps, some 500 rows and 25 MB). The rows come in the order the
 * harness writes them, each root marked. Deterministic for a `seed`.
 */
export function largeCursorChat({ turns = 2, steps = 80, seed = 1, agentId = "0b5e55ed-c0de-4c0d-8c0d-1a76ec0c4a70" } = {}) {
  let state = seed >>> 0 || 1
  const random = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
  const words = Array.from({ length: 2048 }, (_, index) => `${WORDS[index % WORDS.length]}${index >= WORDS.length ? Math.floor(index / WORDS.length) : ""}`)
  const text = (bytes) => {
    const parts = []
    let length = 0
    while (length < bytes) {
      const word = words[Math.floor(random() * words.length)]
      parts.push(word)
      length += word.length + 1
      if (random() < 0.08) parts.push(random() < 0.5 ? "\n" : "."), (length += 1)
    }
    return parts.join(" ")
  }
  const rows = []
  const messages = []
  const blob = (data, root = false) => {
    const id = createHash("sha256").update(data).digest("hex")
    rows.push({ id, data, root })
    return id
  }
  const message = (value) => messages.push(blob(Buffer.from(JSON.stringify(value))))
  const root = () => blob(Buffer.concat([...messages.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")])), Buffer.from([0x1a, 0x02, 0x6f, 0x6b])]), true)
  message({ role: "system", content: text(30_000) })
  root()
  let taken = 0
  for (let turn = 0; turn < turns; turn++) {
    message({ role: "user", content: [{ type: "text", text: `<user_query>\nTurn ${turn}: ${text(600 + Math.floor(random() * 3_000))}\n</user_query>` }] })
    root()
    for (let step = 0; step < steps; step++, taken++) {
      const call = `toolu_${turn}_${step}_${Math.floor(random() * 1e9).toString(36)}`
      const read = taken % 8 === 2
      const large = taken % 12 === 4
      message({ role: "assistant", content: [{ type: "reasoning", text: text(400 + Math.floor(random() * 2_000)) }, { type: "tool-call", toolCallId: call, toolName: read ? "Read" : "Shell", args: read ? { path: `/work/docs/plan-${taken}.md` } : { command: `npm run check -- ${text(80)}` } }] })
      const output = large ? 660_000 : read ? 320_000 : 500 + Math.floor(random() * 15_000)
      message({ role: "tool", content: [{ type: "tool-result", toolCallId: call, toolName: read ? "Read" : "Shell", result: `Exit code: 0\n\n${text(output)}` }] })
      if (large) {
        const path = Buffer.from(`/work/docs/plan-${taken}.md`)
        const body = Buffer.from(text(650_000))
        blob(Buffer.concat([Buffer.from([0x12]), varint(path.length + body.length + 8), Buffer.from([0x0a]), varint(path.length), path, Buffer.from([0x12]), varint(body.length), body]))
      }
      root()
    }
    message({ role: "assistant", content: [{ type: "text", text: text(800 + Math.floor(random() * 2_500)) }] })
    root()
  }
  return { rows, agentId }
}

function varint(value) {
  const bytes = []
  let left = value
  while (left >= 0x80) {
    bytes.push((left & 0x7f) | 0x80)
    left = Math.floor(left / 0x80)
  }
  bytes.push(left)
  return Buffer.from(bytes)
}

const WORDS = `the record store takes each session as its harness writes it and the account keeps a copy of every unit by hash
so a write on this mac reaches every other device within a frame while the daemon answers the windows that read it
a page of the transcript the rail status a capture a push a copy each named while it runs function const return
await import export class interface type string number boolean null undefined true false if else for while switch
case break continue try catch finally throw new this super extends implements private public readonly static async
src packages sessions host protocol client web test scripts docs build dist node modules json yaml markdown sqlite
blobs meta root hash chunk pack bundle version unit layout schema index view cache follow entries reload stamp`.split(/\s+/)
