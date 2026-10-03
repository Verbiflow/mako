import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { z } from "zod"

// HTML alone also passes when Vite has no Mako host proxy. Exercise a read through it.
const address = new URL(process.argv[2] ?? process.env.APP_URL ?? process.env.MAKO_THREAD_URL)
assert.ok(address.protocol === "http:" && (address.hostname.endsWith(".localhost") || ["localhost", "127.0.0.1"].includes(address.hostname)), "expected the local app address")
const listener = new URL(address)
listener.hostname = "127.0.0.1"
const page = await fetch(listener, { headers: { host: address.host }, signal: AbortSignal.timeout(15_000) })
assert.equal(page.status, 200)
const html = await page.text()
assert.match(html, /<title>Mako<\/title>/)
const modules = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((match) => match[1])
assert.ok(modules.length > 0, "the desk needs module scripts")
for (const source of modules) {
  const module = new URL(source, address)
  assert.equal(module.origin, address.origin, "the desk's modules must come from its own app")
  module.hostname = "127.0.0.1"
  const loaded = await fetch(module, { headers: { host: address.host }, signal: AbortSignal.timeout(15_000) })
  assert.equal(loaded.status, 200, `${source} must load`)
  assert.match(loaded.headers.get("content-type") ?? "", /javascript/, `${source} must be JavaScript`)
}
async function call(channel, args) {
  const response = await fetch(new URL("/__mako/rpc", listener), {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "host": address.host,
      "origin": address.origin,
      "sec-fetch-site": "same-origin",
      "x-mako-client": "web",
      "x-mako-window": randomUUID(),
    },
    body: JSON.stringify({ channel, args }),
  })
  assert.equal(response.status, 200, "the running desk needs a working host proxy")
  return response.json()
}
z.object({ ok: z.literal(true), value: z.unknown() }).parse(await call("mako:capabilities", []))
z.object({ ok: z.literal(true), value: z.unknown() }).parse(await call("mako:threads", []))
// Invalid arguments cannot archive a Session even if an ordinary host is served by mistake.
z.object({ ok: z.literal(false), code: z.literal("fixture-refused") }).parse(await call("mako:thread-archive", [{ garbage: true }]))
console.log(`Running desk HTML, module scripts, host read and fixture refusal passed at ${address.origin}`)
