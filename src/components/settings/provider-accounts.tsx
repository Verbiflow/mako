import { useState } from "react"
import {
  accounts as accountActions,
  accountGroups,
  useAccounts,
} from "@/state/accounts"
import { Action, ListCard } from "@/components/ui/kit"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { HarnessAccounts } from "@/components/identity/account-usage"

/**
 * One harness's logins inside its Settings → Agents row: the same account
 * entries and limits as the identity menu, plus saving and removing logins.
 * `hint` says how to change a login the CLI owns, for harnesses whose row
 * has no sign-in controls of its own.
 */
export function ProviderAccounts({
  providerId,
  hint = true,
}: {
  providerId: string
  hint?: boolean
}) {
  const provider = useAccounts((state) =>
    state.providers.find((entry) => entry.provider === providerId)
  )
  const group = useAccounts((state) =>
    accountGroups(state).find((entry) => entry.provider.provider === providerId)
  )
  const busy = useAccounts((state) => state.busy)
  const [capturing, setCapturing] = useState(false)
  const [captureName, setCaptureName] = useState("")
  if (!provider) return null

  const capture = async () => {
    if (!captureName.trim()) return
    try {
      await accountActions.capture(providerId, captureName.trim())
      setCapturing(false)
      setCaptureName("")
    } catch (error) {
      toast.error("Account was not saved", {
        duration: ACTION_TOAST_MS,
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Try again", onClick: () => void capture() },
      })
    }
  }

  const selectable = provider.mode === "selectable"
  return (
    <div className="@container flex flex-col gap-2">
      {selectable ? (
        <p className="text-ui leading-relaxed text-faint">
          Each login stays isolated while sharing the same sessions, skills and
          tools. New sessions use the checked account. Choose another account
          before removing the selected login.
        </p>
      ) : hint ? (
        <p className="text-ui leading-relaxed text-faint">
          {provider.label} owns this login. To change it, run{" "}
          <code className="font-mono text-muted-foreground">
            {provider.loginCommand}
          </code>{" "}
          in a terminal, then refresh.
        </p>
      ) : null}
      {group ? (
        <HarnessAccounts
          group={group}
          heading={false}
          actions={(account) =>
            selectable &&
            account.name !== "default" &&
            account.source !== "subrouter" ? (
              <Action
                size="xs"
                aria-label={`Remove ${account.email ?? account.name}`}
                title={account.active ? "Choose another account before removing this login" : "Remove this saved login from Mako"}
                disabled={Boolean(busy) || account.active}
                onClick={() =>
                  void accountActions.remove(account.harness, account.name)
                }
                className="text-label font-normal text-faint"
              >
                Remove
              </Action>
            ) : null
          }
        />
      ) : (
        <ListCard className="py-3 text-ui text-faint">
          No {provider.label} login found.
        </ListCard>
      )}
      {selectable ? (
        capturing ? (
          <ListCard className="py-3">
            <p className="pb-2 text-ui text-muted-foreground">
              First run{" "}
              <code className="font-mono text-foreground">
                {provider.loginCommand}
              </code>{" "}
              in a terminal. Then name that login in Mako.
            </p>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={captureName}
                onChange={(event) => setCaptureName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void capture()
                  if (event.key === "Escape") setCapturing(false)
                }}
                placeholder="Name, such as Work"
                className="h-7 w-44 rounded-md bg-raised px-2 text-ui text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none"
              />
              <Action
                disabled={!captureName.trim()}
                onClick={() => void capture()}
              >
                Save current login
              </Action>
              <Action tone="ghost" onClick={() => setCapturing(false)}>
                Cancel
              </Action>
            </div>
          </ListCard>
        ) : (
          <Action
            size="xs"
            onClick={() => setCapturing(true)}
            className="-ml-1.5 self-start font-normal"
          >
            <PlusIcon className="text-faint" />
            Add another account
          </Action>
        )
      ) : null}
    </div>
  )
}
