import { useEffect } from "react"
import { Avatar } from "@/components/ui/avatar"
import { Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { github, useGitHub } from "@/state/github"
import { accounts } from "@/state/accounts"
import { CopyIcon, SettingsIcon } from "lucide-react"
import { AccountLimits } from "@/components/identity/account-usage"

/**
 * Who the desk is working as: the GitHub identity on top, then every agent
 * login grouped under its harness with the limits it spends against — a
 * window near full is the reason to switch, so the switch lives here, one
 * click from anywhere.
 *
 * Three states, none of them hidden: no GitHub yet shows how to connect
 * (the capability must be discoverable exactly by the people who have not
 * set it up), connected shows the accounts, loading holds their shape.
 */
export function IdentityMenu() {
  const status = useGitHub((state) => state.status)
  const avatar = useGitHub((state) => state.userAvatar)

  useEffect(() => {
    void github.ensureStatus()
    accounts.load()
  }, [])

  const connected = Boolean(status?.installed && status?.authenticated)

  return (
    <div className="flex max-h-[min(44rem,calc(100vh-5rem))] w-[24rem] flex-col">
      {connected && status?.login ? (
        <div className="flex items-center gap-2.5 px-2 pt-1 pb-2.5">
          <Avatar src={avatar} name={status.login} size={8} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui font-medium text-foreground">
              {status.login}
            </p>
            <p className="truncate text-label text-faint">
              {status.repo ? `GitHub · ${status.repo}` : "GitHub"}
            </p>
          </div>
        </div>
      ) : (
        <div className="px-2 pt-1 pb-2.5">
          <p className="text-ui font-medium text-foreground">Connect GitHub</p>
          <p className="pt-0.5 text-label leading-relaxed text-faint">
            Mako reuses the gh CLI's login for pull requests and identity.
          </p>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText("gh auth login")}
            className="pressable mt-1.5 flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 font-mono text-label text-muted-foreground hover:text-foreground"
          >
            gh auth login
            <CopyIcon className="size-3" />
          </button>
        </div>
      )}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-hairline px-1 pt-1 pb-1.5">
        <AccountLimits density="menu" />
      </div>

      <div className="border-t border-hairline pt-1.5">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("mako:settings", { detail: "agents" })
            )
          }
          className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        >
          <SettingsIcon className="size-3.5" />
          <span className="flex-1">Accounts and settings</span>
          <Keys keys={formatChord("mod+,")} />
        </button>
      </div>
    </div>
  )
}
