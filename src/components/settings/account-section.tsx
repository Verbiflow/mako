import { useEffect, useState } from "react"
import {
  CopyIcon,
  ExternalLinkIcon,
  CheckIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { Action, Chip, Eyebrow, ListCard, ListCardRow } from "@/components/ui/kit"
import { MakoMark } from "@/components/ui/mako-mark"
import { cloudAccount, useCloudAccount } from "@/state/cloud-account"
import { formatDay, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CloudAccountState, CloudDevice } from "@/lib/types"

type SignedIn = Extract<CloudAccountState, { status: "signed-in" }>

/** This Mac's Mako account: signing in through the browser, and the devices it's signed in on. */
export function AccountSection() {
  const account = useCloudAccount((state) => state.account)
  useEffect(() => cloudAccount.load(), [])
  if (!account) return <p className="text-ui text-faint">Reading your account…</p>
  const { state } = account
  return (
    <div key={state.status} className="flex animate-enter flex-col gap-6" data-testid="account-section">
      {state.status === "signed-in" ? (
        <SignedInView state={state} cloud={account.cloud} />
      ) : (
        <SignedOutView state={state} cloud={account.cloud} />
      )}
    </div>
  )
}

function SignedOutView({ state, cloud }: { state: Exclude<CloudAccountState, SignedIn>; cloud: string | null }) {
  const busy = useCloudAccount((store) => store.busy)
  const failure = useCloudAccount((store) => store.failure)
  const waiting = state.status === "signing-in"
  const notice = state.status === "signed-out" ? state.notice : undefined
  const error = failure && failure.action !== "devices" ? failure.message : undefined
  return (
    <div className="flex flex-col items-center rounded-2xl border border-hairline bg-raised/40 px-8 pt-10 pb-8 text-center">
      <ThisMacToMako state={waiting ? "waiting" : notice || error || state.status === "unavailable" ? "broken" : "idle"} />
      <h3 className="mt-7 text-title font-medium">
        {state.status === "unavailable"
          ? "Signing in isn't available"
          : waiting
            ? "Waiting for your browser"
            : notice?.kind === "removed"
              ? "This Mac was signed out"
              : "Sign in to Mako"}
      </h3>
      <p className="mt-1.5 max-w-[25rem] text-ui leading-relaxed text-pretty text-muted-foreground">
        {state.status === "unavailable"
          ? state.message
          : waiting
            ? "Choose your account on the page that opened. Mako carries on by itself once you have."
            : notice?.kind === "removed"
              ? notice.message
              : "Connect this Mac to your Mako account. Signing in happens in your browser with GitHub or Google, so Mako never sees your password."}
      </p>

      {notice && notice.kind !== "removed" ? (
        <Note tone="negative" className="mt-5 max-w-[25rem]">
          {notice.message}
        </Note>
      ) : null}
      {error ? (
        <Note tone="negative" className="mt-5 max-w-[25rem]">
          {error}
        </Note>
      ) : null}

      {state.status === "signed-out" ? (
        <Action
          tone="solid"
          size="md"
          className="mt-6"
          disabled={busy === "sign-in"}
          onClick={() => void cloudAccount.signIn()}
        >
          {busy === "sign-in" ? <LoaderCircleIcon className="animate-spin" /> : null}
          {notice ? "Sign in again" : "Sign in with browser"}
        </Action>
      ) : null}

      {waiting ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
          <Action tone="outline" onClick={() => void cloudAccount.signIn()}>
            <ExternalLinkIcon />
            Open the page again
          </Action>
          <Action onClick={() => copy(state.url, "Sign-in link")}>
            <CopyIcon />
            Copy link
          </Action>
          <Action disabled={busy === "cancel"} onClick={() => void cloudAccount.cancelSignIn()}>
            Cancel
          </Action>
        </div>
      ) : null}

      {cloud && state.status !== "unavailable" ? (
        <p className="mt-5 flex items-center gap-1.5 text-label text-faint">
          <LockIcon className="size-3" />
          {waiting ? `${hostOf(cloud)} · the link lasts ten minutes` : `Opens ${hostOf(cloud)} in your browser`}
        </p>
      ) : null}
    </div>
  )
}

/** The picture the sign-in pages draw in the browser, so the two ends of signing in look like one thing. */
function ThisMacToMako({ state }: { state: "idle" | "waiting" | "connected" | "broken" }) {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <div className="flex size-13 items-center justify-center rounded-[15px] border border-hairline bg-background text-muted-foreground shadow-xs [&_svg]:size-6">
        <LaptopIcon strokeWidth={1.6} />
      </div>
      <div
        data-state={state}
        className={cn(
          "cloud-wire relative flex w-16 items-center justify-center",
          state === "connected" ? "text-positive" : state === "broken" ? "text-negative" : "text-faint"
        )}
      >
        {state === "connected" || state === "broken" ? (
          <span
            className={cn(
              "relative z-10 flex size-5 animate-enter items-center justify-center rounded-full text-background [&_svg]:size-3",
              state === "connected" ? "bg-positive" : "bg-negative"
            )}
          >
            {state === "connected" ? <CheckIcon strokeWidth={3} /> : <XIcon strokeWidth={3} />}
          </span>
        ) : null}
      </div>
      <div className="flex size-13 items-center justify-center rounded-[15px] bg-foreground text-background shadow-sm">
        <MakoMark className="size-7" />
      </div>
    </div>
  )
}

function SignedInView({ state, cloud }: { state: SignedIn; cloud: string | null }) {
  const busy = useCloudAccount((store) => store.busy)
  const failure = useCloudAccount((store) => store.failure)
  const { account } = state
  const invited = account.entitlements.includes("cloud")
  return (
    <>
      <div className="flex flex-col gap-4 rounded-2xl border border-hairline bg-raised/40 p-5">
        <div className="flex items-center gap-4">
          <Avatar src={account.image ?? undefined} name={account.name || account.email} size={14} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-title font-medium">{account.name || account.email}</h3>
              <ConnectionChip connection={state.connection} />
            </div>
            <p className="mt-1 truncate text-ui text-muted-foreground">{account.email}</p>
          </div>
          <Action tone="outline" disabled={busy === "sign-out"} onClick={() => void cloudAccount.signOut()}>
            {busy === "sign-out" ? <LoaderCircleIcon className="animate-spin" /> : null}
            Sign out
          </Action>
        </div>
        <p className="flex items-center gap-1.5 border-t border-hairline pt-3.5 text-label text-faint">
          <LockIcon className="size-3 shrink-0" />
          <span className="truncate">
            {cloud ? `Signed in to ${hostOf(cloud)}` : "Signed in"}
            {state.kept === "keychain"
              ? ", kept in this Mac's keychain"
              : state.kept === "fixture"
                ? ". A fixture desk keeps this only until it quits"
                : null}
          </span>
        </p>
      </div>

      {state.kept === "memory" ? (
        <Note tone="caution">This Mac's keychain isn't available, so you'll sign in again after Mako quits.</Note>
      ) : null}
      {failure?.action === "sign-out" ? <Note tone="negative">{failure.message}</Note> : null}

      <div className="flex flex-col gap-2">
        <Eyebrow>Cloud</Eyebrow>
        <ListCard>
          <ListCardRow className="flex items-center justify-between gap-6">
            <p className="text-ui leading-relaxed text-muted-foreground">
              {invited
                ? "Your account can run Threads in Mako's cloud."
                : "Mako's cloud is invite-only for now. Once you're invited, this Mac picks it up within a few minutes."}
            </p>
            <Chip tone={invited ? "positive" : "neutral"} className="shrink-0 whitespace-nowrap">
              {invited ? "Invited" : "Not invited yet"}
            </Chip>
          </ListCardRow>
        </ListCard>
      </div>

      <Devices current={state.device} connection={state.connection} />
    </>
  )
}

function Devices({ current, connection }: { current: CloudDevice; connection: SignedIn["connection"] }) {
  const devices = useCloudAccount((store) => store.devices)
  const failure = useCloudAccount((store) => store.failure)
  const [confirming, setConfirming] = useState<string>()
  useEffect(() => {
    if (connection !== "connected") return
    void cloudAccount.loadDevices()
    const refresh = () => void cloudAccount.loadDevices()
    const timer = setInterval(refresh, 60_000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [connection])
  const list = devices?.list ?? [current]
  const ordered = [...list].sort((a, b) =>
    a.id === current.id ? -1 : b.id === current.id ? 1 : b.lastSeenAt.localeCompare(a.lastSeenAt)
  )
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>Devices</Eyebrow>
      <ListCard>
        {ordered.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            current={device.id === current.id}
            confirming={confirming === device.id}
            onConfirm={(next) => setConfirming(next ? device.id : undefined)}
          />
        ))}
      </ListCard>
      {failure?.action.startsWith("remove:") ? (
        <Note tone="negative">{failure.message}</Note>
      ) : !devices && failure?.action === "devices" ? (
        <p className="px-1 text-label text-faint">The other devices couldn't be read: {failure.message}</p>
      ) : (
        <p className="px-1 text-label leading-relaxed text-faint">
          Removing a device signs it out within seconds, wherever it is.
        </p>
      )}
    </div>
  )
}

const DEVICE_ICONS = { desktop: LaptopIcon, cli: TerminalIcon, runtime: ServerIcon } as const

function DeviceRow({
  device,
  current,
  confirming,
  onConfirm,
}: {
  device: CloudDevice
  current: boolean
  confirming: boolean
  onConfirm: (confirming: boolean) => void
}) {
  const busy = useCloudAccount((store) => store.busy)
  const removing = busy === `remove:${device.id}`
  const Icon = DEVICE_ICONS[device.kind]
  return (
    <ListCardRow className="flex items-center gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted-foreground [&_svg]:size-4">
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui font-medium">{device.name}</span>
          {current ? <Chip>This Mac</Chip> : null}
        </div>
        {confirming ? (
          <p className="mt-0.5 truncate text-label text-caution">It will be signed out within seconds.</p>
        ) : (
          <p className="mt-0.5 truncate text-label text-faint">
            {[device.platform, device.appVersion ? `Mako ${device.appVersion}` : null, current ? null : seen(device.lastSeenAt)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
      {current ? null : confirming ? (
        <div className="flex animate-enter items-center gap-1">
          <Action size="xs" disabled={removing} onClick={() => onConfirm(false)}>
            Cancel
          </Action>
          <Action
            size="xs"
            tone="danger"
            disabled={removing}
            onClick={() => void cloudAccount.removeDevice(device.id).then((ok) => ok && onConfirm(false))}
          >
            {removing ? <LoaderCircleIcon className="animate-spin" /> : null}
            Remove
          </Action>
        </div>
      ) : (
        <Action size="xs" disabled={Boolean(busy)} onClick={() => onConfirm(true)}>
          Remove
        </Action>
      )}
    </ListCardRow>
  )
}

function ConnectionChip({ connection }: { connection: SignedIn["connection"] }) {
  if (connection === "connected") return <Chip tone="positive">Connected</Chip>
  if (connection === "offline") return <Chip tone="caution">Offline, retrying</Chip>
  return <Chip>Connecting…</Chip>
}

function Note({ tone, className, children }: { tone: "caution" | "negative"; className?: string; children: string }) {
  return (
    <p
      role={tone === "negative" ? "alert" : "status"}
      className={cn(
        "rounded-lg px-3 py-2 text-ui leading-relaxed ring-1 ring-inset",
        tone === "caution" ? "bg-caution/8 text-caution ring-caution/20" : "bg-negative/8 text-negative ring-negative/20",
        className
      )}
    >
      {children}
    </p>
  )
}

/** A device's `lastSeenAt` moves when it renews its connection, every few minutes while it's on. */
function seen(lastSeenAt: string): string {
  const minutes = (Date.now() - new Date(lastSeenAt).getTime()) / 60_000
  if (minutes < 10) return "Active now"
  const relative = formatRelative(lastSeenAt) || formatDay(lastSeenAt)
  return /^\d/.test(relative) ? `Last active ${relative} ago` : `Last active ${relative}`
}

function hostOf(cloud: string): string {
  return URL.canParse(cloud) ? new URL(cloud).host : cloud
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast.error(`The ${what.toLowerCase()} wasn't copied`)
  )
}
