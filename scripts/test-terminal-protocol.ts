import { TerminalHistoryFilter } from "../electron/terminal-history-filter.js"
import assert from "node:assert/strict"
import {
  BoundedTerminalHistory,
  JsonLineDecoder,
  TERMINAL_HISTORY_BYTES,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_PROTOCOL_VERSION,
  clampTerminalSize,
  parseTerminalRequest,
  splitTerminalInput,
  splitTerminalOutput,
} from "../electron/terminal-protocol.js"

const size = clampTerminalSize(50_000, -2)
assert.deepEqual(size, { cols: TERMINAL_MAX_COLS, rows: 1 })
assert.equal(clampTerminalSize(80, 24).cols, 80)
assert.equal(clampTerminalSize(80, 24).rows, 24)
assert.equal(TERMINAL_MAX_ROWS, 200)

const accepted = parseTerminalRequest({
  protocol: TERMINAL_PROTOCOL_VERSION,
  id: 1,
  type: "write",
  sessionId: "session-1",
  data: "x".repeat(TERMINAL_MAX_INPUT_BYTES),
})
assert.equal(accepted?.type, "write")
assert.deepEqual(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 3,
    type: "ack",
    sessionId: "session-1",
    sequence: 12,
  }),
  { id: 3, type: "ack", sessionId: "session-1", sequence: 12 }
)
assert.deepEqual(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 4,
    type: "detach",
    sessionId: "session-1",
  }),
  { id: 4, type: "detach", sessionId: "session-1" }
)
assert.deepEqual(
  parseTerminalRequest({
    protocol: 99,
    id: 9,
    type: "hello",
    clientVersion: "99",
  }),
  {
    protocol: 99,
    id: 9,
    type: "hello",
    clientVersion: "99",
  }
)
assert.equal(
  parseTerminalRequest({
    protocol: TERMINAL_PROTOCOL_VERSION,
    id: 2,
    type: "write",
    sessionId: "session-1",
    data: "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1),
  }),
  null
)

const history = new BoundedTerminalHistory()
history.append("a".repeat(TERMINAL_HISTORY_BYTES))
history.append("tail")
assert.equal(history.byteLength, TERMINAL_HISTORY_BYTES)
assert.ok(history.text().endsWith("tail"))
const restored = new BoundedTerminalHistory()
restored.restore(history.base64())
assert.equal(restored.text(), history.text())

const output = `${"界".repeat(40_000)}${"🙂".repeat(20_000)}`
const chunks = splitTerminalOutput(output)
assert.ok(chunks.length > 1)
assert.equal(chunks.join(""), output)
assert.ok(chunks.every((chunk) => !chunk.includes("�")))
assert.ok(
  splitTerminalInput(output).every(
    (chunk) => Buffer.byteLength(chunk) <= TERMINAL_MAX_INPUT_BYTES
  )
)

const decoder = new JsonLineDecoder()
assert.deepEqual(decoder.push(Buffer.from('{"one":1')), [])
assert.deepEqual(decoder.push(Buffer.from('}\n{"two":2}\n')), [
  { one: 1 },
  { two: 2 },
])

console.log("terminal protocol bounds passed")

// Control traffic may cross any PTY chunk boundary. Drawing and mode changes survive.
const drawing = "hello\x1b[31mred\x1b[0m\x1b[?1049h\x1b[2;3Hscreen\x1b[?1049l"
const queries = [
  "\x1b[6n",
  "\x1b[?2004$p",
  "\x1b[>0q",
  "\x1b[?u",
  "\x1b]11;?\x07",
  "\x1bP$qm\x1b\\",
  "\x1b]52;c;clipboard\x07",
  "\x9b6n",
  "\x9d10;?\x9c",
]
for (const query of queries) {
  for (let split = 0; split <= query.length; split++) {
    const filter = new TerminalHistoryFilter()
    assert.equal(
      filter.push(drawing + query.slice(0, split)) +
        filter.push(query.slice(split) + drawing),
      drawing + drawing
    )
  }
}
const filter = new TerminalHistoryFilter()
assert.equal(filter.push("\x1b]" + "a".repeat(100_000)), "")
assert.equal(filter.push("discarded\x1b") + filter.push("\\visible"), "visible")
const unicodeHistory = new BoundedTerminalHistory(17)
unicodeHistory.append("🙂界".repeat(20))
assert.ok(
  !unicodeHistory.text().includes("�"),
  "Eviction must not retain incomplete UTF-8 prefixes"
)
console.log(
  "terminal history: split control traffic, drawing modes, bounded strings and UTF-8 eviction passed"
)
