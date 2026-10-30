import { constants, createZstdCompress, createZstdDecompress, zstdDecompressSync, type ZstdCompress, type ZstdDecompress } from "node:zlib"

/**
 * zstd frames made and read through one context each way, kept for as long as their owner. zlib's one-shot calls
 * (`zstdCompressSync`, `zstdDecompressSync`) make a native context for each frame and free it after, and each frame's
 * output is a view of a 128 KiB buffer that lives until a GC. The two interleave in malloc's small regions, which
 * macOS keeps once emptied: 2,400 frames left 110 MB that no GC returned, and a 60 MiB catch-up took the sync daemon
 * past its memory guard with 50 MB of heap. Here a frame is one write to a stream that stays open, so one context
 * serves every frame, and each frame comes out in a buffer of its own size.
 *
 * Frames go one at a time each way, in the order asked. Each made is a whole frame, its content size in its header,
 * read by any zstd decoder alone. A stream decoder takes what it's given and waits for the rest: a cut frame gives
 * nothing and no error and leaves the context mid-frame, so the next frame read through it fails; and it stops at a
 * frame's end, so bytes after it went unread. So what's read must be exactly one frame by its own structure (its
 * header and its blocks' headers, `frameLength`), and give exactly the content size its header names; anything else
 * rejects its call and drops the context, and the next call opens a new one. A whole frame that names no size is read
 * on its own, by `zstdDecompressSync`.
 */
export class ZstdFrames {
  readonly #compressing = new FrameStream(() => createZstdCompress({ flush: constants.ZSTD_e_end, params: { [constants.ZSTD_c_compressionLevel]: 3 } }))
  readonly #decompressing = new FrameStream(() => createZstdDecompress())

  /** `bytes` as one zstd frame, at level 3. */
  compress(bytes: Uint8Array): Promise<Buffer> {
    return this.#compressing.run(bytes)
  }

  /** The bytes of the zstd frame `frame`; rejects unless it is one whole frame. */
  async decompress(frame: Uint8Array): Promise<Buffer> {
    const header = frameHeader(frame)
    if (header.kind === "not a frame") throw new ZstdFrameError("Not a zstd frame")
    const length = frameLength(frame)
    if (length !== frame.byteLength) throw new ZstdFrameError(length === undefined ? "A zstd frame cut short" : `A zstd frame of ${length} bytes, with ${frame.byteLength - length} more after it`)
    if (header.kind === "no size") return zstdDecompressSync(frame)
    return this.#decompressing.run(frame, header.size)
  }

  /** Frees both contexts; a later call opens new ones. */
  close(): void {
    this.#compressing.close()
    this.#decompressing.close()
  }
}

/** A frame that isn't one whole zstd frame: not one at all, cut short, or more than one. */
export class ZstdFrameError extends Error {
  override name = "ZstdFrameError"
}

/** What a zstd frame's header says of it: not a frame, a frame that names no content size, or its content size. */
export type FrameHeader = { kind: "not a frame" } | { kind: "no size" } | { kind: "sized"; size: number }

/** The magic number every zstd frame opens with. */
const ZSTD_MAGIC = 0xfd2fb528

/** Reads a zstd frame header from the start of `bytes` (RFC 8878, 3.1.1.1). */
export function frameHeader(bytes: Uint8Array): FrameHeader {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.length < 5 || header.readUInt32LE(0) !== ZSTD_MAGIC) return { kind: "not a frame" }
  const descriptor = header[4]!
  const sizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!
  const sizeBytes = sizeFlag === 0 ? singleSegment : [1, 2, 4, 8][sizeFlag]!
  if (!sizeBytes) return { kind: "no size" }
  const at = 5 + (singleSegment ? 0 : 1) + dictionaryBytes
  if (header.length < at + sizeBytes) return { kind: "not a frame" }
  if (sizeBytes === 1) return { kind: "sized", size: header[at]! }
  if (sizeBytes === 2) return { kind: "sized", size: header.readUInt16LE(at) + 256 }
  if (sizeBytes === 4) return { kind: "sized", size: header.readUInt32LE(at) }
  return { kind: "sized", size: Number(header.readBigUInt64LE(at)) }
}

/**
 * The length of the zstd frame `bytes` opens with, from its header and its blocks' headers (RFC 8878, 3.1.1); undefined
 * when it isn't a frame or is cut short.
 */
export function frameLength(bytes: Uint8Array): number | undefined {
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (frame.length < 5 || frame.readUInt32LE(0) !== ZSTD_MAGIC) return undefined
  const descriptor = frame[4]!
  const sizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!
  const sizeBytes = sizeFlag === 0 ? singleSegment : [1, 2, 4, 8][sizeFlag]!
  let at = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes
  for (;;) {
    if (at + 3 > frame.length) return undefined
    const block = frame.readUIntLE(at, 3)
    const type = (block >> 1) & 3
    if (type === 3) return undefined
    // An RLE block keeps one byte, however many it stands for.
    at += 3 + (type === 1 ? 1 : block >>> 3)
    if (at > frame.length) return undefined
    if (block & 1) break
  }
  at += checksum * 4
  return at > frame.length ? undefined : at
}

/** One stream, and what each write of it put out: a write is a frame in, everything it gave out. */
class FrameStream {
  #stream: ZstdCompress | ZstdDecompress | null = null
  #out: Buffer[] = []
  #turn: Promise<unknown> = Promise.resolve()
  /** The write under way's rejection, for an error its stream emits rather than hands its callback. */
  #failed: ((error: Error) => void) | null = null

  constructor(private readonly open: () => ZstdCompress | ZstdDecompress) {}

  /** `input` through the stream; with `size`, rejects unless it gave out exactly that many bytes. */
  run(input: Uint8Array, size?: number): Promise<Buffer> {
    const run = this.#turn.then(() => this.#write(input, size))
    this.#turn = run.catch(() => undefined)
    return run
  }

  /** Drops the context; a write under way rejects. */
  close(): void {
    const failed = this.#failed
    this.#failed = null
    this.#stream?.destroy()
    this.#stream = null
    this.#out = []
    failed?.(new ZstdFrameError("The zstd context was closed under a frame"))
  }

  async #write(input: Uint8Array, size: number | undefined): Promise<Buffer> {
    const stream = this.#stream ?? this.#start()
    try {
      return await this.#written(stream, input, size)
    } catch (error) {
      // Whatever failed may have left the context mid-frame: the next call opens a new one.
      if (this.#stream === stream) this.close()
      throw error
    }
  }

  #written(stream: ZstdCompress | ZstdDecompress, input: Uint8Array, size: number | undefined): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.#failed = reject
      stream.write(input, (error) => {
        if (this.#stream !== stream) return
        this.#failed = null
        const out = Buffer.concat(this.#out)
        this.#out = []
        if (error) reject(error)
        else if (size !== undefined && out.length !== size) reject(new ZstdFrameError(`A zstd frame naming ${size} bytes gave ${out.length}: it isn't one whole frame`))
        else resolve(out)
      })
    })
  }

  #start(): ZstdCompress | ZstdDecompress {
    const stream = this.open()
    stream.on("data", (part: Buffer) => {
      if (this.#stream === stream) this.#out.push(part)
    })
    stream.on("error", (error) => {
      if (this.#stream !== stream) return
      const failed = this.#failed
      this.#failed = null
      this.close()
      failed?.(error)
    })
    this.#stream = stream
    return stream
  }
}
