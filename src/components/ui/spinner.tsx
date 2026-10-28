import type { ComponentProps } from "react"
import { LoaderCircleIcon, type LucideIcon } from "lucide-react"
import { observeVisibleAnimation } from "@/lib/visible-animation"
import { cn } from "@/lib/utils"

/**
 * Work under way where no words sweep: a glyph that turns once a second for
 * as long as it is drawn. It runs on the sweep's gate
 * (`observeVisibleAnimation`), so it rests only while it is off screen or
 * its window hidden, and turns again the moment it is seen; under reduced
 * motion it stands still. `icon` turns another glyph (a refresh's arrows);
 * `turning={false}` draws that glyph at rest, in the same element.
 */
export function Spinner({ icon: Icon = LoaderCircleIcon, turning = true, className, ...props }: ComponentProps<LucideIcon> & { icon?: LucideIcon; turning?: boolean }) {
  return <Icon {...props} ref={turning ? observeVisibleAnimation : undefined} data-spinner={turning ? "" : undefined} className={cn(turning && "spinner", className)} />
}
