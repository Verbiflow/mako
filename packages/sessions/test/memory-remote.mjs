import { planRecordImport, RecordConflictError } from "@mako/protocol/records"

/** The gateway's records routes in memory: chunks kept once by hash, versions taken by the protocol's rule. */
export class MemoryRemote {
  constructor(id) {
    Object.assign(this, { id, chunks: new Map(), units: new Map(), versions: [], bytes: 0, pushed: [] })
  }
  async missing(hashes) {
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack) {
    for (const chunk of pack) this.#keep(chunk)
    return { taken: pack.length }
  }
  async readChunks(hashes) {
    return hashes.flatMap((hash) => this.chunks.get(hash) ?? [])
  }
  async push(bundle) {
    return this.#take(bundle)
  }
  async pushWith(bundle, pack) {
    for (const chunk of pack) this.#keep(chunk)
    return this.#take(bundle)
  }
  async holdings() {
    return { holdings: {}, next: null }
  }
  async pull(harness, nativeId, after) {
    const mine = this.versions.filter((entry) => entry.harness === harness && entry.nativeId === nativeId)
    if (!mine.length) return null
    const page = mine.filter((entry) => entry.n > after)
    const units = new Map()
    for (const entry of page) {
      if (!units.has(entry.unit.key)) units.set(entry.unit.key, { ...entry.unit, versions: [] })
      units.get(entry.unit.key).versions.push(entry.version)
    }
    return { bundle: { harness, nativeId, layout: this.layout, marks: {}, units: [...units.values()] }, through: page.at(-1)?.n ?? after, more: false }
  }
  /** A Session's current versions at once (the gateway's `/sessions/head`), when this one answers it. */
  async head(harness, nativeId) {
    if (!this.answersHead) return undefined
    const mine = this.versions.filter((entry) => entry.harness === harness && entry.nativeId === nativeId)
    if (!mine.length) return null
    const units = new Map()
    for (const entry of mine) {
      if (entry.version.kind === "replace" || !units.has(entry.unit.key)) units.set(entry.unit.key, { ...entry.unit, versions: [] })
      units.get(entry.unit.key).versions.push(entry.version)
    }
    return { through: mine.at(-1).n, units: [...units.values()] }
  }
  async sessions() {
    const sessions = new Map()
    for (const [key, versions] of this.units) {
      const [harness, nativeId] = key.split("\n")
      const session = sessions.get(`${harness}\n${nativeId}`) ?? { harness, nativeId, units: 0, versions: 0, through: 0 }
      session.units += 1
      session.versions += versions.length
      sessions.set(`${harness}\n${nativeId}`, session)
    }
    return [...sessions.values()]
  }
  #keep(chunk) {
    if (this.chunks.has(chunk.hash)) return
    this.chunks.set(chunk.hash, chunk)
    this.bytes += chunk.body.length
  }
  #take(bundle) {
    const key = (unit) => `${bundle.harness}\n${bundle.nativeId}\n${unit}`
    try {
      const plan = planRecordImport(bundle, (unit) => {
        const held = this.units.get(key(unit))
        return held && { head: held.length - 1, version: (seq) => held[seq] }
      })
      this.layout ??= bundle.layout
      for (const { unit, version } of plan.taking) {
        const held = this.units.get(key(unit.key)) ?? []
        held.push({ kind: version.kind, chunks: version.chunks })
        this.units.set(key(unit.key), held)
        this.versions.push({ n: this.versions.length + 1, harness: bundle.harness, nativeId: bundle.nativeId, unit: { ...unit, versions: [] }, version })
      }
      if (plan.taking.length) this.pushed.push(bundle.nativeId)
      return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
    } catch (error) {
      if (!(error instanceof RecordConflictError)) throw error
      return { ok: false, conflict: error.conflict, key: error.key, seq: error.seq, head: error.head, message: error.message }
    }
  }
}
