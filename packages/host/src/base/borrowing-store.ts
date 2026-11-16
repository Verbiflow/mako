import { chmodSync, existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { emptyBroker, type BrokerState, type SourceAsk } from "@mako/protocol/borrow"
import { inSlices, type Steps } from "@mako/sessions/slices"
import { declareStoreFormat, readStoreFormat, storeAccess, writeStoreFormat, NewerStoreError, NewerStoreReadOnlyError, type StoreAccess, type StoreFormat } from "@mako/sessions/store-format"
import { compactGrants, type BorrowingState, type PersonAsk } from "./borrowing-state.js"

const TABLES = ["grants", "leases", "answers", "asks", "devices", "endedThreads", "waiting"] as const
type EncodedRow = { text: string; position: number }
type RowValue = BrokerState[typeof TABLES[number]][string] | PersonAsk | SourceAsk
/** One connection per broker, used only while holding the broker's cross-process lock. */
export class BorrowingStore {
  private readonly db: DatabaseSync
  private readonly rows
  private readonly put
  private readonly drop
  private readonly tombstone
  private readonly ended
  private readonly meta
  private readonly setMeta
  private readonly revision
  private readonly account: string
  private access: StoreAccess = "write"
  private format: StoreFormat | undefined
  private cached: BorrowingState | undefined
  private version: number | undefined
  private encoded = new Map<string, EncodedRow>()

  constructor(path: string, account: string) {
    this.account = account
    const existed = existsSync(path)
    this.db = new DatabaseSync(path)
    try {
      if (!existed) chmodSync(path, 0o600)
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-128")
      this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
      this.checkFormat()
      declareStoreFormat(this.db, 1)
      if (this.access === "write") {
        this.db.exec("PRAGMA journal_mode=WAL")
        this.db.exec(`CREATE TABLE IF NOT EXISTS borrowing_rows (account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(account, kind, id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ended_grants (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(account, id)) WITHOUT ROWID`)
        writeStoreFormat(this.db, "meta", { writableBy: 1, readableBy: 1 })
      }
      this.meta = this.db.prepare("SELECT value FROM meta WHERE key=?")
      this.setMeta = this.db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      this.rows = this.db.prepare("SELECT kind, id, value, position FROM borrowing_rows WHERE account=? ORDER BY kind,position,id")
      this.put = this.db.prepare("INSERT INTO borrowing_rows (account,kind,id,value,position) VALUES (?,?,?,?,?) ON CONFLICT(account,kind,id) DO UPDATE SET value=excluded.value, position=excluded.position")
      this.drop = this.db.prepare("DELETE FROM borrowing_rows WHERE account=? AND kind=? AND id=?")
      this.tombstone = this.db.prepare("INSERT INTO ended_grants (account,id) VALUES (?,?) ON CONFLICT DO NOTHING")
      this.ended = this.db.prepare("SELECT 1 AS ended FROM ended_grants WHERE account=? AND id=?")
      this.revision = this.db.prepare("PRAGMA data_version")
    } catch (error) { this.db.close(); throw error }
  }

  private checkFormat(): void {
    this.format = readStoreFormat(this.db, "meta")
    this.access = storeAccess(this.format, 1)
    if (this.access === "refused") throw new NewerStoreError("this device's borrowing decisions", this.format!, 1)
  }

  canImport(): boolean { return this.meta.get("active")?.value !== "1" }
  activate(): void { if (this.canImport()) { this.assertWritable(); this.setMeta.run("active", "1") } }
  assertWritable(): void { if (this.access !== "write") throw new NewerStoreReadOnlyError("this device's borrowing decisions", this.format!, "cannot change borrowing decisions") }

  hasEnded(id: string): boolean { return Boolean(this.ended.get(this.account, id)) }
  close(): void { this.db.close() }

  async read(): Promise<BorrowingState> {
    const version = Number(this.revision.get()?.data_version)
    if (this.cached && version === this.version) return this.cached
    this.checkFormat()
    const kept: BorrowingState = { state: emptyBroker(this.account), waiting: [], unanswered: [] }
    const encoded = new Map<string, EncodedRow>()
    const rows = this.rows.iterate(this.account)
    function* load(): Steps<void> {
      for (const row of rows) {
        const kind = String(row.kind), id = String(row.id), value = String(row.value)
        const table = TABLES.find(table => table === kind)
        // SAFETY: rows are written from the protocol's BrokerState, under the broker lock, by this store only.
        if (kind === "person") kept.waiting.push(JSON.parse(value))
        else if (kind === "unanswered") kept.unanswered.push(JSON.parse(value))
        else if (table) Object.defineProperty(kept.state[table], id, { value: JSON.parse(value), enumerable: true, configurable: true, writable: true })
        encoded.set(JSON.stringify([kind, id]), { text: value, position: Number(row.position) })
        yield
      }
    }
    await inSlices(load())
    this.cached = kept; this.encoded = encoded; this.version = version
    return kept
  }

  /** Only changed rows, committed before answering. No deferred write can escape the broker's lock. */
  async write(kept: BorrowingState, replace = false): Promise<void> {
    this.assertWritable()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (replace) { this.db.exec("DELETE FROM borrowing_rows; DELETE FROM ended_grants"); this.encoded.clear() }
      const { tombstone, account, put, drop, encoded } = this
      function* retire(): Steps<void> {
        for (const [id, held] of Object.entries(kept.state.grants)) {
          if (held.ended) tombstone.run(account, id)
          yield
        }
      }
      await inSlices(retire())
      await inSlices(compactGrants(kept))
      const next = new Map<string, EncodedRow>()
      function* save(): Steps<void> {
        const row = (kind: string, id: string, value: RowValue, position: number) => {
          const key = JSON.stringify([kind, id]), text = JSON.stringify(value)
          next.set(key, { text, position })
          const before = encoded.get(key)
          if (text !== before?.text || position !== before.position) put.run(account, kind, id, text, position)
        }
        for (const kind of TABLES) {
          let position = 0
          for (const [id, value] of Object.entries(kept.state[kind])) { row(kind, id, value, position++); yield }
        }
        for (const [index, value] of kept.waiting.entries()) { row("person", String(index).padStart(12, "0"), value, index); yield }
        for (const [index, value] of kept.unanswered.entries()) { row("unanswered", String(index).padStart(12, "0"), value, index); yield }
        for (const key of encoded.keys()) {
          if (!next.has(key)) {
            // SAFETY: encoded keys are created only by JSON.stringify([kind, id]) in this class.
            const [kind, id] = JSON.parse(key) as [string, string]
            drop.run(account, kind, id)
          }
          yield
        }
      }
      await inSlices(save())
      this.db.exec("COMMIT")
      this.cached = kept; this.encoded = next; this.version = Number(this.revision.get()?.data_version)
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.cached = undefined
      throw error
    }
  }
}
