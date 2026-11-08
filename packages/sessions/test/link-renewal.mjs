import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"
import { LinkCredential } from "../dist/link-credential.js"

// The sync daemon pushes with the token the host gave it, and only the host can renew it. A link says when its token
// is due (`renewAt`, the host's `renewAtMs`): one that's due is asked of the host again before a call goes, and a call
// the gateway refuses with a 401 asks once and goes again. Before, a host too busy to give the next token left the
// daemon pushing with an expired one, and six Fins' Sessions read "not synced".
const base = "https://gw.test/v1/devices/d-1/originals"
const link = (token, renewAt) => ({ id: base, base, authorization: `Bearer ${token}`, ...renewAt !== undefined && { renewAt } })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

{
  // A link not due goes as it is; a due one waits for the host's next, and a host that never answers is waited out.
  let asked = 0
  const credential = new LinkCredential(link("a", Date.now() + 60_000), () => asked++)
  assert.equal(await credential.authorization(), "Bearer a")
  assert.equal(asked, 0, "a link not due asks nothing")
  credential.current = link("b", Date.now() - 1)
  const waiting = credential.authorization()
  const again = credential.authorization()
  await delay(5)
  assert.equal(asked, 1, "calls due at once ask once")
  credential.current = link("c", Date.now() + 60_000)
  assert.deepEqual(await Promise.all([waiting, again]), ["Bearer c", "Bearer c"], "each goes with the renewed token")
}

const home = await mkdtemp(join(tmpdir(), "mako-link-renewal-"))
const realFetch = globalThis.fetch
try {
  const sent = []
  let refuse = new Set()
  globalThis.fetch = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization")
    sent.push(`${init?.method ?? "GET"} ${String(url).slice(base.length)} ${authorization}`)
    if (refuse.has(authorization)) return new Response(JSON.stringify({ title: "The connection token has expired" }), { status: 401 })
    return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const catalog = new SessionCatalog([], { recordsPath: join(home, "records") })
  // The host: a link the catalog says is due goes again, renewed, a moment later.
  let next = 0
  const given = []
  catalog.onEvent((event) => {
    if (event.type !== "link-due") return
    given.push(event.form)
    setTimeout(() => catalog.syncOriginals(link(`fresh-${++next}`, Date.now() + 60_000)), 20)
  })

  catalog.syncOriginals(link("stale", Date.now() - 1_000))
  catalog.scopeSync({ sessions: [], paused: false })
  for (let waited = 0; !sent.length && waited < 100; waited++) await delay(20)
  assert.deepEqual(given, ["originals"], "a due link is asked of the host")
  assert.ok(sent.length > 0, "the account's list was asked for")
  assert.ok(sent.every((line) => line.endsWith("Bearer fresh-1")), `no call went with the due token: ${sent.join("; ")}`)

  // A token the gateway refuses though the host thought it good: asked once, and the call goes again. Given anew, the
  // link's uploads ask the account's list at once.
  sent.length = 0
  refuse = new Set(["Bearer fresh-1"])
  catalog.syncOriginals(null)
  catalog.syncOriginals(link("fresh-1", Date.now() + 60_000))
  for (let waited = 0; !sent.some((line) => line.endsWith("Bearer fresh-2")) && waited < 100; waited++) await delay(20)
  assert.deepEqual(given, ["originals", "originals"], "a refused token is asked of the host again")
  assert.deepEqual(sent.map((line) => line.slice(line.indexOf("Bearer"))), ["Bearer fresh-1", "Bearer fresh-2"], "refused once, then the renewed token")
  assert.equal((await catalog.syncStatus()).originals?.failures.length ?? 0, 0, "nothing said not synced")
  catalog.stop()
  console.log("link renewal ok")
} finally {
  globalThis.fetch = realFetch
  await rm(home, { recursive: true, force: true })
}
