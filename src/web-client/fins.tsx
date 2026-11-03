import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { errorMessage } from "@mako/host/contracts/error-message"
import { finTuningLine, finTuningWords, resolveFinTuning, type FinChoicesReading } from "@mako/host/contracts/fin-tuning"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import { modelByIdentity, optionDefault, settingsWithVariant, type ModelOption, type SessionSettings, type SettingValue } from "@mako/sessions/settings"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { WebHarnessIcon } from "./harness-icon"
import { WEB_HARNESSES, webHarnessLabel } from "./labels"
import { places, startable, type Place } from "./places"
import { Group, Row, Switch } from "./settings-rows"
import { Sheet, SheetScroll } from "./sheet"
import { macCall } from "./start"

type Mac = Extract<Place, { kind: "mac" }>

/**
 * Settings › Fins on the phone and the web: what each harness's Fins start on when their Apex names no model, as the
 * person's Mac they worked on last keeps it (`mako:fin-defaults`), with that Mac's own catalogs. The desk's Settings ›
 * Fins, in the touch layout.
 */
export function Fins() {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const mac = places(list, false).find((place): place is Mac => place.kind === "mac" && startable(place))
  const deviceId = mac?.deviceId
  const call = useMemo(
    () => (deviceId ? <Result,>(channel: string, args: readonly unknown[]) => macCall<Result>(client.gateway, client.deviceId, deviceId, channel, args) : undefined),
    [client, deviceId]
  )
  if (!mac || !call)
    return (
      <Group title="Fins" footer="Turn on a Mac of yours to choose what its Fins run on.">
        <Row label="What Fins run on" detail="Same as you, until a Mac is on" />
      </Group>
    )
  return <FinsGroup mac={mac.name} call={call} />
}

/** A call to the Mac whose Fins these are, as `macCall` makes one. */
export type MacCall = <Result>(channel: string, args: readonly unknown[]) => Promise<Result>

/** Each harness's Fins on one Mac: its choices and catalogs read from it, and each change written to it. */
export function FinsGroup({ mac, call, opened }: { mac: string; call: MacCall; opened?: string }) {
  const [reading, setReading] = useState<FinChoicesReading | undefined>(undefined)
  const [profiles, setProfiles] = useState<Record<string, HarnessProfile>>({})
  const [open, setOpen] = useState<string | undefined>(opened)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    call<FinChoicesReading>("mako:fin-defaults", []).then(
      (found) => current && setReading(found),
      (error) => current && setFailure(errorMessage({ error }))
    )
    for (const harness of WEB_HARNESSES)
      void call<HarnessProfile>("mako:harness-tuning", [harness, undefined, false]).then(
        (profile) => current && setProfiles((held) => ({ ...held, [harness]: profile })),
        () => undefined
      )
    return () => {
      current = false
    }
  }, [call])

  const choose = (harness: string, settings: SessionSettings | null) => {
    const before = reading
    if (before) {
      const chosen = { ...before.chosen }
      if (settings) chosen[harness] = settings
      else delete chosen[harness]
      setReading({ ...before, chosen })
    }
    call<FinChoicesReading>("mako:fin-default-choose", [harness, settings]).then(setReading, (error) => {
      setReading(before)
      toast.error(errorMessage({ error }))
    })
  }

  const signedIn = WEB_HARNESSES.filter((harness) => profiles[harness]?.available)
  return (
    <Group
      title="Fins"
      footer={failure ?? `What a Fin starts on when its Apex names no model, on ${mac}. Same as you: the Apex's model on its own harness, else the one you last used there. A model you name in chat still wins.`}
    >
      {signedIn.length === 0 ? <Row label="Asking your Mac…" /> : null}
      {signedIn.map((harness) => {
        const profile = profiles[harness]!
        const chosen = reading?.chosen[harness]
        const words = chosen ? finTuningWords(profile.models, chosen) : undefined
        return (
          <button key={harness} type="button" onClick={() => setOpen(harness)} className="web-row flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left">
            <WebHarnessIcon harness={harness} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui">{webHarnessLabel(harness)}</span>
              <span className={cn("block truncate text-label", chosen && !words ? "text-caution" : "text-faint")}>
                {chosen ? (words ? finTuningLine(words) : `${chosen.model} isn't listed anymore: same as you`) : "Same as you"}
              </span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-faint" />
          </button>
        )
      })}
      {open && profiles[open] ? (
        <FinSheet
          harness={open}
          profile={profiles[open]}
          chosen={reading?.chosen[open]}
          used={reading?.used[open]}
          onDismiss={() => setOpen(undefined)}
          onChoose={(settings) => choose(open, settings)}
        />
      ) : null}
    </Group>
  )
}

function FinSheet({ harness, profile, chosen, used, onDismiss, onChoose }: {
  harness: string
  profile: HarnessProfile
  chosen: SessionSettings | undefined
  used: SessionSettings | undefined
  onDismiss: () => void
  onChoose: (settings: SessionSettings | null) => void
}) {
  const label = webHarnessLabel(harness)
  const models = profile.models.filter((model) => !model.unavailable)
  const expanded = chosen ? settingsWithVariant(profile.models, chosen) : undefined
  const model = modelByIdentity(profile.models, expanded?.model)
  const elsewhere = resolveFinTuning({ label, models: profile.models, asked: {}, ...(used && { used }), ...(profile.settings && { recommended: profile.settings }) })
  const mine = !("refused" in elsewhere) && elsewhere.settings ? finTuningWords(profile.models, elsewhere.settings) : undefined
  const value = (option: ModelOption) => expanded?.options?.[option.id] ?? optionDefault(option)
  const set = (option: ModelOption, next: SettingValue) => model && onChoose({ model: model.id, options: { ...expanded?.options, [option.id]: next } })
  const reasoning = model?.options.find((option) => option.role === "reasoning" && !option.disabledReason && option.kind === "select")
  const speed = model?.options.find((option) => option.role === "speed" && !option.disabledReason)
  const fastValue = (on: boolean): SettingValue | undefined => !speed ? undefined : speed.kind === "boolean" ? on : speed.booleanValues ? (on ? speed.booleanValues.on : speed.booleanValues.off) : undefined
  const fast = speed !== undefined && value(speed) === fastValue(true)
  return (
    <Sheet open onDismiss={onDismiss} label={`${label}'s Fins`} tall>
      <h3 className="web-sheet-title">{label}'s Fins</h3>
      <SheetScroll className="flex flex-col gap-3 px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <button type="button" aria-pressed={!chosen} onClick={() => onChoose(null)} className="web-choice">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">Same as you</span>
            <span className="truncate text-label text-faint">Your Apex's model, or {mine ? finTuningLine(mine) : `${label}'s own default`}</span>
          </span>
          <CheckIcon aria-hidden className={cn("size-4 shrink-0", chosen && "invisible")} />
        </button>
        {model && reasoning?.kind === "select" ? (
          <div className="flex flex-col gap-1.5 px-2">
            <p className="text-label font-medium text-faint">Reasoning</p>
            <div role="radiogroup" aria-label="Reasoning" className="web-scroll flex gap-1.5 overflow-x-auto">
              {reasoning.values.map((choice) => (
                <button key={choice.value} type="button" role="radio" aria-checked={value(reasoning) === choice.value} onClick={() => set(reasoning, choice.value)} className="web-chip web-chip-tab shrink-0">
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {model && speed && fastValue(true) !== undefined ? (
          <div className="flex items-center gap-3 px-2">
            <span className="min-w-0 flex-1">
              <span className="block text-ui">Fast</span>
              <span className="block text-label text-faint">Quicker, and costs more</span>
            </span>
            <Switch on={fast} label="Fast" onChange={(on) => set(speed, fastValue(on)!)} />
          </div>
        ) : null}
        <div className="flex flex-col">
          <p className="px-2 pb-1 text-label font-medium text-faint">A model of its own</p>
          {models.map((each) => (
            <button key={each.id} type="button" aria-pressed={model?.id === each.id} onClick={() => onChoose({ model: each.id })} className="web-choice">
              <span className="min-w-0 flex-1 truncate">{each.label}</span>
              <CheckIcon aria-hidden className={cn("size-4 shrink-0", model?.id !== each.id && "invisible")} />
            </button>
          ))}
        </div>
      </SheetScroll>
    </Sheet>
  )
}
