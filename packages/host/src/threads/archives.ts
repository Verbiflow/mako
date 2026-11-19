import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { z } from "zod"
import { shownKeyOf, threadShownKey, type ArchiveCommand, type NativeArchive, type ThreadArchiveSnapshot } from "../contracts/thread-lifecycle.js"

const KeyRow = z.object({ key: z.string() })
const RevisionRow = z.object({ value: z.number() })
const AccountRow = z.object({ account: z.string() })
const DigestRow = z.object({ digest: z.string() })
const DataVersionRow = z.object({ data_version: z.number() })

/** The archive as last read: its snapshot, the same keys as a set, and the store's `data_version` it was read at. */
interface HeldArchives { version: number; revision: number; keys: readonly string[]; hidden: ReadonlySet<string> }

/**
 * What this device archived of its own, kept here; and, beside it, the keys of the cloud Threads its account archived,
 * which the account's word sets (`account`) and nothing here decides: a cloud Thread's archive is its own object's, so
 * a device never keeps a second word on it. The account's are kept as its list last said them, by account, and the
 * last account's are read back when the host starts: until the list is read again, its archived Threads stay archived
 * here rather than showing for the seconds it takes. A snapshot is both, under one revision.
 *
 * Whether something is archived is asked for every conversation on every batch, so the keys are read once and held
 * (`held`) until this store writes or another connection commits (`PRAGMA data_version`): read and parsed a row at a
 * time on each ask, 1,864 keys took 70% of a host's thread on a day of many Fins.
 */
export class ThreadArchives {
  private readonly db: DatabaseSync
  /** The account whose archived cloud Threads `accountKeys` are, if one has been heard from. */
  private accountId: string | undefined
  /** The keys of the account's archived cloud Threads' Sessions, as its list said them last. */
  private accountKeys: ReadonlySet<string> = new Set()
  private held: HeldArchives | undefined
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archives (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK (id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO revision VALUES (1,0);
      CREATE TABLE IF NOT EXISTS account_archives (account TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (account, key));
      CREATE TABLE IF NOT EXISTS account_heard (id INTEGER PRIMARY KEY CHECK (id=1), account TEXT NOT NULL)`)
    const heard = this.db.prepare("SELECT account FROM account_heard WHERE id=1").get()
    if (heard) {
      this.accountId = AccountRow.parse(heard).account
      this.accountKeys = new Set(this.db.prepare("SELECT key FROM account_archives WHERE account=?").all(this.accountId).map((row) => KeyRow.parse(row).key))
    }
  }
  /** What the store holds, read again only after a write here or another connection's commit. */
  private read(): HeldArchives {
    const version = DataVersionRow.parse(this.db.prepare("PRAGMA data_version").get()).data_version
    if (this.held?.version === version) return this.held
    const revision = RevisionRow.parse(this.db.prepare("SELECT value FROM revision WHERE id=1").get()).value
    const own = this.db.prepare("SELECT key FROM archives ORDER BY key").all().map((row) => KeyRow.parse(row).key)
    const keys = this.accountKeys.size === 0 ? own : [...new Set([...own, ...this.accountKeys])].sort()
    this.held = { version, revision, keys, hidden: new Set(keys) }
    return this.held
  }
  snapshot(): ThreadArchiveSnapshot {
    const { revision, keys } = this.read()
    return { revision, keys: [...keys] }
  }
  /** Every archived key as a set, the same one until the archive changes: what a look at one target reads. */
  hidden(): ReadonlySet<string> {
    return this.read().hidden
  }
  /**
   * `account`'s archived cloud Threads, as the keys of their Sessions, from a list it answered: they replace what was
   * held, kept as that account's. The snapshot after it, under a new revision, when they changed; null when they didn't.
   */
  account(account: string, keys: Iterable<string>): ThreadArchiveSnapshot | null {
    const next = new Set(keys)
    if (account === this.accountId && next.size === this.accountKeys.size && [...next].every((key) => this.accountKeys.has(key))) return null
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("DELETE FROM account_archives WHERE account=?").run(account)
      const insert = this.db.prepare("INSERT INTO account_archives (account, key) VALUES (?, ?)")
      for (const key of next) insert.run(account, key)
      this.db.prepare("INSERT INTO account_heard (id, account) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET account=excluded.account").run(account)
      this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    this.accountId = account
    this.accountKeys = next
    this.held = undefined
    return this.snapshot()
  }
  /**
   * Restore markers by the archive key each is for. A marker says a Session
   * its harness archived is shown here anyway (`threadShownKey`).
   */
  shown(): Map<string, string[]> {
    const markers = new Map<string, string[]>()
    const rows = this.db.prepare("SELECT key FROM archives WHERE key >= 'shown:' AND key < 'shownA'").all()
    for (const row of rows) {
      const marker = KeyRow.parse(row).key
      const key = shownKeyOf(marker)
      if (key !== undefined) markers.set(key, [...(markers.get(key) ?? []), marker])
    }
    return markers
  }
  /**
   * `archive` is the harness's own archive of the target. Restoring a Session
   * it archived records that it's shown anyway, for that archive; archiving
   * it here forgets every such record.
   */
  set(command: ArchiveCommand, keys: string[], archive: NativeArchive = {}): ThreadArchiveSnapshot {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const old = this.db.prepare("SELECT digest FROM receipts WHERE id=?").get(command.id)
      if (old) {
        if (DigestRow.parse(old).digest !== digest) throw new Error("This archive request ID was already used for another action")
      } else {
        const insert = this.db.prepare("INSERT OR IGNORE INTO archives VALUES (?)")
        const remove = this.db.prepare("DELETE FROM archives WHERE key=?")
        const shown = this.shown()
        for (const key of new Set(keys)) {
          const marker = archive.nativeArchived && !command.archived ? threadShownKey(key, archive.nativeArchiveStamp) : undefined
          for (const old of shown.get(key) ?? []) if (old !== marker) remove.run(old)
          if (command.archived) insert.run(key)
          else remove.run(key)
          if (marker) insert.run(marker)
        }
        this.db.prepare("INSERT INTO receipts VALUES (?, ?)").run(command.id, digest)
        this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      }
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    this.held = undefined
    return this.snapshot()
  }
  /** Drop restore markers a harness has moved past; unchanged when none of them is held. */
  forget(markers: readonly string[]): ThreadArchiveSnapshot | null {
    if (markers.length === 0) return null
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const remove = this.db.prepare("DELETE FROM archives WHERE key=?")
      let removed = 0
      for (const marker of new Set(markers)) removed += Number(remove.run(marker).changes)
      if (removed > 0) this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      this.db.exec("COMMIT")
      this.held = undefined
      return removed > 0 ? this.snapshot() : null
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  close() { this.db.close() }
}
