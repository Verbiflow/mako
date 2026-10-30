import { z } from "zod"
import type { JsonValue } from "../contracts/json.js"
import { isBoolean, isJsonObject, isString, numberValue } from "../base/json-values.js"

/**
 * The history a reader serializes: typed internal values (a snapshot, a page,
 * an entry, an original), JSON-shaped all the way down. Its top is checked to
 * be a JSON value; what is under it is told apart value by value below, by
 * what each is, without a schema run on each: one run on every value of a
 * large conversation's snapshot held the host's loop for a tenth of a second
 * a read, all of it on the loop.
 */
const JsonTop = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
const HistoryJsonSchema = z.custom<JsonValue>((value) => JsonTop.safeParse(value).success)

/** Serialize trusted JSON-shaped history without allocating an entire giant
 * tool result's encoded string. Splitting strings before escaping preserves
 * even surrogate pairs and control characters across frame boundaries. An
 * own `__proto__` key is data, and kept. */
function* pieces(input: JsonValue | undefined): Generator<string> {
  if (isString(input)) {
    yield '"'
    for (let start = 0; start < input.length; start += 16 * 1024)
      yield JSON.stringify(input.slice(start, start + 16 * 1024)).slice(1, -1)
    yield '"'
  } else if (input === null || isBoolean(input) || numberValue(input) !== undefined) {
    yield JSON.stringify(input)
  } else if (Array.isArray(input)) {
    yield "["
    for (let index = 0; index < input.length; index++) {
      if (index) yield ","
      yield* pieces(input[index] ?? null)
    }
    yield "]"
  } else if (isJsonObject(input)) {
    yield "{"
    let comma = false
    for (const [key, item] of Object.entries(input)) {
      if (item === undefined) continue
      if (comma) yield ","
      comma = true
      yield JSON.stringify(key) + ":"
      yield* pieces(item)
    }
    yield "}"
  } else throw new Error("History holds a value JSON can't carry")
}

export function* historyJsonChunks<Value>(value: Value, size: number): Generator<string> {
  let pending = ""
  for (const piece of pieces(HistoryJsonSchema.parse(value))) {
    pending += piece
    while (pending.length >= size) {
      yield pending.slice(0, size)
      pending = pending.slice(size)
    }
  }
  if (pending) yield pending
}
