import { useEffect, useState, type ReactNode } from "react"
import { BellIcon, BellOffIcon, ChevronLeftIcon, CopyIcon, LogOutIcon, MoonIcon, ShareIcon, SmartphoneIcon } from "lucide-react"
import { toast } from "sonner"
import { Avatar } from "@/components/ui/avatar"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import type { PushStanding, QuietHours } from "./push"
import { useTheme, type WebTheme } from "./theme"

const DEFAULT_QUIET: QuietHours = { start: "22:00", end: "07:00" }

export function Settings({ onBack }: { onBack: () => void }) {
  const client = useWebClient()
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-shell">
      <header className="web-bar flex shrink-0 items-center gap-1 px-2">
        <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
          <ChevronLeftIcon className="size-5" />
        </button>
        <h1 className="flex-1 text-ui font-semibold">Settings</h1>
      </header>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <div className="mx-auto flex max-w-[560px] flex-col gap-7 pt-3">
          <Group>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Avatar name={client.account.name} src={client.account.image ?? undefined} size={8} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium">{client.account.name}</p>
                <p className="truncate text-label text-faint">{client.account.email}</p>
              </div>
            </div>
          </Group>
          <Notifications />
          <Appearance />
          <Group title="This browser">
            <Row label="Signed in as a device of your account" detail="Signing out here, or from a Mac's Settings › Account, ends it at once." icon={<SmartphoneIcon className="size-4" />} />
            <button
              type="button"
              onClick={() => void client.signOut()}
              className="web-row flex h-12 w-full items-center gap-3 px-4 text-left text-ui text-negative"
            >
              <LogOutIcon className="size-4" />
              Sign out
            </button>
          </Group>
          <Diagnostics />
        </div>
      </div>
    </div>
  )
}

function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title ? <h2 className="px-1 text-label font-medium text-faint">{title}</h2> : null}
      <div className="flex flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-hairline [&>*+*]:border-t [&>*+*]:border-hairline">{children}</div>
      {footer ? <p className="px-1 text-label text-faint">{footer}</p> : null}
    </section>
  )
}

function Row({ label, detail, icon, end }: { label: string; detail?: string; icon?: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-ui">{label}</p>
        {detail ? <p className="text-label text-faint">{detail}</p> : null}
      </div>
      {end}
    </div>
  )
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cn("web-switch", on && "web-switch-on")}>
      <span aria-hidden />
    </button>
  )
}

const STANDING_WORDS = {
  on: "A Thread that needs you, once, and never while you're at your Mac.",
  off: "Approvals, questions, failures and finished turns.",
  denied: "Notifications are blocked for this site in the browser's settings.",
  unsupported: "This browser doesn't offer web notifications.",
  install: "On iPhone and iPad, add Mako to your Home Screen first: Share, then Add to Home Screen.",
} satisfies Record<PushStanding, string>

function Notifications() {
  const client = useWebClient()
  const [standing, setStanding] = useState<PushStanding | undefined>(undefined)
  const [quiet, setQuiet] = useState<QuietHours | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void client.push.standing().then(
      (found) => {
        setStanding(found.standing)
        setQuiet(found.quietHours)
      },
      () => setStanding("unsupported")
    )
  }, [client])
  const change = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) setStanding(await client.push.enable(quiet))
      else {
        await client.push.disable()
        setStanding("off")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const setHours = async (next: QuietHours | null) => {
    setQuiet(next)
    await client.push.setQuietHours(next).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  }
  const available = standing === "on" || standing === "off"
  return (
    <Group title="Notifications" footer={standing ? STANDING_WORDS[standing] : undefined}>
      <Row
        label="When a Thread needs you"
        icon={standing === "on" ? <BellIcon className="size-4" /> : standing === "install" ? <ShareIcon className="size-4" /> : <BellOffIcon className="size-4" />}
        end={<Switch on={standing === "on"} onChange={(on) => void change(on)} label="Notify this browser when a Thread needs you" disabled={!available || busy} />}
      />
      {standing === "on" ? (
        <Row
          label="Quiet hours"
          detail={quiet ? `Held from ${quiet.start} to ${quiet.end}, then sent if still true` : "Off"}
          icon={<MoonIcon className="size-4" />}
          end={<Switch on={quiet !== null} onChange={(on) => void setHours(on ? DEFAULT_QUIET : null)} label="Quiet hours" />}
        />
      ) : null}
      {standing === "on" && quiet ? (
        <div className="flex items-center gap-3 px-4 py-2.5">
          <label className="flex flex-1 items-center justify-between gap-2 text-ui">
            From
            <input type="time" value={quiet.start} onChange={(event) => void setHours({ ...quiet, start: event.target.value })} className="web-field h-9 w-28" />
          </label>
          <label className="flex flex-1 items-center justify-between gap-2 text-ui">
            To
            <input type="time" value={quiet.end} onChange={(event) => void setHours({ ...quiet, end: event.target.value })} className="web-field h-9 w-28" />
          </label>
        </div>
      ) : null}
    </Group>
  )
}

const THEMES: Array<{ value: WebTheme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

function Appearance() {
  const [theme, setTheme] = useTheme()
  return (
    <Group title="Appearance">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 p-1.5">
        {THEMES.map((each) => (
          <button
            key={each.value}
            type="button"
            role="radio"
            aria-checked={theme === each.value}
            onClick={() => setTheme(each.value)}
            className={cn("pressable h-9 rounded-xl text-ui", theme === each.value ? "bg-fill-selected font-medium text-foreground" : "text-muted-foreground")}
          >
            {each.label}
          </button>
        ))}
      </div>
    </Group>
  )
}

/** What someone debugging the web reads first: who this browser is, where the list stands, and the last failure to quote. */
function Diagnostics() {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const lines: Array<[string, string]> = [
    ["Device", client.deviceId],
    ["Account", client.account.id],
    ["List", `${list.phase}${list.seq === undefined ? "" : ` at ${list.seq}`}${list.asOf ? `, ${copyAge(list.asOf)}` : ""}`],
    ["Rows", String(list.rows.length)],
  ]
  if (list.failure) lines.push(["Last failure", `${list.failure.message} (${copyAge(list.failure.at)})${list.failure.correlationId ? ` · ${list.failure.correlationId}` : ""}`])
  if (client.options.build) lines.push(["Build", client.options.build])
  const text = lines.map(([label, value]) => `${label}: ${value}`).join("\n")
  return (
    <Group title="Diagnostics">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 font-mono text-label">
        {lines.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="min-w-0 break-all text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))} className="web-row flex h-11 w-full items-center gap-3 px-4 text-left text-ui">
        <CopyIcon className="size-4 text-muted-foreground" />
        Copy diagnostics
      </button>
    </Group>
  )
}
