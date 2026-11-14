import { branchSince, checkoutSince } from "../base/checkout-since.js"
import type { InterruptionReason } from "../contracts/live-conversations.js"
import { finResumedText } from "../contracts/resume-account.js"
import { CUT_BY } from "../contracts/turn-continuation.js"

/**
 * What a Fin or an Apex whose cut turn goes on reads beneath the continuation's words, as a stopped Fin's resume does
 * (`finResumedText`): when and what cut it, what moved in its checkout at `cwd` since, and where its branch stands
 * against the one it goes into.
 */
export async function cutAccount(cwd: string | undefined, at: number, reason: InterruptionReason, now: number): Promise<string | undefined> {
  if (!cwd) return undefined
  const [checkout, branches] = await Promise.all([checkoutSince(cwd, at), branchSince(cwd, at)])
  return finResumedText({ how: "cut", at, reason: CUT_BY[reason], now, checkout, branches })
}
