// What the window still says once raw error toasts went: a save's one action, the rail's line for saved conversations
// that couldn't be opened, and the line under a native reply that runs without a setting. Static renders and sonner's
// own record of its toasts.
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { toast } from "sonner"
import { HostCallTimeoutError } from "@mako/host/contracts/host-connection"
import { notSaved } from "../src/lib/quiet-retry"
import { UnopenedConversations, UnopenedRailLine } from "../src/components/settings/unopened-conversations"
import { unopenedStore } from "../src/state/unopened-conversations"
import { NativeRunDropped } from "../src/components/viewer/native-run-dropped"
import { noteRunDropped } from "../src/state/native-run-dropped"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim()
const last = () => toast.getHistory().at(-1)
const quiet = console.warn
console.warn = () => {}

// A save the connection failed twice says so with Try again, which runs the same save; one it fails again says so again.
let tries = 0
const retry = async () => { tries++; throw new HostCallTimeoutError(false) }
notSaved("Your rules weren't saved", { error: new HostCallTimeoutError(false) }, { retry, kept: true })
const offered = last()
assert.ok(offered && "title" in offered)
assert.equal(offered.title, "Your rules weren't saved")
assert.match(String(offered.description), /^Your words are still in the field\./, "kept words aren't said to be back as they were")
const button: { label?: string; onClick?: (event: never) => void } = Object(offered.action)
assert.equal(button.label, "Try again")
// SAFETY: notSaved's button ignores its click event; there is no DOM to make one in this test.
button.onClick?.({} as never)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(tries, 1, "Try again runs the same save")
assert.notEqual(last(), offered, "and a second failure is said again, with its own Try again")

// A refusal is the host's answer: its words, and nothing to press that would meet it again.
notSaved("That number wasn't saved", { error: new Error("A limit is at least 1.") }, { retry })
const refused = last()
assert.ok(refused && "description" in refused && refused.description === "A limit is at least 1.")
assert.ok(!("action" in refused) || !refused.action)

// A saved conversation that couldn't be opened is a rail line and a Diagnostics row, never gone without a word.
assert.equal(renderToStaticMarkup(<UnopenedRailLine />), "")
unopenedStore.set({ conversations: [{ conversation: "6f1c2a90-3b7e-4d2a-9c41-8e5b0f7d2a13", journal: "conversations/6f1c2a90-3b7e-4d2a-9c41-8e5b0f7d2a13.sqlite", error: "file is not a database" }] })
assert.equal(text(renderToStaticMarkup(<UnopenedRailLine />)), "1 conversation couldn't open Show")
assert.match(text(renderToStaticMarkup(<UnopenedConversations />)), /6f1c2a90-3b7e-4d2a-9c41-8e5b0f7d2a13 file is not a database/)

// A native reply that runs without a setting says so under it, until a reply that carries everything starts.
noteRunDropped({ path: "/t", harness: "codex", status: "running", dropped: ["effort"] })
assert.match(text(renderToStaticMarkup(<NativeRunDropped path="/t" />)), /^This reply runs without effort: .+'s command line can't carry it\.$/)
noteRunDropped({ path: "/t", harness: "codex", status: "done", dropped: ["effort"] })
assert.notEqual(renderToStaticMarkup(<NativeRunDropped path="/t" />), "", "it stays once the reply is done")
noteRunDropped({ path: "/t", harness: "codex", status: "running" })
assert.equal(renderToStaticMarkup(<NativeRunDropped path="/t" />), "", "the next reply that carries everything clears it")

console.warn = quiet
console.log("Quiet errors' lines: a save's Try again reruns it, a refusal keeps the host's words, unopened conversations have a rail line and Diagnostics rows, a native reply's dropped settings are said under it")
