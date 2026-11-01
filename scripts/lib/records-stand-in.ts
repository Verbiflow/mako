import { createServer, type IncomingMessage, type Server } from "node:http"
import { performance } from "node:perf_hooks"
import { zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { decodeChunkPack, decodeRecordPush, RecordBundleSchema, type RecordBundle, type RecordPushAnswer } from "@mako/protocol/records"

/**
 * The account's records routes for one device's two forms (the originals and the reading copies), in memory: chunks
 * by hash, each bundle taken. The sync benches (`bench-sync-pipeline.ts`, `bench-syncd-loop.ts`) point a real sync
 * daemon's links at it. A mark (`mk<n>x`) in a chunk's bytes counts as in the account once a bundle names the chunk.
 */
export class RecordsStandIn {
  readonly chunks = new Map<string, number[]>()
  /** When each mark was first named by a bundle the stand-in took, by form. */
  readonly arrived = { originals: new Map<number, number>(), copies: new Map<number, number>() }
  readonly sent = { originals: 0, copies: 0 }
  readonly calls: Record<string, number> = {}
  readonly holdings = new Map<string, Record<string, number>>()
  /** Each session's harness, by native id, as its bundles named it. */
  readonly harnesses = new Map<string, string>()
  /** Versions sent again that the stand-in already held: an upload taken twice. */
  duplicates = 0
  server: Server | undefined

  /** `port` 0 listens on any free port; `gatewayMs` holds each upload's answer that long, as a busy account does. */
  constructor(private port: number, private readonly gatewayMs = 0) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.#answer(request).then(
        ({ status, body }) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(body))
        },
        (error: Error) => {
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ title: error.message }))
        }
      )
    })
    await new Promise<void>((done) => this.server?.listen(this.port, "127.0.0.1", done))
    this.port = z.object({ port: z.number() }).parse(this.server.address()).port
  }

  /** The links a daemon is given (`syncOriginals`, `syncCopies`) for this stand-in, as device `device`. */
  links(device = "d-bench") {
    const base = (form: string) => `http://127.0.0.1:${this.port}/v1/devices/${device}/${form}`
    return {
      originals: { id: base("originals"), base: base("originals"), authorization: "Bearer bench" },
      copies: { id: base("records"), base: base("records"), authorization: "Bearer bench" },
    }
  }

  /** How many units of a session the account holds in `form`. */
  units(form: "originals" | "copies", nativeId: string): number {
    return Object.keys(this.holdings.get(`${form}\n${nativeId}`) ?? {}).length
  }

  async #answer(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(request.url ?? "/", "http://stand.in")
    const form = url.pathname.includes("/originals") ? "originals" : "copies"
    const route = url.pathname.replace(/^.*\/(originals|records)/, "")
    const body = await new Promise<Buffer>((done) => {
      const parts: Buffer[] = []
      request.on("data", (part: Buffer) => parts.push(part))
      request.on("end", () => done(Buffer.concat(parts)))
    })
    const key = `${request.method} ${route.split("?")[0]}`
    this.calls[key] = (this.calls[key] ?? 0) + 1
    this.sent[form] += body.length
    // A gateway that takes its time over what's uploaded, as the account's did: the client holds each pack until it answers.
    if (this.gatewayMs && (key === "PUT /chunks" || key === "POST /sessions/with-chunks")) await delay(this.gatewayMs)
    if (key === "POST /chunks/missing") {
      const { hashes } = z.object({ hashes: z.array(z.string()) }).parse(JSON.parse(body.toString()))
      return { status: 200, body: { missing: hashes.filter((hash) => !this.chunks.has(hash)) } }
    }
    if (key === "PUT /chunks") {
      const pack = decodeChunkPack(body)
      for (const chunk of pack) this.#keep(chunk)
      return { status: 200, body: { taken: pack.length } }
    }
    if (key === "POST /sessions/with-chunks") {
      const { bundle, pack } = decodeRecordPush(body)
      for (const chunk of decodeChunkPack(pack)) this.#keep(chunk)
      const missing = bundle.units.flatMap((unit) => unit.versions.flatMap((version) => hashesOf(version.chunks))).filter((hash) => !this.chunks.has(hash))
      if (missing.length) return { status: 409, body: { missing } }
      return { status: 200, body: this.#take(form, bundle) }
    }
    if (key === "POST /sessions") return { status: 200, body: this.#take(form, RecordBundleSchema.parse(JSON.parse(body.toString()))) }
    if (key === "GET /sessions/holdings") return { status: 200, body: { holdings: this.holdings.get(`${form}\n${url.searchParams.get("nativeId")}`) ?? {}, next: null } }
    if (key === "GET /sessions") {
      const sessions = [...this.holdings].filter(([held]) => held.startsWith(`${form}\n`)).map(([held, units]) => ({
        harness: this.harnesses.get(held.slice(form.length + 1)) ?? "codex", nativeId: held.slice(form.length + 1), units: Object.keys(units).length, versions: Object.values(units).reduce((total, head) => total + head + 1, 0), through: 0,
      }))
      return { status: 200, body: { sessions } }
    }
    return { status: 404, body: { title: `No ${key}` } }
  }

  #keep(chunk: { hash: string; codec: number; body: Uint8Array }): void {
    if (this.chunks.has(chunk.hash)) return
    const plain = chunk.codec === 1 ? zstdDecompressSync(chunk.body) : Buffer.from(chunk.body)
    this.chunks.set(chunk.hash, [...plain.toString("latin1").matchAll(/mk(\d+)x/g)].map((match) => Number(match[1])))
  }

  #take(form: "originals" | "copies", bundle: RecordBundle): RecordPushAnswer {
    const now = performance.now()
    const held = this.holdings.get(`${form}\n${bundle.nativeId}`) ?? {}
    this.harnesses.set(bundle.nativeId, bundle.harness)
    let versions = 0
    for (const unit of bundle.units)
      for (const version of unit.versions) {
        versions += 1
        if ((held[unit.key] ?? -1) >= version.seq) this.duplicates += 1
        held[unit.key] = Math.max(held[unit.key] ?? -1, version.seq)
        for (const hash of hashesOf(version.chunks)) for (const mark of this.chunks.get(hash) ?? []) if (!this.arrived[form].has(mark)) this.arrived[form].set(mark, now)
      }
    this.holdings.set(`${form}\n${bundle.nativeId}`, held)
    return { ok: true, versions, held: 0, through: versions }
  }
}

const hashesOf = (chunks: string) => chunks.match(/.{64}/g) ?? []
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
