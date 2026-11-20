import { cn } from "@/lib/utils"
import { avatarHue, monogram } from "@/lib/rail-marks"
import { useRepoAvatar } from "@/state/repo-avatars"

/**
 * The rail's avatars: a 16 px square (Mako's corners are square) for a project and for an Apex, so either is known by
 * its colour down the list in both themes. The hue is one of eight (`.rail-hue-0` to `-7`: 245, 280, 320, 20, 55, 95,
 * 150, 195), hashed from a seed that doesn't change when the name is shown differently: a project's folder, an Apex's
 * Thread. A project with a GitHub remote wears its owner's public avatar instead, which the host fetches and keeps.
 */
export function ProjectAvatar({ name, folder, className }: { name: string; folder: string; className?: string }) {
  const image = useRepoAvatar(folder)
  return (
    <span
      aria-hidden
      data-project-avatar={image ? "github" : "monogram"}
      className={cn("rail-avatar flex size-4 shrink-0 items-center justify-center overflow-hidden", `rail-hue-${avatarHue(folder)}`, className)}
    >
      {image ? <img src={image} alt="" draggable={false} className="size-full object-cover" /> : monogram(name)}
    </span>
  )
}

/** An Apex, as a captain is in Capy: a solid tile in its Thread's hue with the fin cut out, so a Shiver reads as one thing. */
export function ApexAvatar({ seed, className }: { seed: string; className?: string }) {
  return (
    <span aria-hidden data-apex-avatar className={cn("rail-avatar rail-avatar-solid flex size-4 shrink-0 items-center justify-center", `rail-hue-${avatarHue(seed)}`, className)}>
      <svg viewBox="0 0 32 32" className="size-3" aria-hidden>
        <path d="M4.97 5.01C14.94 6.3 20.86 13.77 27.77 26.99L4.97 26.99C8.16 22.52 10.88 13.84 4.97 5.01Z" fill="currentColor" />
      </svg>
    </span>
  )
}
