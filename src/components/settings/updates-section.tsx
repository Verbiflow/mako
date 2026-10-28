import { useEffect } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"
import type { RevisionChanges, UpdateInstallation } from "@mako/host/contracts/app-lifecycle"
import { shortRevision, updateSourceText, type UpdateSourceText } from "@mako/host/contracts/update-source-text"
import { Action, Chip } from "@/components/ui/kit"
import { IfCanChooseFolder } from "@/components/ui/machine-gate"
import { MakoTile } from "@/components/ui/mako-mark"
import { Spinner } from "@/components/ui/spinner"
import { updates, useUpdates } from "@/state/updates"
import { application, useApplication } from "@/state/application"
import { runCommand } from "@/extend/commands"
import { cn } from "@/lib/utils"

const phases = [
  "copying",
  "compiling",
  "checking",
  "packaging",
  "verifying",
] as const
const phaseLabels = ["Prepare", "Build", "Check", "Package", "Verify"]

/** The commit subjects a change count stands for, newest first, and how many more there are. */
function ChangeList({ changes, label }: { changes: RevisionChanges; label: string }) {
  if (!changes.count) return null
  const more = changes.count - changes.titles.length
  return (
    <ul aria-label={label} className="flex flex-col gap-1 text-label leading-relaxed text-muted-foreground" data-testid="update-changes">
      {changes.titles.map((title, index) => (
        <li key={`${index}-${title}`} className="truncate" title={title}>
          {title}
        </li>
      ))}
      {more > 0 && <li className="text-faint">and {more} more</li>}
    </ul>
  )
}

/** The card's headline and the sentence under it. */
interface CardCopy {
  title: string
  detail: string
}

/**
 * What the card says for a locally signed install: the build under way, the
 * build ready, or what Build would take from the checkout right now.
 */
function localCopy(installation: UpdateInstallation, text: UpdateSourceText | null): CardCopy {
  const { local, checkout } = installation
  if (local.kind === "ready") return { title: "Your update is ready", detail: "Verified and ready. Install after agents finish, or choose when to stop them." }
  if (local.kind === "building") {
    const forward = checkout?.kind === "checkout" && checkout.plan.kind === "fast-forward" && checkout.branch
    return {
      title: local.revision ? `Building ${shortRevision(local.revision)}` : forward ? `Bringing ${checkout.branch} up to ${shortRevision(checkout.target)}` : "Preparing your next build",
      detail: "Building separately. Your installed app and agents stay running.",
    }
  }
  if (checkout?.kind === "unreadable") return { title: "Mako can't read the checkout", detail: checkout.reason }
  if (text) return text
  if (installation.source && installation.reading) return { title: "Checking your checkout", detail: "Fetching what's new and comparing it with your app." }
  return { title: "Update from your checkout", detail: "Build and verify a new app without leaving Mako." }
}

/** Which version is running, and whether there is a newer one. */
export function UpdatesSection() {
  const release = useUpdates((state) => state)
  const installation = useApplication((state) => state.installation)
  const lifecycle = useApplication((state) => state.lifecycle)
  const error = useApplication((state) => state.error)
  const busy = useApplication((state) => state.busy)
  const local = installation?.distribution === "local"
  const source = installation?.source ?? null
  // Opening Updates asks what's available; a fetch within the last minute answers.
  useEffect(() => {
    if (local && source) void application.checkSource()
  }, [local, source])
  const checkout = installation?.checkout ?? null
  const text = checkout?.kind === "checkout" ? updateSourceText(checkout) : null
  const reading = installation?.reading ?? false
  const published = installation?.distribution === "signed"
  const building = installation?.local.kind === "building"
  const ready =
    installation?.local.kind === "ready" || release.status === "ready"
  const pending =
    lifecycle?.operation.kind === "waiting" ||
    lifecycle?.operation.kind === "applying" ||
    lifecycle?.operation.kind === "stopping"
  const phase =
    installation?.local.kind === "building"
      ? phases.indexOf(installation.local.phase)
      : -1
  const build = installation?.build
  const nextBuild =
    installation?.local.kind === "ready" ? installation.local.build : null
  const failed =
    installation?.local.kind === "error"
      ? installation.local.message
      : error || release.error
  const copy = local && installation ? localCopy(installation, text) : null
  const prepared = installation?.local.kind === "ready" ? installation.local : null
  // What Build would bring, listed before it runs; nothing while it builds or once it's ready.
  const coming = !building && !prepared && checkout?.kind === "checkout" && text?.action ? checkout.changes : null
  const buildLabel = building ? "Building…" : ready ? "Build again" : text?.action ?? "Build update"
  const nothingToBuild = Boolean(text && !text.action) || checkout?.kind === "unreadable"
  const label = local
    ? "Local installation"
    : published
      ? "Release installation"
      : installation?.distribution === "development"
        ? "Development checkout"
        : "Unsigned installation"

  return (
    <div className="flex flex-col gap-6" data-testid="updates-section">
      <div className="flex items-start gap-4">
        <MakoTile className="size-14" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-title font-medium">Mako {release.version}</h3>
            <Chip>{installation ? label : "Reading installation"}</Chip>
          </div>
          <p className="mt-1.5 text-ui text-muted-foreground">
            {build
              ? `Built ${new Date(build.builtAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
              : "This build did not record a build date."}
          </p>
          {build && (
            <p
              className="mt-1 text-label text-faint"
              title={`Source revision: ${build.revision ?? "unavailable"}`}
              data-testid="installed-revision"
            >
              {build.revision ? (
                <>
                  Revision <span className="font-mono text-muted-foreground">{shortRevision(build.revision)}</span>
                  {build.dirty ? " with local changes" : ""} ·{" "}
                </>
              ) : null}
              Build <span className="font-mono">{build.id}</span>
            </p>
          )}
          {installation?.installed && installation.installed.count > 0 && (
            <div className="mt-3 flex flex-col gap-1.5" data-testid="installed-changes">
              <p className="text-label text-faint">
                {installation.installed.from ? (
                  <>
                    Updated from <span className="font-mono">{shortRevision(installation.installed.from)}</span> ·{" "}
                  </>
                ) : null}
                {installation.installed.count} {installation.installed.count === 1 ? "change" : "changes"} in this build
              </p>
              <ChangeList changes={installation.installed} label="Changes in this build" />
            </div>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h4 className="text-ui font-medium" data-testid="update-title">
              {copy
                ? copy.title
                : ready
                  ? "Your update is ready"
                  : published
                    ? "Keep Mako up to date"
                    : "Updates for this installation"}
            </h4>
            <p className="mt-1 text-ui leading-relaxed text-muted-foreground" data-testid="update-detail">
              {copy
                ? copy.detail
                : ready
                  ? "Verified and ready. Install after agents finish, or choose when to stop them."
                  : published
                    ? "Updates download in the background. You decide when they install."
                    : "This installation does not use the public update feed."}
            </p>
            {local && text?.offline && !building && (
              <p className="mt-1.5 text-label leading-relaxed text-faint" data-testid="update-offline">
                {text.offline}
              </p>
            )}
          </div>
          {ready && (
            <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          )}
        </div>

        {local && (
          <div className="mx-4 mb-4 rounded-lg border border-hairline bg-background/40">
            <div className="flex items-center gap-3 p-3">
              <FolderIcon className="size-4 shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-label text-faint">Source checkout</p>
                <p
                  className="mt-0.5 truncate text-ui"
                  title={installation.source ?? undefined}
                >
                  {installation.source || "Choose your Mako source folder"}
                </p>
                {installation.source && (text || reading) && (
                  <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-label text-faint" data-testid="update-standing">
                    {reading && <Spinner aria-label="Checking" className="size-3 shrink-0" />}
                    {text?.standing ?? "Checking…"}
                  </p>
                )}
              </div>
              <IfCanChooseFolder>
                <Action
                  tone="outline"
                  disabled={busy || building || pending}
                  onClick={() => void application.selectSource()}
                >
                  {installation.source ? "Change…" : "Choose…"}
                </Action>
              </IfCanChooseFolder>
            </div>
            <p className="border-t border-hairline px-3 py-2 text-label leading-relaxed text-faint">
              Only choose a checkout you trust. Building runs its scripts in a
              private copy, including your local changes. Mako moves the
              checkout forward only when it has none, and never switches
              branches.
            </p>
          </div>
        )}
        {coming && coming.count > 0 && (
          <div className="mx-4 mb-4">
            <ChangeList changes={coming} label="Changes Build brings" />
          </div>
        )}

        {building && (
          <ol
            className="grid grid-cols-5 gap-2 px-4 pb-5"
            aria-label="Build progress"
          >
            {phaseLabels.map((name, index) => (
              <li
                key={name}
                aria-current={index === phase ? "step" : undefined}
                className={cn(
                  "flex flex-col gap-2 text-label",
                  index > phase ? "text-faint" : "text-foreground"
                )}
              >
                <div
                  className={cn(
                    "h-0.5 rounded-full",
                    index <= phase ? "bg-foreground/65" : "bg-fill-hover"
                  )}
                />
                <span className="flex items-center gap-1">
                  {index < phase && <CheckIcon className="size-3" />}
                  {name}
                </span>
              </li>
            ))}
          </ol>
        )}
        {nextBuild && (
          <div className="mx-4 mb-4 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-raised px-3 py-2 text-label" data-testid="update-transition">
              <span className="font-mono text-faint">
                {build?.revision ? shortRevision(build.revision) : `Build ${build?.id.slice(0, 8) ?? "unknown"}`}
              </span>
              <ChevronRightIcon className="size-3 text-faint" />
              <span className="font-mono font-medium">
                {nextBuild.revision ? shortRevision(nextBuild.revision) : nextBuild.id.slice(0, 8)}
                {nextBuild.dirty ? " with local changes" : ""}
              </span>
              {prepared?.changes && prepared.changes.count > 0 && (
                <span className="text-faint">
                  · {prepared.changes.count} {prepared.changes.count === 1 ? "change" : "changes"}
                </span>
              )}
              <span className="ml-auto text-faint">Signature verified</span>
            </div>
            {prepared?.forwarded && (
              <p className="text-label text-faint">
                Moved {prepared.forwarded.branch} forward from{" "}
                <span className="font-mono">{shortRevision(prepared.forwarded.from)}</span> to{" "}
                <span className="font-mono">{shortRevision(prepared.forwarded.to)}</span>.
              </p>
            )}
            {prepared?.changes && <ChangeList changes={prepared.changes} label="Changes in this update" />}
          </div>
        )}
        {published && release.status === "downloading" && (
          <div className="px-4 pb-4">
            <progress
              className="update-progress h-1.5 w-full"
              max={100}
              value={release.progress ?? 0}
              aria-label="Downloading update"
            />
            <p className="mt-2 text-label text-faint">
              Downloading {release.available} · {release.progress ?? 0}%
            </p>
          </div>
        )}
        {failed && (
          <p
            role="alert"
            className="mx-4 mb-4 rounded-lg bg-negative/10 p-3 text-ui leading-relaxed text-negative"
          >
            {failed}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-3">
          {ready && (
            <Action
              tone="solid"
              size="md"
              disabled={busy || pending}
              onClick={() => void application.request("install")}
            >
              <DownloadIcon />
              {lifecycle?.work.length
                ? "Install when agents finish"
                : "Install update"}
            </Action>
          )}
          {local && (building || ready || !nothingToBuild) && (
            <Action
              tone={ready ? "outline" : "solid"}
              size="md"
              disabled={!installation.source || busy || building || pending}
              onClick={() => void application.build()}
            >
              <RefreshCwIcon />
              {buildLabel}
            </Action>
          )}
          {local && installation.source && !building && !ready && (
            <Action
              tone="outline"
              size="md"
              disabled={reading || pending}
              onClick={() => void application.checkSource(true)}
            >
              {reading ? "Checking…" : "Check again"}
            </Action>
          )}

          {published && (
            <Action
              tone={ready ? "outline" : "solid"}
              size="md"
              disabled={
                release.status === "checking" ||
                release.status === "downloading" ||
                pending
              }
              onClick={() => void updates.check()}
            >
              <RefreshCwIcon />
              {release.status === "checking"
                ? "Checking…"
                : "Check for updates"}
            </Action>
          )}
          {installation?.distribution === "development" && (
            <Action
              tone="outline"
              size="md"
              onClick={() => runCommand("app.reload-interface")}
            >
              <RefreshCwIcon />
              Reload interface
            </Action>
          )}
          {published && release.status === "current" && (
            <span className="text-label text-faint">You're up to date.</span>
          )}
        </div>
      </div>
      {release.notes && (
        <div>
          <h4 className="text-ui font-medium">What's new</h4>
          <pre className="mt-2 max-h-40 overflow-auto font-sans text-ui leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {release.notes}
          </pre>
        </div>
      )}
      <div className="flex items-start gap-2 text-label leading-relaxed text-faint">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
        <p>
          Preparing an update never stops agents. Installing replaces the host
          after active work finishes. You can cancel a waiting update at any
          time.
        </p>
      </div>
    </div>
  )
}
