import { accountHolders, bindingAccount, type AccountHolder } from "./account-holds.js"
import type { AccountRemovalEvent, AccountRemovalPlan, AccountRemovalSession } from "./account-types.js"
import { accountRemovalHolders, onAccountRemoval } from "./accounts.js"

interface Sessions {
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
export function accountRemovalSessions(sessions: () => Sessions | undefined, report: (harness: string, name: string, event: AccountRemovalEvent) => void) {
  const waiting = new Set<string>()
  const dispose = onAccountRemoval((harness, name, event) => {
    const key = `${harness}/${name}`
    if (event.status === "pending") {
      waiting.add(key)
      sessions()?.retireAccountSessions(sessionBindings(accountHolders(harness, name)))
    } else waiting.delete(key)
    report(harness, name, event)
  })
  return {
    dispose,
    removing(bindingId: string): boolean {
      if (!waiting.size) return false
      const account = bindingAccount(bindingId)
      return account !== undefined && waiting.has(`${account.provider}/${account.name}`)
    },
    async plan(harness: string, name: string): Promise<AccountRemovalPlan> {
      const { holders, elsewhere } = await accountRemovalHolders(harness, name)
      const named = sessions()?.accountSessions(sessionBindings(holders)) ?? []
      return { sessions: named, runs: holders.length - named.length, elsewhere }
    },
  }
}
