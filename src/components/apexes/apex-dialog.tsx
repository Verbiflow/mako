import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { APEX_NAME_CHARS, APEX_PURPOSE_CHARS } from "@mako/host/contracts/apexes"
import { localWords } from "@mako/protocol/computer-words"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import type { FinTarget } from "@mako/host/contracts/fin-tuning"
import { TargetPicker } from "@/components/settings/fin-rules"
import { FileIcon } from "@/components/ui/file-icon"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, FIELD, Keys, Segmented } from "@/components/ui/kit"
import { ApexMark } from "@/components/ui/apex-mark"
import { formatChord } from "@/extend/commands"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { closeApexDialog, createApex, promoteToApex, useApexDialog } from "@/state/apexes"
import { useHarnessOrder } from "@/state/harness-order"
import { useRecentProjects } from "@/state/open-project"
import { useProviders } from "@/state/providers"
import { useSession } from "@/state/session"
import { useWorktrees } from "@/state/worktrees"
import { useThreads } from "@/state/thread-store"

/**
 * New Apex, and Make this an Apex: a name, its folder, a line of what it covers, the harness and model it runs on,
 * where its Fins run, and its first message, which says what it's for. No kinds: the first message is its purpose,
 * and the Apex writes it into its rules and plan. Keyboard first: the name has focus, ⌘↩ makes it, Escape leaves.
 */
export function ApexDialog() {
  const open = useApexDialog((state) => state.open)
  return (
    <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : closeApexDialog())}>
      <DialogContent data-apex-dialog={open?.mode} className="flex max-h-[min(44rem,calc(100vh-4rem))] flex-col gap-0 p-0">
        {open?.mode === "new" ? <NewApex folder={open.folder} /> : open?.mode === "promote" ? <PromoteApex conversation={open.conversation} name={open.name} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function Heading({ title, line }: { title: string; line?: string }) {
  return (
    <div className={cn("flex gap-3 px-5 pt-5 pb-4", line ? "items-start" : "items-center")}>
      <span className="flex size-8 shrink-0 items-center justify-center bg-raised text-muted-foreground">
        <ApexMark className="size-4" />
      </span>
      <div className="min-w-0">
        <DialogTitle className="text-title font-semibold">{title}</DialogTitle>
        {line ? <p className="mt-0.5 text-label text-muted-foreground">{line}</p> : null}
      </div>
    </div>
  )
}

function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline gap-2 text-label text-muted-foreground">
        {label}
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </span>
      {children}
    </label>
  )
}

/** A purpose's count, quiet until the last twenty characters. */
function Count({ value, max }: { value: string; max: number }) {
  const left = max - value.length
  return <span data-purpose-count={value.length} className={cn("tabular text-label", left < 20 ? "text-caution" : "text-faint")}>{value.length}/{max}</span>
}

function Footer({ busy, ready, label, onSubmit }: { busy: boolean; ready: boolean; label: string; onSubmit: () => void }) {
  return (
    <div className="flex items-center gap-2 bg-shell/55 px-5 py-3">
      <Action className="ml-auto" onClick={closeApexDialog}>
        Cancel
      </Action>
      <Action tone="solid" data-apex-submit disabled={!ready || busy} onClick={onSubmit} className="gap-2">
        {busy ? "Making it…" : label}
        <Keys keys={formatChord("mod+enter")} inverted />
      </Action>
    </div>
  )
}

/** ⌘↩ anywhere in the form makes it. */
function submitKeys(submit: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
}

/** Opens a conversation the host just started, once this window has heard of it. */
async function openWhenHeard(conversation: string): Promise<void> {
  for (let tries = 0; tries < 40; tries += 1) {
    if (acpStore.get().conversations[conversation]) {
      acp.open(conversation)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
}

/** A home folder itself is no project: an Apex there would let its Fins loose on everything the person keeps. */
const HOME = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)\/?$/

/** The Apex's folder: a chip, as the composer's, whose menu lists the projects you work in, newest first. */
function FolderPicker({ folders, folder, onChoose }: { folders: readonly { path: string; name: string }[]; folder: string; onChoose: (path: string) => void }) {
  const chosen = folders.find((each) => each.path === folder)
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          data-apex-field="folder"
          aria-label={`Folder: ${chosen?.name ?? "none"}`}
          className="pressable flex h-7 max-w-full min-w-0 items-center gap-1.5 self-start bg-fill-hover px-2 text-ui font-medium text-foreground/85 hover:bg-fill-selected data-[state=open]:bg-fill-selected"
        >
          <FileIcon path={chosen?.path ?? "folder"} folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{chosen?.name ?? "Choose a folder"}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-80 w-[22rem] overflow-y-auto">
        <MenuLabel>Its Fins work here, and stay here</MenuLabel>
        {folders.slice(0, 20).map((each) => (
          <MenuItem key={each.path} data-apex-folder={each.path} onSelect={() => onChoose(each.path)}>
            <FileIcon path={each.path} folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{each.name}</span>
              <span className="truncate text-label text-faint">{each.path.replace(/^\/Users\/[^/]+/, "~")}</span>
            </span>
            {each.path === folder ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </MenuItem>
        ))}
        {folders.length ? null : <p className="px-2 py-1.5 text-label text-faint">Open a project first: ⌘O.</p>}
      </MenuContent>
    </Menu>
  )
}

function NewApex({ folder: asked }: { folder?: string }) {
  useHarnessIdentity()
  const recent = useRecentProjects()
  // The project the window works in: a worktree's main checkout, never the worktree.
  const cwd = useSession((state) => state.meta?.cwd)
  const here = useWorktrees((state) => (cwd ? state.folderMap(cwd) ?? cwd : undefined))
  const composerHarness = useThreads((state) => state.composerHarness)
  const order = useHarnessOrder()
  // The project the window is in, never a Fin's worktree inside it.
  const project = here
  const folders = useMemo(() => {
    // Projects, never a Thread's own worktree of one: an Apex's folder is where its Fins' worktrees come from.
    const paths = [...new Set([asked, project, ...recent.map((each) => each.path)].filter((path): path is string => path !== undefined && path !== "" && !/\/\.mako\/worktrees\//.test(path) && !HOME.test(path)))]
    return paths.map((path) => ({ path, name: recent.find((each) => each.path === path)?.name ?? path.split("/").filter(Boolean).at(-1) ?? path }))
  }, [asked, project, recent])
  const [name, setName] = useState("")
  const [purpose, setPurpose] = useState("")
  const [folder, setFolder] = useState(asked ?? folders[0]?.path ?? "")
  const profiles = useProviders((state) => state.profiles)
  const signedIn = useMemo(() => order.filter((each) => profiles[each]?.available), [order, profiles])
  const [target, setTarget] = useState<FinTarget | undefined>(undefined)
  const harness = target?.harness ?? signedIn[0] ?? composerHarness ?? order[0] ?? "claude"
  const [run, setRun] = useState<"here" | "device">("here")
  const [device, setDevice] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  const ready = Boolean(name.trim() && folder && harness && (run === "here" || device.trim()))
  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    const created = await createApex({
      name: name.trim(),
      ...(purpose.trim() && { purpose: purpose.trim() }),
      cwd: folder,
      harness,
      ...(target?.settings?.model && { model: target.settings.model }),
      ...(target?.settings?.options && Object.keys(target.settings.options).length && { options: target.settings.options }),
      ...(run === "device" && { fins: { run: `device:${device.trim()}` } }),
      ...(message.trim() && { message: message.trim() }),
      clientKey: crypto.randomUUID(),
    })
    setBusy(false)
    if (!created) return
    closeApexDialog()
    void openWhenHeard(created.conversation)
  }
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={submitKeys(() => void submit())}>
      <Heading title="New Apex" />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
        <Field label="Name">
          <input ref={nameRef} data-apex-field="name" className={cn(FIELD, "h-9 text-title")} placeholder="Mobile" maxLength={APEX_NAME_CHARS} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="What it covers" aside={<Count value={purpose} max={APEX_PURPOSE_CHARS} />}>
          <input data-apex-field="purpose" className={FIELD} placeholder="The iOS and Android apps, TestFlight and crash fixes" maxLength={APEX_PURPOSE_CHARS} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Folder">
            <FolderPicker folders={folders} folder={folder} onChoose={setFolder} />
          </Field>
          <Field label="Runs on">
            <span data-apex-field="harness" className="flex">
              <TargetPicker
                target={target ?? { harness }}
                profiles={profiles}
                signedIn={signedIn.length ? signedIn : order}
                asUsed="The model you last used there"
                onChoose={(next) => setTarget(next)}
              />
            </span>
          </Field>
        </div>
        <Field label="Its Fins run">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Its Fins run" value={run} onChange={setRun} options={[{ value: "here", label: localWords("This Mac") }, { value: "device", label: "Another device" }]} />
            {run === "device" ? <input aria-label="Device name" data-apex-field="device" className={cn(FIELD, "h-7 w-44")} placeholder="Studio" value={device} onChange={(event) => setDevice(event.target.value)} /> : null}
          </div>
        </Field>
        <Field label="First message" aside={<span className="text-faint">optional</span>}>
          <textarea
            data-apex-field="message"
            rows={4}
            className={cn(FIELD, "h-auto min-h-24 resize-none py-2.5 leading-snug [field-sizing:content]")}
            placeholder="What it's for and what to start on. It writes this into its rules and plan. Leave it empty and it waits for you."
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
      </div>
      <Footer busy={busy} ready={ready} label="Make Apex" onSubmit={() => void submit()} />
    </div>
  )
}

function PromoteApex({ conversation, name: was }: { conversation: string; name: string }) {
  const [name, setName] = useState(was)
  const [purpose, setPurpose] = useState("")
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.select(), [])
  const ready = Boolean(name.trim())
  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    const made = await promoteToApex(conversation, { name: name.trim(), ...(purpose.trim() && { purpose: purpose.trim() }) })
    setBusy(false)
    if (made) closeApexDialog()
  }
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={submitKeys(() => void submit())}>
      <Heading title="Make this an Apex" line="It keeps its history, branch and Fins." />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <Field label="Name">
          <input ref={nameRef} data-apex-field="name" className={cn(FIELD, "h-9 text-title")} maxLength={APEX_NAME_CHARS} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="What it covers" aside={<Count value={purpose} max={APEX_PURPOSE_CHARS} />}>
          <input data-apex-field="purpose" className={FIELD} placeholder="Release trains, hotfixes and the changelog" maxLength={APEX_PURPOSE_CHARS} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
        </Field>
      </div>
      <Footer busy={busy} ready={ready} label="Make Apex" onSubmit={() => void submit()} />
    </div>
  )
}
