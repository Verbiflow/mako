import { randomUUID } from "node:crypto"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { controlNote } from "../control/index.js"
import { ExecutionAccountChanged, ExecutionIdentityMismatch } from "../harnesses/index.js"
import { retireQuestionsForInput } from "../contracts/live-questions.js"
import { nativePromptReference } from "../contracts/native-prompt-identity.js"
import { advancePromptDelivery, type PromptDelivery, type PromptDeliveryEvidence } from "../contracts/prompt-delivery.js"
import { classifyProviderFailure } from "../contracts/provider-failure.js"
import { holdForSignIn } from "../contracts/sign-in-hold.js"
import { pendingInterruption, TurnSteps } from "./interrupted-turn.js"
import type { LiveActions } from "./live-actions.js"
import type { LiveCheckpoints } from "./live-checkpoints.js"
import { contextPrompt } from "./live-context.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import type { LiveTransfers } from "./live-transfers.js"

type DispatchAccess = Pick<LiveAccess,
  "dependencies" | "epoch" | "admission" | "control" | "flush" | "storageFailed" | "moves" | "switchAccount" |
  "canHibernate" | "hibernate" | "wake" | "accountSwitchWait" | "signInHold">

/** The parts that can hold a conversation's next prompt back, or carry it. */
export interface DispatchParts {
  actions: LiveActions
  checkpoints: LiveCheckpoints
  transfers: LiveTransfers
}

/** Each conversation's next queued prompt, sent once nothing holds it back, and what became of the send. */
export class LiveDispatch {
  private readonly access: DispatchAccess
  private readonly parts: DispatchParts

  constructor(access: DispatchAccess, parts: DispatchParts) {
    this.access = access
    this.parts = parts
  }

  drain(resident: Resident): void {
    const { dependencies } = this.access
    const { actions, checkpoints, transfers } = this.parts
    if (this.access.admission.closed) return
    if (actions.blocks(resident)) return
    // Queued work stays queued, not held: cancelling a move starts it again.
    if (!this.access.moves.executes(resident)) return
    if (
      resident.checkpointing ||
      resident.rewinding ||
      resident.closing ||
      resident.hibernating ||
      resident.waking
    )
      return
    if (transfers.pending(resident)) {
      transfers.start(resident)
      return
    }
    if (
      resident.opening ||
      !resident.driver ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    // Failure does not silently drain old queued work. A new explicit submission can retry.
    const queued = resident.snapshot.requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    )
    const request =
      resident.snapshot.session.status === "failed" ? queued.at(-1) : queued[0]
    if (!request || request.status === "held") return
    if (request.accountSwitch) {
      void this.access.switchAccount(resident, request).catch((error) => {
        hostWarn("live", "account switch failed", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
      })
      return
    }
    const previousSnapshot = resident.snapshot
    const previousUpdates = [...resident.updates]
    const previousCharacters = resident.pendingCharacters
    const previousDisplayPrompt = resident.displayPrompt
    const control = this.access.control(resident)
    const pendingMerges = control.merges.filter(
      (merge) => merge.status === "pending"
    )
    const attemptId = randomUUID()
    const bindingId = control.activeBindingId
    const nativeDelivery: PromptDelivery = { attemptId, bindingId, ownerEpoch: this.access.epoch, evidence: { kind: "prepared" } }
    const ownerGeneration = this.access.moves.generation(resident)
    if (ownerGeneration !== undefined) nativeDelivery.ownerGeneration = ownerGeneration
    const usage = resident.snapshot.session.usage
    const current = {
      ...request,
      nativePrompt: undefined,
      nativeDelivery,
      usageFrom: usage?.tokens || usage?.cost || usage?.unrecorded
        ? { ...(usage.tokens && { tokens: usage.tokens }), ...(usage.cost && { cost: usage.cost }), ...(usage.unrecorded && { unrecorded: usage.unrecorded }) }
        : undefined,
      status: "dispatching" as const,
      context: [
        ...(request.context ?? []),
        ...pendingMerges.map((merge) => merge.manifest),
      ],
    }
    const told = pendingInterruption(resident.snapshot.requests, request.id)
    const toldAt = Date.now()
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...(request.continues?.auto ? control : retireQuestionsForInput(control, request.id)),
        merges: control.merges.map((merge) =>
          merge.status === "pending" ? { ...merge, status: "consumed" } : merge
        ),
      },
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id
          ? current
          : candidate.id === told?.requestId && candidate.interruption
            ? { ...candidate, interruption: { ...candidate.interruption, told: toldAt } }
            : candidate
      ),
    }
    resident.steps = new TurnSteps()
    const text = request.displayText ?? resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    // A request held back behind a turn the provider was still running
    // already shows its message from that attempt.
    const shown = request.nativeDelivery?.evidence.kind === "not-accepted"
    if (!shown && (text || request.attachments.length))
      resident.updates.push({
        kind: "user",
        provider: resident.snapshot.session.harness,
        requestId: request.id,
        contextFiles: current.context.map((manifest) => manifest.file),
        text,
        attachments: request.attachments.map((attachment) => ({
          type: "attachment",
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.path
            ? { kind: "file", path: attachment.path }
            : attachment.data
              ? { kind: "inline", data: attachment.data }
              : {
                  kind: "unavailable",
                  reason: "Attachment bytes were not retained",
                },
        })),
      })
    try {
      this.access.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      resident.updates = previousUpdates
      resident.pendingCharacters = previousCharacters
      resident.displayPrompt = previousDisplayPrompt
      this.access.storageFailed(resident, { error })
      return
    }
    const generation = resident.generation
    const driver = resident.driver
    const report = (evidence: PromptDeliveryEvidence): void => {
      if (resident.generation !== generation || this.access.control(resident).activeBindingId !== bindingId) return
      const target = resident.snapshot.requests.find((item) => item.id === request.id)
      if (!target?.nativeDelivery || target.nativeDelivery.attemptId !== attemptId) return
      const delivery = target.nativeDelivery
      const next = advancePromptDelivery(delivery.evidence, evidence)
      if (next === delivery.evidence) return
      const binding = this.access.control(resident).bindings.find(item => item.id === bindingId)
      const prompt = nativePromptReference(driver.nativePromptIdentity, next, {
        bindingId, attemptId, provider: binding?.provider ?? driver.provider,
        nativeId: binding?.nativeId,
        path: binding?.path,
      })
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((item) =>
          item === target ? { ...item, nativePrompt: prompt, nativeDelivery: { ...delivery, evidence: next } } : item
        ),
      }
      try {
        this.access.flush(resident)
      } catch (error) {
        this.access.storageFailed(resident, { error })
      }
    }
    void checkpoints
      .prompt(resident, current, () =>
        driver.prompt(
          this.access.control(resident).activeBindingId,
          [
            controlNote([
              ...(dependencies.controlInstructions?.(this.access.control(resident).activeBindingId, resident.snapshot.session.id) ?? []),
              ...(told ? [told.account] : []),
            ]),
            current.context.reduce((text, manifest) => contextPrompt(manifest, text), request.text),
          ].filter(Boolean).join("\n\n"),
          request.attachments,
          request.tuning,
          { operationId: request.id, attemptId, report }
        )
      )
      .catch(async (error) => {
        report({ kind: "uncertain", reason: errorMessage({ error }) })
        const target = resident.snapshot.requests.find(
          (candidate) =>
            candidate.id === request.id && candidate.status === "dispatching"
        )
        if (generation !== resident.generation || !target) return
        const session = resident.snapshot.session
        const refused = target.nativeDelivery?.attemptId === attemptId && target.nativeDelivery.evidence.kind === "not-accepted"
        if (refused && error instanceof ExecutionAccountChanged && resident.accountRefreshRequest !== request.id &&
          session.status === "ready" && session.connection === "connected") {
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
            candidate === target ? { ...candidate, status: "queued", error: undefined, snapshots: undefined } : candidate) }
          if (this.access.canHibernate(resident, false, true)) {
            resident.accountRefreshRequest = request.id
            dependencies.workspaceSnapshots?.abandonRun(request.id)
            this.access.flush(resident)
            await this.access.hibernate(resident, "account-change")
            if (resident.snapshot.session.connection === "hibernated" && !resident.closing &&
              resident.snapshot.requests.some(candidate => candidate.status === "queued")) {
              hostLog("live", "reopening an idle account for proven-unsent input", {
                conversation: resident.snapshot.session.id, request: request.id, reason: error.reason,
              })
              await this.access.wake(resident)
              return
            }
          } else {
            // Background work, subagents or an approval keep the old process
            // in use. The input waits unsent and the switch happens when they
            // end, so changing accounts never strands a session on the old one.
            const waitingFor = this.access.accountSwitchWait(resident)
            if (waitingFor) {
              dependencies.workspaceSnapshots?.abandonRun(request.id)
              resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
                candidate.id === request.id ? { ...candidate, accountSwitch: { reason: error.reason, waitingFor } } : candidate) }
              this.access.flush(resident)
              hostLog("live", "input waits for a session to switch account", {
                conversation: resident.snapshot.session.id, request: request.id, reason: error.reason, waitingFor,
              })
              return
            }
          }
          // Retirement can be refused by a checkpoint, child or ownership
          // change. Keep the unsent receipt and require explicit recovery.
          if (resident.closing || resident.snapshot.session.status === "closed") return
          if (resident.generation !== generation || this.access.control(resident).activeBindingId !== bindingId) return
        }
        if (refused && error instanceof ExecutionIdentityMismatch) {
          // The agent is signed in as someone else. Nothing was sent and the
          // conversation is intact: fail only this input, and retire the
          // process so the next message launches with whatever credentials
          // the user fixes or chooses.
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
            candidate === target ? { ...candidate, status: "failed", error: error.message, failure: "wrong-account" } : candidate) }
          checkpoints.settle(resident, request.id)
          this.access.flush(resident)
          hostWarn("live", "input refused: the agent reported a different account", { conversation: session.id, request: request.id })
          if (this.access.canHibernate(resident, false, true)) await this.access.hibernate(resident, "account-change")
          return
        }
        if (session.status === "running" && session.connection === "connected") {
          if (refused) {
            // The driver refused before sending because the provider was
            // still running a turn it had lost track of, and is showing that
            // turn now. Nothing was delivered, so the message waits for it.
            hostWarn("live", "a message waits for a turn the provider was still running", {
              conversation: resident.snapshot.session.id,
              request: request.id,
            })
            resident.snapshot = {
              ...resident.snapshot,
              requests: resident.snapshot.requests.map((candidate) =>
                candidate === target
                  ? { ...candidate, status: "queued", error: undefined, snapshots: undefined }
                  : candidate.id === told?.requestId && candidate.interruption?.told === toldAt
                    ? { ...candidate, interruption: { ...candidate.interruption, told: undefined } }
                    : candidate
              ),
            }
            dependencies.workspaceSnapshots?.abandonRun(request.id)
            this.access.flush(resident)
            return
          }
          // A send that threw without a receipt may still have started the
          // turn, and the driver still runs it: the request settles when
          // that turn ends, like any other, and is never sent again.
          hostWarn("live", "a send failed without a receipt while its turn runs; waiting for the turn", {
            conversation: resident.snapshot.session.id,
            request: request.id,
            error: errorMessage({ error }),
          })
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((candidate) =>
            candidate.id === request.id
              ? {
                  ...candidate,
                  status: "failed",
                  error: errorMessage({ error }),
                  failure: error instanceof ExecutionAccountChanged ? undefined : classifyProviderFailure(errorMessage({ error })).kind,
                }
              : candidate
          ),
        }
        if (resident.snapshot.requests.find((candidate) => candidate.id === request.id)?.failure === "auth")
          resident.snapshot = {
            ...resident.snapshot,
            requests: holdForSignIn(resident.snapshot.requests, this.access.signInHold(resident), request.id),
          }
        if (resident.snapshot.requests.find((candidate) => candidate.id === request.id)?.status === "held")
          dependencies.workspaceSnapshots?.abandonRun(request.id)
        else checkpoints.settle(resident, request.id)
        this.access.flush(resident)
      })
  }
}
