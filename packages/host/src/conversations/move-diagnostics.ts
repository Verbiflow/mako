import { z } from "zod"
import type { FailureBoundary } from "../base/error-message.js"
import type { HostLogFields } from "../base/host-log.js"

/** Only product-owned words enter the durable log; arbitrary errors can contain prompts, paths or credentials. */
export function moveDiagnosticReason(boundary: FailureBoundary): HostLogFields {
  try {
    return reasonFields(boundary)
  } catch {
    // Even descriptor inspection can throw on a Proxy. Diagnostics must not replace the move's result.
    return withheldReason()
  }
}

function withheldReason(): HostLogFields {
  return { reason: "The move failed; its private error details were withheld.", reasonRedacted: true }
}

function reasonFields({ error }: FailureBoundary): HostLogFields {
  // The default invalid-type formatter inspects the rejected value's prototype. Never run it on an error.
  const text = z.string({ error: "Diagnostic text was withheld." })
  const direct = text.safeParse(error)
  let message = direct.success ? direct.data : undefined
  let code: string | undefined
  if (!direct.success) {
    // Reflect only own descriptors; parsing an error object would enumerate it and could invoke accessors.
    const messageField = Object.getOwnPropertyDescriptor(error, "message")
    const codeField = Object.getOwnPropertyDescriptor(error, "code")
    if (!messageField || !("value" in messageField) || (codeField && !("value" in codeField))) return withheldReason()
    const parsedMessage = text.safeParse(messageField.value)
    const parsedCode = text.optional().safeParse(codeField?.value)
    if (!parsedMessage.success || !parsedCode.success) return withheldReason()
    message = parsedMessage.data
    code = parsedCode.data
  }
  if (message === undefined) return withheldReason()
  const known = [
    "Moving to the cloud needs this Mac signed in to Mako Cloud.",
    "Moves need the Thread store, which didn't open.",
    "This conversation isn't in a Thread yet.",
    "This Thread runs in the cloud already. Bring it back to this Mac first to move it again.",
    "This Thread is moving already.",
    "A Thread in the project folder goes onto its own branch before it moves, once its turn has ended. Move it then.",
    "A Thread moves to the cloud from its own worktree. Move it into one first; the main checkout stays here.",
    "Every tab in the Thread needs to have started before it moves: send a first message or close the empty tab.",
    "This Thread has no sessions to move.",
    "This folder holds no repository, so there's no branch to make.",
    "This checkout has uncommitted changes, which a move carries onto the commit they were made on. Leave base out, or commit them first.",
    "This repository has no commits yet, so a worktree has nothing to start from. Make a first commit, or choose Project folder.",
    "It's on its own branch now, as a conversation forked from this one, which starts with its next message. Send it one, then move it to the cloud.",
  ].find((reason) => reason === message)
  const summary = known ?? (
    message.startsWith("Moves happen between turns:") ? "Moves happen between turns; work is still active." :
    message.startsWith("A tab in this Thread works in ") ? "A tab in this Thread works outside its worktree." :
    message.startsWith("Git couldn't create the worktree") ? "Git couldn't create the worktree." :
    message.startsWith("The worktree couldn't take the changes,") ? "The worktree couldn't take the changes." :
    "The move failed; its private error details were withheld."
  )
  const knownCode = code !== undefined && ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EEXIST", "EROFS", "EBUSY", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"].includes(code) ? code : undefined
  return { reason: summary, reasonRedacted: !known, ...knownCode && { code: knownCode } }
}

/** One best-effort diagnostic attempt; a field or writer failure must not alter the operation or trigger a retry. */
export function logMoveDiagnostic(write: () => void): void {
  try { write() } catch { /* The existing move result and step remain authoritative. */ }
}
