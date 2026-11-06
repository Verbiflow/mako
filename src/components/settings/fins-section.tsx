import { useEffect, type ReactNode } from "react"
import { targetLine } from "./agent-reads"
import { FinRules } from "./fin-rules"
import { FinMoveOnLimit } from "./fin-move-on-limit"
import { RoleRules } from "./role-rules"
import { toast } from "sonner"
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon, ZapIcon } from "lucide-react"
import type { ResolvedSetting, SessionSettings } from "@mako/sessions/settings"
import { cloudWords, FIN_CEILING, FIN_CEILING_MAX, FIN_LIMIT, FIN_LIMIT_MAX, finTuningLine, finTuningWords, resolveFinTuning, type FinTuningSource } from "@mako/host/contracts/fin-tuning"
import { ModelList, ModelOptionRows, ModelSummary, type ModelChoice } from "@/components/composer/agent-model-picker"
import { IconAction, Segmented } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessProfile } from "@/lib/types"
import { harnessDefaults } from "@/state/composer-settings"
import { chooseFinDefault, loadFinDefaults, setFinCeiling, setFinLimit, useFinDefaults } from "@/state/fin-defaults"
import { useHarnessOrder } from "@/state/harness-order"
import { providers, useProviders } from "@/state/providers"

/**
 * Settings › Fins: what each harness's Fins start on when their Apex names no
 * model. "Same as you" by default, which the host reads as the person's own
 * use; or a model of its own, with its reasoning and speed, from the harness's
 * catalog through the composer's own picker.
 */
export function FinsSection() {
  useHarnessIdentity()
  useEffect(() => {
    void providers.loadAll()
    void loadFinDefaults()
  }, [])
  const order = useHarnessOrder()
  const profiles = useProviders((state) => state.profiles)
  const failed = useFinDefaults((state) => state.failed)
  return (
    <div className="flex flex-col gap-8">
      <FinLimit />
      <FinRules order={order} profiles={profiles} />
      <RoleRules target={(target) => targetLine(target, profiles)} />
      <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">What Fins run on, per harness</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          Once a harness is picked, the model it runs on when your rule or your words name none. Same as you: on the
          Apex's own harness, the Apex's model and reasoning; on another, the model you last chose there.
        </p>
      </div>
      <div>
        <div role="list" aria-label="What each harness's Fins run on" className="flex flex-col gap-px">
          {order.map((harness) => (
            <FinRow key={harness} harness={harness} profile={profiles[harness]} />
          ))}
        </div>
      </div>
      {failed ? <p className="text-label text-caution">This Mac's choices for Fins couldn't be read. Reopen Settings to try again.</p> : null}
      </section>
      <FinMoveOnLimit />
    </div>
  )
}

/**
 * How many Fins run at once, one line per place: this Mac's capacity, from its hardware and what a Fin costs here,
 * or the person's own number; the cloud's, by their plan; and their ceiling across every place.
 */
function FinLimit() {
  const reading = useFinDefaults((state) => state.reading)
  if (!reading) return null
  const capacity = reading.capacity
  const own = reading.limit
  const atOnce = own ?? capacity?.atOnce ?? FIN_LIMIT
  const ceiling = reading.ceiling ?? FIN_CEILING
  const fail = (error: Error) => toast.error(error.message || "That number couldn't be saved. Try again.")
  const saveLimit = (next: number | null) => void setFinLimit(next).catch(fail)
  const saveCeiling = (next: number) => void setFinCeiling(next).catch(fail)
  const based = capacity ? [capacity.pressure ?? capacity.why, ...capacity.measured ? [] : ["defaults so far"]].join(" · ") : undefined
  // Another place's operations this Mac runs take Fins' places from the same number.
  const lending = capacity?.lent?.length ? `${capacity.lent.length} lent: ${capacity.lent.join(", ")}` : undefined
  const detail = [own !== undefined ? `Your number${capacity ? ` · Auto would be ${capacity.auto}` : ""}` : based ?? "Its capacity", lending].filter(Boolean).join(" · ")
  return (
    <section className="flex flex-col gap-3" aria-label="Fins at once">
      <div>
        <h3 className="text-ui font-medium">Fins at once</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          How many of your Fins run at the same time in each place, across every Apex. Past it, an Apex waits for one to
          end only when it asks to.
        </p>
      </div>
      <div role="list" className="flex flex-col gap-px">
        <PlaceRow
          place="This Mac"
          detail={detail}
          caution={Boolean(capacity?.pressure) && own === undefined}
        >
          <Segmented
            label="How this Mac's number is set"
            value={own === undefined ? "auto" : "fixed"}
            options={[{ value: "auto", label: "Auto" }, { value: "fixed", label: "Fixed" }]}
            onChange={(next) => saveLimit(next === "auto" ? null : atOnce)}
          />
          {own === undefined ? <span className="tabular w-[5.5rem] text-right text-ui font-medium">{atOnce}</span> : <Stepper label="This Mac's Fins at once" value={own} most={FIN_LIMIT_MAX} onChange={saveLimit} />}
        </PlaceRow>
        {reading.cloud ? (
          <PlaceRow place="Cloud" detail="A machine per Fin, so your plan and daily spend ceiling set it">
            <span className="text-ui font-medium">{cloudWords(reading.cloud)}</span>
          </PlaceRow>
        ) : null}
        <PlaceRow place="Across every place" detail="A safety net over each place's own number">
          <Stepper label="Fins at once across every place" value={ceiling} most={FIN_CEILING_MAX} onChange={saveCeiling} />
        </PlaceRow>
      </div>
    </section>
  )
}

function PlaceRow({ place, detail, caution, children }: { place: string; detail: string; caution?: boolean; children: ReactNode }) {
  return (
    <div role="listitem" className="flex items-center gap-3 bg-shell/55 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium">{place}</p>
        <p className={cn("truncate text-label", caution ? "text-caution" : "text-faint")}>{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  )
}

function Stepper({ label, value, most, onChange }: { label: string; value: number; most: number; onChange: (next: number) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-1">
      <IconAction label="One fewer" disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <MinusIcon />
      </IconAction>
      <output aria-live="polite" className="tabular w-7 text-center text-ui font-medium">{value}</output>
      <IconAction label="One more" disabled={value >= most} onClick={() => onChange(value + 1)}>
        <PlusIcon />
      </IconAction>
    </div>
  )
}

/** Where "Same as you" lands when the Apex is on another harness, in a row's words. */
const SOURCE_WORDS = {
  asked: () => "as asked",
  rule: () => "your rule",
  fins: () => "your choice for Fins",
  apex: () => "your Apex's",
  used: () => "your last here",
  mako: () => "Mako's recommendation",
  harness: (harness) => `${harnessLabel(harness)}'s own default`,
  connection: () => "a connection's model",
} satisfies Record<FinTuningSource, (harness: string) => string>

function FinRow({ harness, profile }: { harness: string; profile: HarnessProfile | undefined }) {
  const chosen = useFinDefaults((state) => state.reading?.chosen[harness])
  const used = useFinDefaults((state) => state.reading?.used[harness])
  const signedIn = Boolean(profile?.available)
  const pending = !profile || Boolean(profile.pending && !profile.available)
  const models = profile?.models ?? []
  const away = resolveFinTuning({ label: harnessLabel(harness), models, asked: {}, ...(used && { used }), ...(profile?.settings && { recommended: profile.settings }) })
  const elsewhere = "refused" in away ? undefined : away
  const words = elsewhere?.settings ? finTuningWords(models, elsewhere.settings) : undefined
  const gone = chosen?.model && models.length && !finTuningWords(models, chosen) ? chosen.model : undefined
  return (
    <div role="listitem" className={cn("flex items-center gap-3 bg-raised px-3 py-2.5", !signedIn && !pending && "text-muted-foreground")}>
      <span className={cn("flex size-7 shrink-0 items-center justify-center bg-fill-hover", !signedIn && !pending && "opacity-50")}>
        <HarnessIcon harness={harness} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium">{harnessLabel(harness)}</p>
        <p className={cn("truncate text-label", gone ? "text-caution" : "text-faint")}>
          {pending
            ? "Asking for its models…"
            : !signedIn
              ? "Not signed in"
              : gone
                ? `${gone} isn't listed by ${harnessLabel(harness)} anymore, so its Fins run as you do`
                : chosen
                  ? "Every Fin here starts on this, whatever its Apex runs on"
                  : `Your Apex's model, or ${words && elsewhere ? `${finTuningLine(words)} (${SOURCE_WORDS[elsewhere.source](harness)})` : `${harnessLabel(harness)}'s own default`}`}
        </p>
      </div>
      {signedIn && profile ? <FinPicker harness={harness} profile={profile} chosen={chosen} /> : null}
    </div>
  )
}

function FinPicker({ harness, profile, chosen }: { harness: string; profile: HarnessProfile; chosen: SessionSettings | undefined }) {
  const save = (settings: SessionSettings | null) =>
    void chooseFinDefault(harness, settings).catch((error: Error) => toast.error(error.message || "That choice couldn't be saved. Try again."))
  const { resolved, model, options } = harnessDefaults(harness, profile, chosen ? { source: "saved", settings: chosen } : undefined)
  const choice: ModelChoice = {
    harness,
    models: profile.models,
    model,
    options,
    resolved,
    chooseOption: (id, value) => save({ ...resolved.settings, options: { ...resolved.settings.options, [id]: value } }),
    replaceModel: () => save(null),
    source: (setting: ResolvedSetting) => (setting.kind !== "known" ? "The harness has not said" : setting.source === "saved" ? "Your choice for Fins" : "The model's default"),
  }
  const chooseModel = (id: string) => {
    const next = profile.models.find((entry) => entry.id === id)
    // Speed carries to a model with the same lane; reasoning levels are each model's own.
    const carried = Object.fromEntries(
      Object.entries(chosen?.options ?? {}).filter(([option]) => next?.options.some((entry) => entry.id === option && entry.role === "speed"))
    )
    save({ model: id, options: carried })
  }
  const label = chosen ? (model?.label ?? chosen.model ?? "Its own default") : "Same as you"
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${harnessLabel(harness)}'s Fins run on ${label}`}
          className={cn(
            "pressable flex h-7 max-w-[17rem] min-w-0 shrink-0 items-center gap-1.5 bg-fill-hover px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-selected data-[state=open]:bg-fill-selected"
          )}
        >
          {chosen ? (
            <>
              <span aria-label="Your choice" className="size-1.5 shrink-0 rounded-full bg-foreground/60" />
              <ModelSummary choice={choice} label={label} />
            </>
          ) : (
            <span className="truncate text-muted-foreground">Same as you</span>
          )}
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-[21rem]">
        <MenuItem onSelect={() => save(null)}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">Same as you</span>
            <span className="truncate text-label text-faint">Your Apex's model, or the one you last used here</span>
          </span>
          {chosen ? null : <CheckIcon className="size-3.5 shrink-0" />}
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>A model of its own</MenuLabel>
        <ModelList harness={harness} profile={profile} selected={chosen ? model?.id : undefined} onChoose={chooseModel} />
        {chosen ? <ModelOptionRows choice={choice} /> : null}
        {chosen && resolved.issues.length ? (
          <p className="flex items-start gap-2 px-2 py-1.5 text-label text-caution">
            <AlertCircleIcon className="mt-px size-3 shrink-0" />
            Until it's fixed, Fins here run as you do.
          </p>
        ) : null}
        {chosen ? null : (
          <p className="flex items-center gap-1.5 px-2 py-1.5 text-label text-faint">
            <ZapIcon className="size-3 shrink-0" />
            Fast lanes cost more: a Fin takes one only as you do, or when you ask.
          </p>
        )}
      </MenuContent>
    </Menu>
  )
}
