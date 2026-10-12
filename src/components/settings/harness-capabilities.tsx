import { CheckIcon, CircleDashedIcon, MinusIcon } from "lucide-react"
import { Disclosure } from "@/components/ui/notice"
import { descriptorFor } from "@/state/descriptors"
import { useThreads } from "@/state/threads"
import { capabilityGroups } from "@/lib/harness-capabilities"
import type { HarnessDescriptor } from "@/lib/types"
import { cn } from "@/lib/utils"

const MARKS = {
  works: { Icon: CheckIcon, label: "Works in Mako", className: "text-foreground/80" },
  own: { Icon: CheckIcon, label: "Handled by the agent", className: "text-faint" },
  lacks: { Icon: MinusIcon, label: "The agent has none", className: "text-faint" },
  gap: { Icon: CircleDashedIcon, label: "Not in Mako yet", className: "text-caution/90" },
} as const

/** The declarations, always open; `HarnessCapabilities` puts them behind a disclosure. `all` is every harness Mako knows, which decides what only this one has. */
export function HarnessCapabilityList({ descriptor, all }: { descriptor: HarnessDescriptor; all: readonly HarnessDescriptor[] }) {
  return (
    <div className="space-y-4">
      {capabilityGroups(descriptor, all).map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h4 className="pb-1.5 text-label font-medium text-muted-foreground">{group.title}</h4>
          <ul className="space-y-1.5">
            {group.rows.map((item) => {
              const mark = MARKS[item.standing]
              return (
                <li key={item.key} data-capability={item.key} data-standing={item.standing} title={item.detail} className="flex gap-2">
                  <mark.Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", mark.className)} />
                  <span className="min-w-0 text-label leading-relaxed">
                    <span className="text-foreground/90">{item.label}</span>
                    <span className="sr-only">: {mark.label}.</span>{" "}
                    {item.standing === "gap" ? <span className="text-caution/90">Not in Mako yet. </span> : null}
                    <span className="text-faint">{item.text}</span>
                    {item.native ? (
                      <span className="block text-faint" title={item.native.where}>
                        In {descriptor.displayName}: <span className="text-muted-foreground">{item.native.name}</span>
                      </span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** What a harness can do in Mako, with the reason for each thing it can't, as its declarations say. */
export function HarnessCapabilities({ harness }: { harness: string }) {
  const all = useThreads((state) => state.descriptors)
  const descriptor = descriptorFor({ descriptors: all }, harness)
  if (!descriptor) return null
  const groups = capabilityGroups(descriptor, all)
  const rows = groups.filter((group) => !group.only).flatMap((group) => group.rows)
  const working = rows.filter((item) => item.standing === "works" || item.standing === "own").length
  const own = groups.find((group) => group.only)?.rows.length ?? 0
  return (
    <Disclosure
      summary={`What works in Mako · ${working} of ${rows.length} shared${own ? ` · ${own} only in ${descriptor.displayName}` : ""}`}
      bodyClassName="pt-3"
    >
      <HarnessCapabilityList descriptor={descriptor} all={all} />
    </Disclosure>
  )
}
