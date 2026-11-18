// Loaded into the host `npm run bench:vs-bare` and `npm run bench:actions` start (`node --import`, `lib/bench-host.ts`), never by the app: it hears the host's own
// diagnostics channels by name and writes one JSON line for each to descriptor 3, the pipe the bench reads, stamped
// with the machine's monotonic clock, which the bench's own process shares. It changes nothing the host does.
import { subscribe } from "node:diagnostics_channel"
import { createWriteStream } from "node:fs"

const out = createWriteStream("", { fd: 3 })
// A bench that died closes the pipe; the host it left is stopped by its signal, not by a write error here.
out.on("error", () => {})
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const say = (record) => out.write(`${JSON.stringify(record)}\n`)

/** Conversations whose id starts with this are the bench's measured ones; the others' frames and tokens aren't written. */
const MARK = process.env.BENCH_VS_BARE_MARK ?? ""
const measured = (id) => String(id ?? "").startsWith(MARK)
const text = (value) => Object.prototype.toString.call(value) === "[object String]"

subscribe("mako:host-call", ({ channel, args }) => {
  const t = now()
  if (channel === "mako:live-prompt") say({ t, s: "call", channel, c: args[0], q: args[1] })
  else if (channel === "mako:live-start") say({ t, s: "call", channel, c: args[2]?.conversationId, q: args[2]?.initialRequest?.id })
  // Every other call about a conversation (a steer, a Stop, an access change, an approval's answer), for `bench:actions`.
  else if (channel.startsWith("mako:live-") && text(args[0])) say({ t, s: "host-call", channel, c: args[0] })
})
subscribe("mako:host-answer", ({ channel, args, refused }) => {
  const t = now()
  if (channel.startsWith("mako:live-") && text(args[0])) say({ t, s: "host-answer", channel, c: args[0], refused: refused === true })
})
subscribe("mako:live-step", (step) => {
  const t = now()
  if (measured(step.conversation)) say({ t, s: "step", c: step.conversation, step: step.step, phase: step.phase, detail: step.detail })
})
subscribe("mako:live-stage", (stage) => {
  const t = now()
  if (measured(stage.conversation)) say({ t, s: stage.stage, c: stage.conversation, q: stage.request, kind: stage.kind, evidence: stage.evidence, chars: stage.chars })
})
subscribe("mako:native-frame", ({ conversation }) => {
  const t = now()
  if (measured(conversation)) say({ t, s: "frame", c: conversation })
})
subscribe("mako:live-driver-event", (event) => {
  const t = now()
  if (event.type === "live-session") {
    if (measured(event.session.id)) say({ t, s: "session", c: event.session.id, status: event.session.status, connection: event.session.connection, mode: event.session.currentMode ?? null })
    return
  }
  if (event.type === "live-permission") {
    if (measured(event.request.sessionId)) say({ t, s: "permission", c: event.request.sessionId })
    return
  }
  if (event.type !== "live-update" && event.type !== "live-updates") return
  if (!measured(event.id)) return
  const updates = event.type === "live-update" ? [event.update] : event.updates
  // Each update as its kind, its block and how much text it carries: the words themselves stay in the host.
  say({ t, s: "decoded", c: event.id, u: updates.map((update) => [update.kind, update.id ?? null, update.text?.length ?? 0, update.replace ? 1 : 0]) })
})
subscribe("mako:live-batch-emitted", (batch) => {
  const t = now()
  if (measured(batch.id)) say({ t, s: "batch", c: batch.id, r: batch.revision })
})
subscribe("mako:stream-write", ({ client, type, conversation, line }) => {
  const t = now()
  if (type !== "live-batch" || !measured(conversation)) return
  say({ t, s: "wrote", c: conversation, client, r: Number(/"revision":(\d+)/.exec(line)?.[1] ?? -1), bytes: Buffer.byteLength(line) })
})
const SCOPES = new Set(["provider-startup", "checkpoints", "residency", "loop"])
subscribe("mako:host-log", (line) => {
  const t = now()
  if (SCOPES.has(line.scope)) say({ t, s: "log", scope: line.scope, message: line.message, level: line.level, fields: line.fields })
})
