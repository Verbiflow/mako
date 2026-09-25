import { randomUUID } from "node:crypto"
import { NativeQuestionSchema, NativeQuestionAnswerSchema, NativeQuestionHistorySchema, type NativeQuestionAnswer, type NativeQuestion } from "./contracts/live-questions.js"
import type { LivePermissionResponse } from "./contracts/providers-acp.js"
import type { LiveAction, LiveActionInput } from "./contracts/live-actions.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import type { ProviderBinding } from "./contracts/conversation-control.js"
import type { NativeQuestionHistory } from "./contracts/live-questions.js"

interface QuestionDelivery {
  continue(id: string, bindingId: string, requestId: string, text: string, displayText: string): void
  steer(id: string, input: LiveActionInput): Promise<LiveAction>
}

/** Questions survive turns/connections. Existing durable operations own answers. */
export class LiveQuestions {
  private readonly host: LiveAccess
  private readonly delivery: QuestionDelivery
  constructor(host: LiveAccess, delivery: QuestionDelivery) { this.host = host; this.delivery = delivery }

  /** Merge one complete native observation without replacing local intent or dismissal. */
  reconcile(resident: Resident, required = false): Promise<void> | undefined {
    const control = this.host.control(resident)
    const initial = control.bindings.find(item => item.id === control.activeBindingId)
    const history = initial && this.host.dependencies.driver(initial.provider)?.sessionQuestions?.history
    if (!initial || !history) return
    this.host.discoverNativePath(resident)
    const binding = this.host.control(resident).bindings.find(item => item.id === initial.id)
    if (!binding || (!required && (!binding.path || !binding.nativeId))) return
    return this.reconcileHistory(resident, binding, history)
  }

  private async reconcileHistory(resident: Resident, binding: ProviderBinding, history: (binding: ProviderBinding) => Promise<NativeQuestionHistory>): Promise<void> {
    const generation = resident.generation
    const before = this.host.control(resident)
    const inputs = new Set([
      ...resident.snapshot.requests.map(request => request.id),
      ...(before.actions ?? []).map(action => action.input.id),
      ...before.transfers.map(transfer => transfer.input.id),
    ])
    const evidence = NativeQuestionHistorySchema.parse(await history(binding))
    const current = this.host.control(resident)
    const active = current.bindings.find(item => item.id === current.activeBindingId)
    if (this.host.load(resident.snapshot.session.id) !== resident || generation !== resident.generation ||
      active?.id !== binding.id || active.nativeId !== binding.nativeId || active.path !== binding.path)
      throw new Error("The session changed while checking its questions; refresh before answering")
    const answers = new Set(current.questions?.map(question => question.id))
    const newInput = (id: string) => !inputs.has(id) && !answers.has(id)
    if (resident.snapshot.requests.some(request => newInput(request.id)) ||
      current.actions?.some(action => newInput(action.input.id)) ||
      current.transfers.some(transfer => newInput(transfer.input.id)))
      throw new Error("New input arrived while checking older questions; refresh before answering")
    if (evidence.some(entry => entry.question.sessionId !== binding.nativeId))
      throw new Error("Question history belongs to a different native session")
    const key = (question: NativeQuestion) => JSON.stringify([question.sessionId, question.turnId, question.itemId])
    const questions = [...(current.questions ?? [])]
    const indices = new Map(questions.flatMap((question, index) => question.bindingId === binding.id ? [[key(question.native), index] as const] : []))
    let changed = false
    for (const entry of evidence) {
      const identity = key(entry.question)
      const index = indices.get(identity)
      const previous = index === undefined ? undefined : questions[index]
      const native = previous?.native ?? entry.question
      const answered = [...new Set([...(previous?.answered ?? []), ...entry.answered.filter(id => native.questions.some(item => item.id === id))])]
      const retired = previous?.retired || entry.retired
      if (previous && answered.length === (previous.answered?.length ?? 0) && retired === previous.retired) continue
      const next = previous ? { ...previous, answered, retired } : { id: randomUUID(), bindingId: binding.id, native, answered, retired }
      if (index === undefined) { indices.set(identity, questions.length); questions.push(next) }
      else questions[index] = next
      changed = true
    }
    // A missed older question must not jump ahead of a newer live question.
    const sourceOrder = new Map(evidence.map((entry, index) => [key(entry.question), index]))
    const ordered = questions.filter(question => question.bindingId === binding.id).sort((a, b) =>
      (sourceOrder.get(key(a.native)) ?? Infinity) - (sourceOrder.get(key(b.native)) ?? Infinity))
    let offset = 0
    const merged = questions.map(question => question.bindingId === binding.id ? ordered[offset++]! : question)
    if (!changed && merged.every((question, index) => question === questions[index])) return
    if (questions.length > 2000) throw new Error("This conversation has reached its saved question limit")
    const previous = resident.snapshot
    resident.snapshot = { ...previous, control: { ...current, questions: merged } }
    try { this.host.flush(resident) } catch (error) { resident.snapshot = previous; throw error }
  }

  observe(resident: Resident, bindingId: string, raw: NativeQuestion): void {
    const native = NativeQuestionSchema.parse(raw)
    const control = this.host.control(resident)
    const binding = control.bindings.find(item => item.id === bindingId)
    if (!binding || !this.host.dependencies.driver(binding.provider)?.sessionQuestions ||
      (binding.nativeId && binding.nativeId !== native.sessionId)) return
    const previous = control.questions?.find(item => item.bindingId === bindingId &&
      item.native.sessionId === native.sessionId && item.native.turnId === native.turnId && item.native.itemId === native.itemId)
    // Replays cannot change the question attached to a saved answer or dismissal.
    if (previous) return
    if ((control.questions?.length ?? 0) >= 2000) throw new Error("This conversation has reached its saved question limit")
    resident.snapshot = { ...resident.snapshot, control: { ...control,
      questions: [...(control.questions ?? []), { id: randomUUID(), bindingId, native }],
    } }
  }

  observeAnswer(resident: Resident, bindingId: string, raw: NativeQuestionAnswer): void {
    const answer = NativeQuestionAnswerSchema.parse(raw)
    const control = this.host.control(resident)
    const matches = control.questions?.filter(item => item.bindingId === bindingId && item.native.sessionId === answer.sessionId && item.native.itemId === answer.itemId) ?? []
    // A reused native item ID without its original turn is ambiguous.
    if (matches.length !== 1) return
    const question = matches[0]!
    const answered = [...new Set([...(question.answered ?? []), ...answer.questionIds.filter(id => question.native.questions.some(item => item.id === id))])]
    if (answered.length === (question.answered?.length ?? 0)) return
    resident.snapshot = { ...resident.snapshot, control: { ...control,
      questions: control.questions?.map(item => item === question ? { ...item, answered } : item),
    } }
  }

  async answer(id: string, questionId: string, response: LivePermissionResponse): Promise<boolean> {
    const resident = this.host.require(id)
    // Dismissal is local. Sending requires fresh native evidence when available.
    const prior = this.host.control(resident)
    const owned = resident.snapshot.requests.some(request => request.id === questionId) ||
      prior.transfers.some(transfer => transfer.input.id === questionId) ||
      prior.actions?.some(action => action.input.id === questionId && action.state.kind !== "not-accepted")
    const catchup = response.kind !== "choice" && !owned ? this.reconcile(resident, true) : undefined
    if (catchup) await catchup
    const control = this.host.control(resident)
    const question = control.questions?.find(item => item.id === questionId)
    if (!question) return false
    if (response.kind === "choice") {
      if (response.optionId !== null) throw new Error("Choose an answer to this question")
      const previous = resident.snapshot
      resident.snapshot = { ...previous, control: { ...control,
        questions: control.questions?.map(item => item === question ? { ...item, dismissed: true } : item),
      } }
      try { this.host.flush(resident) } catch (error) { resident.snapshot = previous; throw error }
      return true
    }
    const binding = control.bindings.find(item => item.id === question.bindingId)
    const capability = binding && this.host.dependencies.driver(binding.provider)?.sessionQuestions
    if (!capability) throw new Error("This provider cannot currently accept this saved question's answer")
    const remaining = { ...question.native, questions: question.native.questions.filter(item => !question.answered?.includes(item.id)) }
    // Local repeats use their original full answer to compare the saved operation.
    const native = resident.snapshot.requests.some(item => item.id === question.id) || control.actions?.some(item => item.input.id === question.id) || control.transfers.some(item => item.input.id === question.id) ? { ...question.native, questions: question.native.questions.filter(item => Object.hasOwn(response.answers, item.id)) } : remaining
    const keys = Object.keys(response.answers)
    if (keys.length !== native.questions.length || native.questions.some(item =>
      !response.answers[item.id]?.length || response.answers[item.id]!.some(value => !value.trim()) ||
      (!item.allowOther && response.answers[item.id]!.some(value => !item.options.some(option => (option.value ?? option.label) === value)))))
      throw new Error("Complete the answers for this question")
    const text = capability.encodeAnswer(native, response.answers)
    const displayText = native.questions.map(item => `${item.question}\n${response.answers[item.id]!.join("\n")}`).join("\n\n")
    const canContinue = () => {
      const current = this.host.control(resident)
      const latest = current.questions?.find(item => item.id === question.id)
      return latest && !latest.dismissed && !latest.retired && current.activeBindingId === latest.bindingId &&
        native.questions.every(item => !latest.answered?.includes(item.id))
    }
    const request = resident.snapshot.requests.find(item => item.id === question.id)
    const action = control.actions?.find(item => item.input.id === question.id)
    const transfer = control.transfers.find(item => item.input.id === question.id)
    const previousText = request?.text ?? (action?.input.kind !== "compact" ? action?.input.text : undefined) ?? transfer?.input.text
    if (previousText !== undefined) {
      if (previousText !== text) throw new Error("This question already has a different saved answer")
      if (action?.state.kind === "not-accepted" && !request && !transfer && remaining.questions.length && canContinue())
        this.delivery.continue(id, question.bindingId, question.id, text, displayText)
      return true
    }
    if (!remaining.questions.length || question.dismissed || question.retired || control.activeBindingId !== question.bindingId || resident.closing || resident.opening || resident.transferring || resident.rewinding || resident.storageFault)
      throw new Error("This question is no longer available on the current session")
    const running = resident.snapshot.requests.find(item => item.status === "dispatching")
    if (resident.snapshot.session.status === "running" && running?.nativeRun && resident.driver?.steer) {
      const sent = await this.delivery.steer(id, { kind: "steer", id: question.id, requestId: running.id, text, displayText, attachments: [] })
      // An authoritative refusal is safe to queue. Unknown delivery never is.
      if (sent.state.kind === "not-accepted" && canContinue())
        this.delivery.continue(id, question.bindingId, question.id, text, displayText)
    } else {
      this.delivery.continue(id, question.bindingId, question.id, text, displayText)
    }
    return true
  }
}
