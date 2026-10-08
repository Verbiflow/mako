import { useEffect } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar } from "@/components/ui/avatar"
import { IdentityMenu } from "@/components/identity/identity-menu"
import { useDeskIdentity } from "@/components/identity/desk-identity"
import { confirmStore } from "@/state/confirm"
import { github } from "@/state/github"
import { accounts } from "@/state/accounts"
import { cloudAccount, useCloudAccount } from "@/state/cloud-account"
import { LoaderCircleIcon, UserIcon } from "lucide-react"

/**
 * The desk's identity, in the rail's footer and nowhere else. Superset keeps
 * its org switcher exactly here, and it is right: the bottom-left corner is
 * where a desk says whose it is. The titlebar carried a second avatar with
 * the same menu, which is one account asking to be recognised twice.
 *
 * The Mako account when there is one, GitHub's login when there is only
 * that, and otherwise the first step: signing in where a cloud is
 * configured, connecting GitHub where none is.
 */
export function IdentityRow() {
  const identity = useDeskIdentity()
  const cloud = useCloudAccount((state) => state.account?.state.status)

  useEffect(() => {
    void github.ensureStatus()
    cloudAccount.load()
  }, [])

  const signingIn = identity.kind === "none" && cloud === "signing-in"
  const label =
    identity.kind !== "none"
      ? identity.name
      : signingIn
        ? "Signing in…"
        : cloud === "signed-out"
          ? "Sign in"
          : "Connect GitHub"

  return (
    <div className="px-2 pb-2 pt-1">
      <Popover onOpenChange={(open) => open && accounts.load()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="pressable flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover aria-expanded:bg-fill-selected"
          >
            {identity.kind !== "none" ? (
              <Avatar src={identity.avatar} name={identity.name} size={5} className="rounded-full" />
            ) : (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised">
                {signingIn ? (
                  <LoaderCircleIcon className="size-3 animate-spin text-faint" />
                ) : (
                  <UserIcon className="size-3 text-faint" />
                )}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-auto p-1.5"
          // A confirmation asked from the menu sits above it; answering one is not leaving the menu.
          onInteractOutside={(event) => {
            if (confirmStore.get().request) event.preventDefault()
          }}
        >
          <IdentityMenu />
        </PopoverContent>
      </Popover>
    </div>
  )
}
