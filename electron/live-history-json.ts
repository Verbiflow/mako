import { z } from "zod"

// Parse one level at a time. A recursive JSON schema would clone the entire
// history before yielding its first frame, defeating bounded serialization.
const objectLevel = z.record(z.string(), z.unknown())
const level = z.union([
  z.string().transform(value => ({ kind: "string" as const, value })),
  z.union([z.number(), z.boolean(), z.null()]).transform(value => ({ kind: "scalar" as const, value })),
  z.array(z.unknown()).transform(value => ({ kind: "array" as const, value })),
  // Keep the original own keys after validation: Zod's reconstructed record
  // intentionally drops __proto__, but JSON history must retain that data key.
  z.custom<z.infer<typeof objectLevel>>(value => objectLevel.safeParse(value).success)
    .transform(value => ({ kind: "object" as const, value })),
])

/** Serialize trusted JSON-shaped history without allocating an entire giant
 * tool result's encoded string. Splitting strings before escaping preserves
 * even surrogate pairs and control characters across frame boundaries. */
function* pieces<Value>(input: Value): Generator<string> {
  const parsed = level.parse(input)
  if (parsed.kind === "string") {
    const value = parsed.value
    yield '"'
    for (let start = 0; start < value.length; start += 16 * 1024)
      yield JSON.stringify(value.slice(start, start + 16 * 1024)).slice(1, -1)
    yield '"'
  } else if (parsed.kind === "scalar") {
    yield JSON.stringify(parsed.value)
  } else if (parsed.kind === "array") {
    const value = parsed.value
    yield "["
    for (let index = 0; index < value.length; index++) {
      if (index) yield ","
      yield* pieces(value[index] ?? null)
    }
    yield "]"
  } else {
    yield "{"
    let comma = false
    for (const [key, item] of Object.entries(parsed.value)) {
      if (item === undefined) continue
      if (comma) yield ","
      comma = true
      yield JSON.stringify(key) + ":"
      yield* pieces(item)
    }
    yield "}"
  }
}

export function* historyJsonChunks<Value>(value: Value, size: number): Generator<string> {
  let pending = ""
  for (const piece of pieces(value)) {
    pending += piece
    while (pending.length >= size) {
      yield pending.slice(0, size)
      pending = pending.slice(size)
    }
  }
  if (pending) yield pending
}
