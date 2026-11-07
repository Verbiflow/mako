import type { ComponentProps } from "react"
import { CloudIcon, LaptopIcon, ServerIcon, type LucideIcon } from "lucide-react"
import type { RunPlace } from "@mako/host/contracts/account-devices"
import { cn } from "@/lib/utils"

/**
 * Where a Thread or a Fin runs when it isn't here, in one glyph wherever that's said (a rail row, a Thread's or a
 * Fin's header, a phone's list): a cloud machine, a machine of the person's own (Mako's host with no window, the
 * `runtime` kind), or another of their computers. One glyph each, so a server always means their own machine. Which
 * place a row names is `runPlace`'s to say.
 */
const PLACE_ICONS = { cloud: CloudIcon, machine: ServerIcon, device: LaptopIcon } satisfies Record<RunPlace, LucideIcon>

export function PlaceMark({ place, className, ...props }: { place: RunPlace } & ComponentProps<LucideIcon>) {
  const Icon = PLACE_ICONS[place]
  return <Icon aria-hidden data-place={place} className={cn("size-3 shrink-0", className)} {...props} />
}
