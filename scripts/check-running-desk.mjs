// The full check for this Thread's running fixture desk: the page loads from
// the Thread's address, a read reaches the host and answers, and a write is
// refused before it reaches the host. Run by Mako after it starts the desk;
// MAKO_THREAD_URL names the Thread's address.
import { request } from "node:http"

const address = process.env.MAKO_THREAD_URL ?? process.argv[2]
if (!address) {
  console.error("Set MAKO_THREAD_URL or pass the desk's address, such as http://fix-login.thread.localhost:20020")
  process.exit(2)
}
const page = new URL(address)
// The desk listens on 127.0.0.1 and *.localhost can resolve to ::1 first, so
// connect there and name the Thread's host the way a browser would.
const fetchPage = (method, path, headers = {}, body) => new Promise((done, fail) => {
  const outgoing = request({ host: "127.0.0.1", port: page.port || 80, method, path, headers: { host: page.host, ...headers } }, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => done({ status: response.statusCode, type: response.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8") }))
  })
  outgoing.on("error", fail)
  outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${method} ${path} got no reply in 30 seconds`)))
  outgoing.end(body)
})
const hostCall = async (channel, ...args) => {
  const body = JSON.stringify({ channel, args: args.map((value) => ({ kind: "value", value })) })
  const reply = await fetchPage("POST", "/__mako/rpc", { "content-type": "application/json", origin: page.origin, "sec-fetch-site": "same-origin", "x-mako-client": "web" }, body)
  if (reply.status !== 200) throw new Error(`${channel}: the desk answered ${reply.status}: ${reply.body.slice(0, 300)}`)
  return JSON.parse(reply.body)
}
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const html = await fetchPage("GET", "/", { accept: "text/html" }).catch((error) => fail(`Nothing answers at ${page.origin}: ${error.message}`))
if (html.status !== 200 || !html.body.includes("<title>Mako</title>")) fail(`${page.origin} answered ${html.status} without Mako's page: ${html.body.slice(0, 200)}`)
const modules = [...html.body.matchAll(/<script type="module" src="([^"]+)"/g)].map((match) => match[1])
if (!modules.some((src) => !src.startsWith("/@"))) fail(`The page names no module entry of its own: ${modules.join(", ")}`)
for (const src of modules) {
  const module = await fetchPage("GET", src)
  if (module.status !== 200 || !/javascript/.test(module.type)) fail(`The page's module ${src} answered ${module.status} (${module.type}): ${module.body.slice(0, 300)}`)
}
console.log(`Page and ${modules.join(", ")} load from ${page.origin}`)

const threads = await hostCall("mako:threads")
if (threads.ok !== true || !Array.isArray(threads.value?.threads)) fail(`The read mako:threads failed: ${JSON.stringify(threads).slice(0, 300)}`)
console.log(`A read through the host answered: ${threads.value.threads.length} Threads`)

// Arguments no handler accepts: a validation error here would mean the write
// got past the desk's refusal.
const write = await hostCall("mako:thread-archive", { garbage: true })
if (write.ok !== false || write.code !== "fixture-refused") fail(`The write mako:thread-archive was not refused by the fixture desk: ${JSON.stringify(write).slice(0, 300)}`)
console.log("A write was refused before it reached the host")
console.log("PASS: the running desk serves its page, answers reads and refuses writes")
