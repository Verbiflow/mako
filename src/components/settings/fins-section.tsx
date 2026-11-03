import { useEffect } from "react"
import { toast } from "sonner"
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react"
import type { ResolvedSetting, SessionSettings } from "@mako/sessions/settings"
import { finTuningLine, finTuningWords, resolveFinTuning, type FinTuningSource } from "@mako/host/contracts/fin-tuning"
import { ModelList, ModelOptionRows, ModelSummary, type ModelChoice } from "@/components/composer/agent-model-picker"
import { ListCard } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessProfile } from "@/lib/types"
import { harnessDefaults } from "@/state/composer-settings"
import { chooseFinDefault, loadFinDefaults, useFinDefaults } from "@/state/fin-defaults"
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
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">What Fins run on</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          When an Apex starts a Fin without naming a model. Same as you: on the Apex's own harness, the Apex's model and
          reasoning; on another, the model you last chose there. A model, reasoning or speed you name in chat, on any
          device, still wins.
        </p>
      </div>
      <ListCard className="px-1.5 py-1.5">
        <div role="list" aria-label="What each harness's Fins run on">
          {order.map((harness) => (
            <FinRow key={harness} harness={harness} profile={profiles[harness]} />
          ))}
        </div>
      </ListCard>
      {failed ? <p className="text-label text-caution">This Mac's choices for Fins couldn't be read. Reopen Settings to try again.</p> : null}
    </section>
  )
}

/** Where "Same as you" lands when the Apex is on another harness, in a row's words. */
const SOURCE_WORDS = {
  asked: () => "as asked",
  fins: () => "your choice for Fins",
  apex: () => "your Apex's",
  used: () => "your last here",
  mako: () => "Mako's recommendation",
  harness: (harness) => `${harnessLabel(harness)}'s own default`,
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
    <div role="listitem" className={cn("flex items-center gap-3 rounded-md px-2.5 py-2.5", !signedIn && !pending && "text-muted-foreground")}>
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-raised [box-shadow:inset_0_0_0_0.5px_var(--hairline)]", !signedIn && !pending && "opacity-50")}>
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
            "pressable flex h-7 max-w-[17rem] min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-hover data-[state=open]:bg-fill-selected"
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
