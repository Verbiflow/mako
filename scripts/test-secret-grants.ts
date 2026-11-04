import assert from "node:assert/strict"
import { createCipheriv, randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aesSealer, fileSecrets, type SecretKey } from "@mako/host/base/secrets"
import { GrantedSecrets, secretRef } from "@mako/host/base/secret-grants"

/**
 * The Mac's secret store as borrowing's vault on the device: every value under the one seal (an older record sealed
 * again the first time it's read), every saved record a grant of the device's broker given when it was saved and
 * ended when it's replaced or deleted, and a Thread's harness taking a key only under a lease that the device's log
 * records by name and version, never by value.
 */

const root = mkdtempSync(join(tmpdir(), "mako-secret-grants-"))
const dataKey = randomBytes(32)
const key: SecretKey = { available: async () => true, key: async () => dataKey }
const store = fileSecrets(join(root, "secrets"), aesSealer(key))
const CANARY = `sk-canary-${randomUUID()}`
const SECOND = `sk-canary-${randomUUID()}`

// An older record, sealed under the store's own context before the one seal, opens and is sealed again as format 2.
const version = randomUUID()
const iv = randomBytes(12)
const cipher = createCipheriv("aes-256-gcm", dataKey, iv)
cipher.setAAD(Buffer.from(`mako-secret\0saved-key\0older\0${version}`))
const data = Buffer.concat([cipher.update("older-value", "utf8"), cipher.final()])
mkdirSync(join(root, "secrets", "saved-key"), { recursive: true })
const olderPath = join(root, "secrets", "saved-key", "older.json")
writeFileSync(olderPath, JSON.stringify({ format: 1, sealer: "aes-256-gcm", kind: "saved-key", name: "older", version, savedAt: new Date().toISOString(), expiresAt: null, sealed: [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".") }))
assert.equal((await store.read("saved-key", "older"))?.value, "older-value")
await store.list("saved-key")
assert.equal(JSON.parse(readFileSync(olderPath, "utf8")).format, 2, "read once, it's sealed under the one seal")
assert.equal(JSON.parse(readFileSync(olderPath, "utf8")).version, version, "with the same version")
assert.equal((await store.read("saved-key", "older"))?.value, "older-value", "and opens as before")

// Wrapped as the device's vault: the record saved before grants were kept gets one.
const secrets = new GrantedSecrets(store, join(root, "borrowing"))
await secrets.seed()
assert.deepEqual((await secrets.broker.grants()).map((grant) => grant.resource.ref), [secretRef("saved-key", "older")])

// Saving is the person's grant; a Thread's launch takes the key under a lease.
await secrets.write("saved-key", "connection/one", CANARY)
const thread = { thread: "thread-1", repository: "/work/shop" }
const lent = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("lease" in lent, JSON.stringify(lent))
assert.equal(lent.record.value, CANARY)
assert.equal(lent.lease.delivery.secret, true)
const again = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("lease" in again && again.lease.id === lent.lease.id, "one launch, one lease")

// Replacing the value ends the lease on the old one and its grant; the next launch takes the new one.
await secrets.write("saved-key", "connection/one", SECOND)
assert.equal((await secrets.broker.lease(lent.lease.id))?.ended, "revoked")
const stale = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("refusal" in stale && stale.refusal.refused === "revoked", "the old launch's lease isn't handed out again")
const next = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-2")
assert.ok("lease" in next && next.record.value === SECOND && next.lease.version !== lent.lease.version)

// The device's grants keep to it: a Thread on a cloud machine is refused, typed.
const away = await secrets.broker.borrow({ kind: "credential", ref: secretRef("saved-key", "connection/one"), for: { account: "local", repository: "/work/shop", thread: "cloud", place: { kind: "machine", machine: "m-1" } }, why: "a cloud Thread", correlationId: "away" })
assert.ok("refusal" in away && away.refusal.refused === "out-of-scope")

// Deleting ends every grant of it; a launch after that is refused.
await secrets.delete("saved-key", "connection/one")
const gone = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-3")
assert.ok("refusal" in gone && gone.refusal.refused === "revoked")
assert.ok(!(await secrets.broker.grants()).some((grant) => grant.resource.ref === secretRef("saved-key", "connection/one")))

// The device's log and state name what was lent and when, never a value; and the grants outlive the host.
const disk = readFileSync(join(root, "borrowing", "events.jsonl"), "utf8") + readFileSync(join(root, "borrowing", "state.json"), "utf8")
for (const value of [CANARY, SECOND, "older-value"]) assert.ok(!disk.includes(value), "no value on the broker's disk")
assert.ok(disk.includes('"event":"granted"') && disk.includes('"event":"revoked"'))
const reopened = new GrantedSecrets(store, join(root, "borrowing"))
assert.deepEqual((await reopened.broker.grants()).map((grant) => grant.resource.ref), [secretRef("saved-key", "older")])

console.log("secret grants: older records sealed again under the one seal, records saved earlier granted, a launch's key lent under a lease, one launch one lease, a replaced value ends its lease, the device's grants keep to it, deleting ends its grants, no value in the broker's log or state, grants kept across hosts")
