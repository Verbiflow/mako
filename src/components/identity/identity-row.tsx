import { useEffect } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar } from "@/components/ui/avatar"
import { IdentityMenu } from "@/components/identity/identity-menu"
import { github, useGitHub } from "@/state/github"
import { useAccounts } from "@/state/accounts"
import { UserIcon } from "lucide-react"

/**
 * The desk's identity, in the rail's footer and nowhere else. Superset keeps
 * its org switcher exactly here, and it is right: the bottom-left corner is
 * where a desk says whose it is. The titlebar carried a second avatar with
 * the same menu, which is one account asking to be recognised twice.
 */
export function IdentityRow() {
  const login = useGitHub((state) => state.status?.login)
  const avatar = useGitHub((state) => state.userAvatar)
  const activePlan = useAccounts(
    (state) => state.usage[activeKey(state.accounts)]?.plan
  )

  useEffect(() => {
    void github.ensureStatus()
  }, [])

  return (
    <div className="px-2 pb-2 pt-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="pressable flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover aria-expanded:bg-fill-selected"
          >
            {login ? (
              <Avatar src={avatar} name={login} size={5} className="rounded-full" />
            ) : (
              <span className="flex size-5 items-center justify-center rounded-full bg-raised">
                <UserIcon className="size-3 text-faint" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
              {login ?? "Connect GitHub"}
            </span>
            {activePlan ? (
              <span className="shrink-0 text-label text-faint">{activePlan}</span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" sideOffset={6} className="w-auto p-2">
          <IdentityMenu />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function activeKey(list: Array<{ harness: string; name: string; active: boolean }>): string {
  const active = list.find((account) => account.active)
  return active ? `${active.harness}:${active.name}` : ""
}
