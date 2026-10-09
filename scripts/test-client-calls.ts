import assert from "node:assert/strict"
import { answerClientCall, CLIENT_CALLS, gatewayCalls, HOST_SCREEN_CALLS, isClientCall, openableLink, socketCalls, type ClientAnswers } from "../electron/contracts/client-calls.ts"
import { hostCallInput, hostChannels, isHostChannel } from "../electron/contracts/host-call-inputs.ts"

for (const call of CLIENT_CALLS) assert.ok(isHostChannel(call), `${call} is a host call`)

const offered = socketCalls(hostChannels)
assert.equal(offered.length, hostChannels.length - CLIENT_CALLS.length, "the socket offers every call but the client calls")
for (const call of CLIENT_CALLS) assert.ok(!offered.includes(call), `${call} isn't offered on the socket`)
assert.ok(!isClientCall("mako:pick-folder"), "choosing a folder is the host machine's, advertised by its Machine")
assert.ok(!isClientCall("mako:reveal"), "revealing a path is the host machine's: the file is there")
const remote = gatewayCalls(hostChannels)
for (const call of HOST_SCREEN_CALLS) {
  assert.ok(offered.includes(call), `${call} is answered on the socket, for a client on the host's machine`)
  assert.ok(!remote.includes(call), `${call} is never carried by the gateway: a remote client would open a window nobody sees`)
}
assert.equal(remote.length, offered.length - HOST_SCREEN_CALLS.length)

assert.equal(openableLink("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d")
assert.equal(openableLink("http://localhost:20010/"), "http://localhost:20010/")
assert.equal(openableLink("HTTPS://Example.com"), "https://example.com/", "the scheme is matched as the URL parser reads it")
for (const refused of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/tmp", "mailto:a@b.c", "data:text/html,hi", "example.com", "", "https//example.com"])
  assert.equal(openableLink(refused), null, `${JSON.stringify(refused)} is not opened`)

const seen: string[] = []
const answers: ClientAnswers<string> = {
  "mako:open-url": (page, url) => { seen.push(`${page} open ${url}`) },
  "mako:copy": (page, text) => { seen.push(`${page} copy ${text}`) },
  "mako:notify": (page, notification) => { seen.push(`${page} notify ${notification.title}`); return { delivered: true } },
  "mako:notify-dismiss": (page, subject) => { seen.push(`${page} dismiss ${subject}`) },
  "mako:set-badge-count": (page, count) => { seen.push(`${page} badge ${count}`) },
  "mako:notification-permission": () => "granted",
  "mako:request-notification-permission": () => "granted",
  "mako:open-preview-window": (page) => { seen.push(`${page} preview`) },
  "mako:quit-client": (page) => { seen.push(`${page} quit`) },
}
const call = (channel: (typeof CLIENT_CALLS)[number], args: unknown[]) =>
  answerClientCall(answers, channel, "page-1", hostCallInput(channel).parse(args))
await call("mako:copy", ["hello"])
await call("mako:open-url", ["https://example.com"])
await call("mako:set-badge-count", [3])
assert.equal(await call("mako:notification-permission", []), "granted")
assert.deepEqual(await call("mako:notify", [{ id: "n", subject: "s", title: "Done", body: "", silent: true }]), { delivered: true })
assert.deepEqual(seen, ["page-1 copy hello", "page-1 open https://example.com", "page-1 badge 3", "page-1 notify Done"], "each call reaches its own answer with the page and its parsed arguments")
assert.throws(() => call("mako:copy", [42]), "arguments are parsed against the host call's schema before any answer runs")

console.log(`Client calls: ${CLIENT_CALLS.length} calls each client answers on its own machine, never offered on the host's socket or as gateway operations; only http(s) links open`)
