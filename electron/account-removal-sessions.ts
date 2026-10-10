import type { AccountHolder } from "./account-holds.js"
import type { AccountRemovalEvent, AccountRemovalPlan, AccountRemovalSession } from "@mako/host/contracts/accounts"
import type { HarnessAccounts } from "./accounts.js"

/** The live sessions running on an account, which its removal names and retires. */
export interface AccountSessions {
  accountSessions(bindingIds: readonly string[]): AccountRemovalSession[]
  retireAccountSessions(bindingIds: readonly string[]): void
}

function sessionBindings(holders: readonly AccountHolder[]): string[] {
  return holders.flatMap((holder) => holder.kind === "session" ? [holder.binding] : [])
}

/**
 * Joins account removal to this host's live sessions: the confirmation names
 * them, a pending removal retires the idle ones at once, and each busy one
 * asks `removing` on its idle check and retires then. Removals this host is
 * waiting on are kept in memory, so the idle check costs nothing when there
 * are none.
 */
export function accountRemovalSessions(accounts: HarnessAccounts, sessions: () => AccountSessions | undefined, report: (harness: string, name: string, event: AccountRemovalEvent) => void) {
  const waiting = new Set<string>()
  const dispose = accounts.onRemoval((harness, name, event) => {
    const key = `${harness}/${name}`
    if (event.status === "pending") {
      waiting.add(key)
      sessions()?.retireAccountSessions(sessionBindings(accounts.holds.holders(harness, name)))
    } else waiting.delete(key)
    report(harness, name, event)
  })
  return {
    dispose,
    removing(bindingId: string): boolean {
      if (!waiting.size) return false
      const account = accounts.holds.binding(bindingId)
      return account !== undefined && waiting.has(`${account.provider}/${account.name}`)
    },
    async plan(harness: string, name: string): Promise<AccountRemovalPlan> {
      const { holders, elsewhere } = await accounts.removalHolders(harness, name)
      const named = sessions()?.accountSessions(sessionBindings(holders)) ?? []
      return { sessions: named, runs: holders.length - named.length, elsewhere }
    },
  }
}
