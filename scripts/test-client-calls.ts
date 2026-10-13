import assert from "node:assert/strict"
import { answerClientCall, CLIENT_CALLS, gatewayCalls, HOST_SCREEN_CALLS, isClientCall, openableLink, socketCalls, type ClientAnswers } from "@mako/host/contracts/client-calls"
import { hostCallSchema, hostChannels, isHostChannel } from "@mako/host/contracts/host-call-inputs"

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
  "mako:surface-window": (page) => { seen.push(`${page} surface`) },
  "mako:appshot-shortcut": (page, shortcut) => {
    seen.push(`${page} shortcut ${shortcut ? shortcut.kind : "off"}`)
    return shortcut ? { state: "on", shortcut } : { state: "off" }
  },
  "mako:appshot-feedback": (page, feedback) => { seen.push(`${page} feedback ${feedback.phase}`) },
}
const call = (channel: (typeof CLIENT_CALLS)[number], args: unknown[]) =>
  answerClientCall(answers, channel, "page-1", hostCallSchema(channel).parse(args))
await call("mako:copy", ["hello"])
await call("mako:open-url", ["https://example.com"])
await call("mako:set-badge-count", [3])
assert.equal(await call("mako:notification-permission", []), "granted")
assert.deepEqual(await call("mako:notify", [{ id: "n", subject: "s", title: "Done", body: "", silent: true }]), { delivered: true })
assert.deepEqual(seen, ["page-1 copy hello", "page-1 open https://example.com", "page-1 badge 3", "page-1 notify Done"], "each call reaches its own answer with the page and its parsed arguments")
assert.throws(() => call("mako:copy", [42]), "arguments are parsed against the host call's schema before any answer runs")
assert.deepEqual(await call("mako:appshot-shortcut", [{ kind: "modifiers", modifier: "shift" }]), { state: "on", shortcut: { kind: "modifiers", modifier: "shift" } })
assert.deepEqual(await call("mako:appshot-shortcut", [null]), { state: "off" }, "the desk lets the shortcut go with null")
assert.throws(() => call("mako:appshot-shortcut", [{ kind: "modifiers", modifier: "fn" }]), "a modifier the client can't listen for is refused before it is asked")
await call("mako:appshot-feedback", [{ id: "c", phase: "capturing", app: "Safari", title: "Docs", bounds: { x: 0, y: 0, width: 10, height: 10 } }])
assert.deepEqual(seen.slice(-3), ["page-1 shortcut modifiers", "page-1 shortcut off", "page-1 feedback capturing"])

console.log(`Client calls: ${CLIENT_CALLS.length} calls each client answers on its own machine, never offered on the host's socket or as gateway operations; only http(s) links open`)
