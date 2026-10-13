import { randomUUID } from "node:crypto"
import { hostWarn } from "../base/host-log.js"
import type { LiveSnapshot } from "../contracts/live-conversations.js"
import { untilStopped, type SideConversation, type SideExchange, type SideQuestionCommand } from "../contracts/live-side-questions.js"
import type { SideQuestionsCapability } from "../harnesses/index.js"
import { activeBinding, conversationControl, type LiveAccess, type Resident } from "./live-runtime.js"

type SideAccess = Pick<LiveAccess, "dependencies" | "admission" | "load" | "flush" | "schedule" | "reopens" | "wake" | "snapshot" | "canHibernate" | "scheduleHibernation">

type Answering = Extract<SideQuestionsCapability, { kind: "native" | "fork" }>

/**
 * The side conversation beside each conversation: questions answered from
 * its context while its turn goes on, never added to it. One per
 * conversation, one answer at a time; each question after the first
 * follows up on the ones before. A harness with its own side question
 * answers it; Mako asks a copy of the session for one without. Stop shows
 * the answer stopped at once; a harness that can't take a stop finishes it
 * unread, and the next question waits for that.
 */
export class LiveSideQuestions {
  private readonly access: SideAccess

  constructor(access: SideAccess) {
    this.access = access
  }

  async command(id: string, command: SideQuestionCommand): Promise<LiveSnapshot> {
    this.access.admission.assert()
    const resident = this.access.load(id)
    if (!resident) throw new Error("This conversation is no longer available")
    switch (command.kind) {
      case "ask":
        await this.ask(resident, command.question)
        break
      case "stop":
        resident.sideAnswer?.controller.abort()
        break
      case "close":
        this.close(resident)
        break
    }
    this.access.flush(resident)
    return this.access.snapshot(id) ?? resident.snapshot
  }

  private async ask(resident: Resident, question: string): Promise<void> {
    const side = this.capability(resident)
    this.refuseWhileAnswering(resident)
    const { requests, blocks, base } = resident.snapshot
    if (!requests.length && !blocks.length && !base) throw new Error("Send a message first, then ask a side question.")
    if (resident.opening) await resident.openingOperation?.catch(() => undefined)
    if (!resident.driver && this.access.reopens(resident)) await this.access.wake(resident)
    if (!resident.driver) throw new Error("This conversation isn't connected. Send a message to reconnect it, then try again.")
    this.refuseWhileAnswering(resident)
    const binding = conversationControl(resident).activeBindingId
    const open: SideConversation = resident.snapshot.side ?? { id: randomUUID(), by: side.kind === "native" ? "harness" : "fork", exchanges: [] }
    const earlier = open.exchanges.flatMap((exchange) => exchange.status === "answered" ? [{ question: exchange.question, answer: exchange.answer }] : [])
    const exchange: SideExchange = { id: randomUUID(), question, answer: "", status: "answering", askedAt: this.now() }
    const controller = new AbortController()
    const { signal } = controller
    const previous = resident.sideAnswer?.driving
    const asking = (async () => {
      await previous
      if (signal.aborted) throw new Error("Stopped")
      return side.ask(binding, {
        side: open.id,
        question,
        earlier,
        signal,
        stream: (text) => {
          if (signal.aborted || !text) return
          this.updateExchange(resident, open.id, exchange.id, (current) => ({ ...current, answer: current.answer + text }))
          this.access.schedule(resident)
        },
      })
    })()
    const answer = { exchange: exchange.id, controller, driving: asking.then(() => undefined, () => undefined) }
    resident.sideAnswer = answer
    void answer.driving.then(() => {
      if (resident.sideAnswer !== answer) return
      resident.sideAnswer = undefined
      if (this.access.canHibernate(resident)) this.access.scheduleHibernation(resident)
    })
    this.setSide(resident, { ...open, exchanges: [...open.exchanges, exchange] })
    const settle = (change: (current: SideExchange) => SideExchange) => {
      this.updateExchange(resident, open.id, exchange.id, (current) => ({ ...change(current), answeredAt: this.now() }))
      this.access.flush(resident)
    }
    void untilStopped(asking, signal).then(
      (whole) => settle((current) => ({ ...current, answer: whole.trim() ? whole : current.answer, status: "answered" })),
      (error) => settle((current) => signal.aborted
        ? { ...current, status: "stopped" }
        : { ...current, status: "failed", error: error instanceof Error ? error.message : String(error) }),
    )
  }

  private refuseWhileAnswering(resident: Resident): void {
    if (resident.snapshot.side?.exchanges.some((exchange) => exchange.status === "answering"))
      throw new Error("Wait for the answer, or stop it, before asking another.")
  }

  private close(resident: Resident): void {
    const side = resident.snapshot.side
    resident.sideAnswer?.controller.abort()
    if (!side) return
    this.setSide(resident, undefined)
    const capability = this.driverCapability(resident)
    if (!resident.driver || !capability || capability.kind === "unavailable" || capability.kind === "not-built") return
    const binding = conversationControl(resident).activeBindingId
    void (resident.sideAnswer?.driving ?? Promise.resolve())
      .then(() => capability.close(binding, side.id))
      .catch((error) => hostWarn("live", "the side conversation did not close", { conversation: resident.snapshot.session.id, error: String(error) }))
  }

  private updateExchange(resident: Resident, side: string, exchange: string, change: (current: SideExchange) => SideExchange): void {
    const current = resident.snapshot.side
    if (current?.id !== side) return
    this.setSide(resident, { ...current, exchanges: current.exchanges.map((candidate) => candidate.id === exchange ? change(candidate) : candidate) })
  }

  private setSide(resident: Resident, side: SideConversation | undefined): void {
    resident.snapshot = { ...resident.snapshot, side }
  }

  private capability(resident: Resident): Answering {
    const side = this.driverCapability(resident)
    if (!side) throw new Error("This conversation's agent isn't available")
    if (side.kind === "unavailable" || side.kind === "not-built") throw new Error(`This agent can't answer side questions. ${side.reason}`)
    return side
  }

  private driverCapability(resident: Resident): SideQuestionsCapability | undefined {
    const provider = activeBinding(resident)?.provider ?? resident.snapshot.session.harness
    return this.access.dependencies.driver(provider)?.sideQuestions
  }

  private now(): number {
    return this.access.dependencies.now?.() ?? Date.now()
  }
}
