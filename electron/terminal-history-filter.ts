/** Retained output is a replay, not a new conversation with the live PTY.
 * Keep drawing/mode sequences, omit device queries and their replies. Parsing
 * spans PTY chunks, and unfinished control strings have a fixed memory bound.
 */
export class TerminalHistoryFilter {
  #pending = ""
  #discardString = false
  readonly #onTitle?: (title: string) => void
  constructor(onTitle?: (title: string) => void) {
    this.#onTitle = onTitle
  }

  push(data: string): string {
    const input = this.#pending + data
    this.#pending = ""
    const output: string[] = []
    let start = 0
    let index = 0
    if (this.#discardString) {
      const end = stringEnd(input, 0)
      if (end === undefined) {
        this.#pending = input.endsWith("\x1b") ? "\x1b" : ""
        return ""
      }
      this.#discardString = false
      start = index = end
    }
    while (index < input.length) {
      const code = input.charCodeAt(index)
      if (
        code !== 27 &&
        code !== 0x9b &&
        code !== 0x9d &&
        code !== 0x90 &&
        code !== 0x9e &&
        code !== 0x9f
      ) {
        index++
        continue
      }
      output.push(input.slice(start, index))
      const escape = code === 27
      const kind = escape ? input.charCodeAt(index + 1) : code
      const bodyStart = index + (escape ? 2 : 1)
      let end: number | undefined
      let strip = false
      const csi = kind === (escape ? 0x5b : 0x9b)
      const string = [
        escape ? 0x5d : 0x9d,
        escape ? 0x50 : 0x90,
        escape ? 0x5e : 0x9e,
        escape ? 0x5f : 0x9f,
      ].includes(kind)
      if (csi) {
        for (let cursor = bodyStart; cursor < input.length; cursor++) {
          const final = input.charCodeAt(cursor)
          if (final < 0x40 || final > 0x7e) continue
          end = cursor + 1
          const body = input.slice(bodyStart, cursor)
          const command = input[cursor]
          strip =
            command === "n" ||
            command === "c" ||
            (command === "R" && /^[0-9;?]*$/.test(body)) ||
            ((command === "p" || command === "y") && body.endsWith("$")) ||
            (command === "q" && body.startsWith(">")) ||
            (command === "u" && body.startsWith("?")) ||
            (command === "t" && /^(?:1[3489]|2[01])(?:;|$)/.test(body))
          break
        }
      } else if (string) {
        end = stringEnd(input, bodyStart)
        if (end !== undefined) {
          const body = input.slice(
            bodyStart,
            input.slice(0, end).endsWith("\x1b\\") ? end - 2 : end - 1
          )
          const osc = kind === (escape ? 0x5d : 0x9d)
          if (osc && /^(?:0|2);/.test(body)) {
            const title = body
              .slice(2)
              .split("")
              .filter((character) => character.charCodeAt(0) >= 32)
              .join("")
              .trim()
              .slice(0, 120)
            if (title) this.#onTitle?.(title)
          }
          // Clipboard and colour queries must never run again on reconnect.
          strip = osc
            ? /^(?:52;|(?:4|10|11|12);.*(?:\?|rgb:))/.test(body)
            : /^[01]?[$+][qr]/.test(body)
        }
      } else if (escape) {
        for (let cursor = index + 1; cursor < input.length; cursor++) {
          const byte = input.charCodeAt(cursor)
          if (byte >= 0x20 && byte <= 0x2f) continue
          end = cursor + 1
          strip = input.slice(index, end) === "\x1bZ"
          break
        }
      }
      if (end === undefined) {
        const pending = input.slice(index)
        if (pending.length <= 8192) this.#pending = pending
        else if (string) {
          this.#discardString = true
          this.#pending = input.endsWith("\x1b") ? "\x1b" : ""
        }
        return output.join("")
      }
      if (!strip) output.push(input.slice(index, end))
      start = index = end
    }
    output.push(input.slice(start))
    return output.join("")
  }
}

function stringEnd(input: string, start: number): number | undefined {
  for (let index = start; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code === 7 || code === 0x9c) return index + 1
    if (code === 27 && input[index + 1] === "\\") return index + 2
  }
}
