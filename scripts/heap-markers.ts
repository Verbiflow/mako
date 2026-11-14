import { Session } from "node:inspector/promises"
import { readFileSync } from "node:fs"
import { writeHeapSnapshot } from "node:v8"
import { z } from "zod"

/** Where a heap can hold text: its strings, and the bytes of its buffers, views and array buffers. */
export const REPRESENTATIONS = ["string", "typed array", "data view", "array buffer", "shared array buffer"] as const
export type Representation = (typeof REPRESENTATIONS)[number]
/** Text in a buffer's bytes outside the one small view that keeps it: read through `.buffer`, so it counts as kept. */
export const BEHIND_A_VIEW = ["array buffer", "shared array buffer"] as const

// Buffer's pool hands out slices of one shared allocation, so the bytes of a Buffer long gone stay in it, reachable
// from whichever slice is alive and telling nothing about what a harness kept. With no pool every Buffer has its own
// allocation and nothing has to be excused from the search: a buffer still here is one something holds.
Buffer.poolSize = 0

const Found = z.array(z.object({ in: z.enum(REPRESENTATIONS), text: z.string() }))
const Remote = z.object({ result: z.object({ objectId: z.string() }) })
const Queried = z.object({ objects: z.object({ objectId: z.string() }) })
const Returned = z.object({ result: z.object({ value: z.unknown() }) })
const Thrown = z.object({ exceptionDetails: z.object({ text: z.string(), exception: z.object({ description: z.string() }).optional() }) })

/**
 * Runs inside this isolate over every object of one kind, reading bytes as the heap holds them: a view's own window
 * (a small typed array's bytes have no array buffer to find) and every array buffer whole, whatever views it. Text
 * is matched in UTF-8 and UTF-16LE.
 */
const SEARCH = String.raw`function (prefix, kind) {
  const tail = /^[0-9A-Za-z-]+/
  const utf8 = new TextEncoder().encode(prefix)
  const utf16 = new Uint8Array(prefix.length * 2)
  for (let i = 0; i < prefix.length; i += 1) utf16[i * 2] = prefix.charCodeAt(i)
  const found = []
  const read = (bytes) => {
    for (const [needle, decode] of [[utf8, (b) => new TextDecoder().decode(b)], [utf16, (b) => new TextDecoder("utf-16le").decode(b)]]) {
      outer: for (let at = bytes.indexOf(needle[0]); at >= 0 && at <= bytes.length - needle.length; at = bytes.indexOf(needle[0], at + 1)) {
        for (let k = 1; k < needle.length; k += 1) if (bytes[at + k] !== needle[k]) continue outer
        const text = decode(bytes.subarray(at, Math.min(bytes.length, at + needle.length + 256 * (needle === utf16 ? 2 : 1))))
        found.push({ in: kind, text: prefix + (tail.exec(text.slice(prefix.length)) || [""])[0] })
      }
    }
  }
  const length = (owner, item) => {
    try { return Object.getOwnPropertyDescriptor(owner.prototype, "byteLength").get.call(item) } catch { return undefined }
  }
  for (const item of this) {
    if (kind === "array buffer" || kind === "shared array buffer") {
      if (length(kind === "array buffer" ? ArrayBuffer : SharedArrayBuffer, item)) read(new Uint8Array(item))
    } else if (ArrayBuffer.isView(item)) {
      read(new Uint8Array(item.buffer, item.byteOffset, item.byteLength))
    }
  }
  return found
}`

/**
 * Every piece of text starting `prefix` the heap still holds, after a collection, with where it was found. Strings
 * come from a heap snapshot; bytes from every live typed array (Buffers included), DataView, ArrayBuffer and
 * SharedArrayBuffer, which a snapshot's strings never show.
 */
export async function heapMarkers(prefix: string, snapshot: string): Promise<{ in: Representation; text: string }[]> {
  const session = new Session()
  session.connect()
  try {
    await session.post("HeapProfiler.collectGarbage")
    // The strings first: what the byte search returns is strings too, and would be found here.
    writeHeapSnapshot(snapshot)
    const body = readFileSync(snapshot, "latin1")
    const found: { in: Representation; text: string }[] = []
    for (let at = body.indexOf(prefix); at >= 0; at = body.indexOf(prefix, at + 1))
      found.push({ in: "string", text: prefix + (/^[0-9A-Za-z-]+/.exec(body.slice(at + prefix.length, at + prefix.length + 256))?.[0] ?? "") })
    const kinds: [Representation, string][] = [
      ["typed array", "Object.getPrototypeOf(Uint8Array.prototype)"],
      ["data view", "DataView.prototype"],
      ["array buffer", "ArrayBuffer.prototype"],
      ["shared array buffer", "SharedArrayBuffer.prototype"],
    ]
    for (const [kind, prototype] of kinds) {
      const proto = Remote.parse(await session.post("Runtime.evaluate", { expression: prototype })).result.objectId
      const all = Queried.parse(await session.post("Runtime.queryObjects", { prototypeObjectId: proto })).objects.objectId
      const result = await session.post("Runtime.callFunctionOn", {
        objectId: all,
        functionDeclaration: SEARCH,
        arguments: [{ value: prefix }, { value: kind }],
        returnByValue: true,
      })
      const thrown = Thrown.safeParse(result)
      if (thrown.success) throw new Error(`The ${kind} search threw: ${thrown.data.exceptionDetails.exception?.description ?? thrown.data.exceptionDetails.text}`)
      found.push(...Found.parse(Returned.parse(result).result.value))
    }
    return found
  } finally {
    session.disconnect()
  }
}

/** Controls held until released. */
export interface PlantedControls {
  release(): void
}

/** The text a control in `kind` carries. Build it only after the search, so no string of it exists before. */
export function controlText(prefix: string, kind: Representation, id: string): string {
  return `${prefix}${kind.replaceAll(" ", "-")}-${id}`
}

/** The text a control keeps in the bytes of `kind` beyond the one-byte view that holds it. */
export function behindAViewText(prefix: string, kind: (typeof BEHIND_A_VIEW)[number], id: string): string {
  return controlText(`${prefix}behind-a-view-`, kind, id)
}

/** A large allocation kept only by a one-byte view of its first byte, with `text` further in. */
function behindAView(allocation: ArrayBufferLike, text: string): Uint8Array {
  new TextEncoder().encodeInto(text, new Uint8Array(allocation, 1024))
  return new Uint8Array(allocation, 0, 1)
}

/**
 * Text kept in each representation, held until `release`: what a leaking harness would keep, so a search that
 * misses any of them can't pass for one that finds nothing. Only the string control is ever a string; the others
 * are bytes whose text was a temporary, gone at the next collection.
 */
export function plantControls(prefix: string, id: string): PlantedControls {
  const bytes = (kind: Representation) => new TextEncoder().encode(controlText(prefix, kind, id))
  const shared = new SharedArrayBuffer(bytes("shared array buffer").length)
  new Uint8Array(shared).set(bytes("shared array buffer"))
  const held: unknown[] = [
    // One string, not a pair of pieces: a snapshot lists the pieces of a concatenation apart.
    Buffer.from(bytes("string")).toString("utf8"),
    Uint16Array.from(controlText(prefix, "typed array", id), (char) => char.charCodeAt(0)),
    new DataView(bytes("data view").buffer),
    bytes("array buffer").buffer,
    shared,
    behindAView(new ArrayBuffer(4096), behindAViewText(prefix, "array buffer", id)),
    behindAView(new SharedArrayBuffer(4096), behindAViewText(prefix, "shared array buffer", id)),
  ]
  return { release: () => { held.length = 0 } }
}
