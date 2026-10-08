import { useEffect, type ReactNode } from "react"
import { FaGithub } from "react-icons/fa"
import { FcGoogle } from "react-icons/fc"
import { ChevronRightIcon, CopyIcon, KeyRoundIcon, LoaderCircleIcon, SettingsIcon } from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { Action, Chip, Keys } from "@/components/ui/kit"
import { MakoTile } from "@/components/ui/mako-mark"
import { formatChord } from "@/extend/commands"
import { github, useGitHub } from "@/state/github"
import { accounts } from "@/state/accounts"
import { cloudAccount, useCloudAccount } from "@/state/cloud-account"
import { AccountLimits } from "@/components/identity/account-usage"
import { useDeskIdentity, type DeskIdentity, type SignInMethod } from "@/components/identity/desk-identity"
import { cn } from "@/lib/utils"
import type { CloudAccountState } from "@/lib/types"

/**
 * Who the desk is working as: the person on top — their Mako account, or
 * GitHub's login when that is all there is — then every agent login grouped
 * under its harness with the limits it spends against. A window near full is
 * the reason to switch, so the switch lives here, one click from anywhere.
 *
 * Signing in to Mako and connecting GitHub are different things. The account
 * is the person, made in the browser with GitHub or Google; GitHub here is the
 * gh CLI's login that pull requests use. Signed in, both hang under the
 * account as what it has: how you sign in, and what GitHub can do, folded
 * into one line when they're the same GitHub user and a warning when they
 * aren't. Signed out, each is its own row showing how to connect it, because
 * the people who have not set it up are exactly the ones who need to find it.
 */
export function IdentityMenu() {
  const identity = useDeskIdentity()
  const cloud = useCloudAccount((state) => state.account?.state)

  useEffect(() => {
    void github.ensureStatus()
    cloudAccount.load()
    accounts.load()
  }, [])

  return (
    <div className="flex max-h-[min(44rem,calc(100vh-5rem))] w-[24rem] flex-col">
      {identity.kind === "none" ? null : <Person identity={identity} />}
      {identity.kind === "mako" ? <AccountHas identity={identity} /> : null}
      {cloud && cloud.status !== "signed-in" && cloud.status !== "unavailable" ? <MakoSignIn state={cloud} /> : null}
      {identity.kind === "none" ? <GitHubConnection /> : null}

      <div className="-mx-1 mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-hairline px-1 pt-1 pb-1.5">
        <AccountLimits density="menu" />
      </div>

      <div className="border-t border-hairline pt-1.5">
        <button
          type="button"
          onClick={() => openSettings("agents")}
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

/** The person on top. The Mako account opens its settings, where its devices and signing out live. */
function Person({ identity }: { identity: Exclude<DeskIdentity, { kind: "none" }> }) {
  const face = <Avatar src={identity.avatar} name={identity.name} size={8} />
  if (identity.kind === "github")
    return (
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-2">
        {face}
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground">{identity.name}</p>
          <p className="truncate text-label text-faint">{identity.repo ? `GitHub · ${identity.repo}` : "GitHub"}</p>
        </div>
      </div>
    )
  return (
    <button
      type="button"
      onClick={() => openSettings("account")}
      className="pressable group flex w-full items-center gap-2.5 rounded-md px-2 pt-1 pb-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
    >
      {face}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-ui font-medium text-foreground">{identity.name}</p>
          {identity.offline ? <Chip tone="caution">Offline</Chip> : null}
        </div>
        <p className="truncate text-label text-faint">{identity.email}</p>
      </div>
      <ChevronRightIcon className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-muted-foreground" />
    </button>
  )
}

/** Signing in to Mako, or creating the account: one door, since the browser page is the same for both. */
function MakoSignIn({ state }: { state: Exclude<CloudAccountState, { status: "signed-in" | "unavailable" }> }) {
  const busy = useCloudAccount((store) => store.busy)
  const failure = useCloudAccount((store) => (store.failure?.action === "sign-in" ? store.failure.message : undefined))
  const notice = state.status === "signed-out" ? state.notice : undefined

  if (state.status === "signing-in")
    return (
      <Connection
        mark={<MakoTile className="size-8" />}
        markClassName="bg-transparent"
        title="Waiting for your browser…"
        detail="Finish signing in on the page that opened."
      >
        <Action size="xs" onClick={() => void cloudAccount.signIn()}>
          Open again
        </Action>
        <Action size="xs" disabled={busy === "cancel"} onClick={() => void cloudAccount.cancelSignIn()}>
          Cancel
        </Action>
      </Connection>
    )

  return (
    <Connection
      mark={<MakoTile className="size-8" />}
      markClassName="bg-transparent"
      title={notice ? "This Mac was signed out" : "Mako account"}
      detail={failure ?? notice?.message ?? "Sign in, or create one, in your browser."}
      tone={failure || notice ? "negative" : undefined}
    >
      <Action size="xs" tone="outline" disabled={busy === "sign-in"} onClick={() => void cloudAccount.signIn()}>
        {busy === "sign-in" ? <LoaderCircleIcon className="animate-spin" /> : null}
        {notice ? "Sign in again" : "Sign in"}
      </Action>
    </Connection>
  )
}

const SIGN_IN_METHODS = {
  github: { label: "GitHub", icon: <FaGithub /> },
  google: { label: "Google", icon: <FcGoogle /> },
  local: { label: "Test account", icon: <KeyRoundIcon /> },
} satisfies Record<SignInMethod, { label: string; icon: ReactNode }>

/** What the signed-in account has, hung under it: how you sign in, then what GitHub can do on this Mac. */
function AccountHas({ identity }: { identity: Extract<DeskIdentity, { kind: "mako" }> }) {
  const { signedInWith, github: gh } = identity
  const viaGitHub = signedInWith === "github"
  const signIn = signedInWith && !(viaGitHub && gh.kind === "same") ? SIGN_IN_METHODS[signedInWith] : undefined
  if (!signIn && gh.kind === "checking") return null
  return (
    <div className="mb-1.5 ml-6 flex flex-col border-l border-hairline pl-2">
      {signIn ? <Line icon={signIn.icon} label={signIn.label} aside="how you sign in" /> : null}
      {gh.kind === "same" || gh.kind === "connected" ? (
        <Line
          icon={<FaGithub />}
          label={gh.login}
          aside={gh.kind === "same" && viaGitHub ? "your sign-in and pull requests" : "pull requests and checks"}
        >
          <Chip tone="positive">Connected</Chip>
        </Line>
      ) : gh.kind === "other" ? (
        <Line
          icon={<FaGithub />}
          label={gh.login}
          aside="pull requests"
          note={`Not the GitHub user ${viaGitHub ? "you sign in with" : "on your Mako account"}.`}
          tone="caution"
        >
          <CopyCommand command="gh auth login" />
        </Line>
      ) : gh.kind === "missing" ? (
        <Line
          icon={<FaGithub />}
          muted
          label="Connect GitHub"
          note={`${gh.installed ? "Sign in to" : "Install"} the gh CLI to open pull requests and see checks.`}
        >
          <CopyCommand command="gh auth login" />
        </Line>
      ) : null}
    </div>
  )
}

/** One thing the account has: a 16-pixel mark, a name with a word on what it's for, and what to do about it. */
function Line({
  icon,
  label,
  aside,
  note,
  tone,
  muted,
  children,
}: {
  icon: ReactNode
  label: string
  aside?: string
  note?: string
  tone?: "caution"
  muted?: boolean
  children?: ReactNode
}) {
  return (
    <div className={cn("flex min-h-8 gap-2 px-1.5 py-1", note ? "items-start" : "items-center")}>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
          note && "mt-px",
          muted ? "text-faint" : "text-foreground"
        )}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-label leading-snug">
        <p className="truncate">
          <span className="font-medium text-foreground">{label}</span>
          {aside ? <span className="text-faint"> · {aside}</span> : null}
        </p>
        {note ? <p className={cn("line-clamp-2 text-pretty", tone === "caution" ? "text-caution" : "text-faint")}>{note}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center self-center">{children}</div> : null}
    </div>
  )
}

/** Connecting GitHub, when neither it nor an account is there yet. */
function GitHubConnection() {
  const installed = useGitHub((state) => state.status?.installed)
  return (
    <Connection
      mark={<FaGithub className="size-4" />}
      title="Connect GitHub"
      detail={`${installed === false ? "Install" : "Sign in to"} the gh CLI to open pull requests and see checks.`}
    >
      <CopyCommand command="gh auth login" />
    </Connection>
  )
}

function CopyCommand({ command }: { command: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(command).then(
          () => toast(`Copied ${command}`),
          () => toast.error("The command wasn't copied")
        )
      }
      className="pressable flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 font-mono text-label whitespace-nowrap text-muted-foreground hover:text-foreground"
    >
      {command}
      <CopyIcon className="size-3" />
    </button>
  )
}

function Connection({
  mark,
  markClassName,
  title,
  detail,
  tone,
  children,
}: {
  mark: ReactNode
  markClassName?: string
  title: string
  detail?: string
  tone?: "negative"
  children?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span
        className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-foreground", markClassName)}
        aria-hidden
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground">{title}</p>
        {detail ? (
          <p className={cn("line-clamp-2 text-label leading-snug", tone === "negative" ? "text-negative" : "text-faint")}>
            {detail}
          </p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  )
}

function openSettings(section: string) {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: section }))
}
