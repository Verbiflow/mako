import { cn } from "@/lib/utils"
import { avatarHue, monogram } from "@/lib/rail-marks"
import { useRepoAvatar } from "@/state/repo-avatars"

/**
 * The rail's avatar: a 16 px square (Mako's corners are square) for a project, and for nothing else, so a square in the
 * list is always a project and a fin always a Thread. A project is known by its colour down the list in both themes:
 * the hue is one of eight (`.rail-hue-0` to `-7`: 245, 280, 320, 20, 55, 95, 150, 195), hashed from its folder, which
 * doesn't change when the name is shown differently. A project with a GitHub remote wears its owner's public avatar
 * instead, which the host fetches and keeps, when it's the only project here under that owner: one picture on several
 * projects tells none of them apart.
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
