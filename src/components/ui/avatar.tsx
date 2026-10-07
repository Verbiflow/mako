import { cn } from "@/lib/utils"

/**
 * The identity mark: an image when one exists, a monogram when not.
 *
 * The monogram's fill is derived from the name so an account keeps its
 * colour across sessions, with a gradient sheen and a half-pixel border in
 * the same hue — a small object that reads as *made*, not defaulted. The
 * `notch` carves the top-right corner (see .badge-mask) so a status dot can
 * overlap without a background-matched ring.
 */

const HUES = [18, 42, 96, 152, 205, 251, 291, 334, 8]

function hueFor(name: string): number {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0
  }
  return HUES[Math.abs(hash) % HUES.length]
}

const SIZES = {
  4: "size-4 rounded-[4px]",
  5: "size-5 rounded-[5px]",
  6: "size-6 rounded-md",
  8: "size-8 rounded-lg",
  14: "size-14 rounded-xl",
} as const

/** Monogram glyph sizes — drawn marks scaled to the tile, not type. */
const GLYPH = { 4: 8, 5: 9, 6: 11, 8: 13, 14: 22 } as const

export function Avatar({
  src,
  name,
  size = 6,
  notch,
  className,
}: {
  src?: string
  name: string
  size?: keyof typeof SIZES
  notch?: boolean
  className?: string
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase()
  const hue = hueFor(name)
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold",
        SIZES[size],
        notch && "badge-mask",
        className
      )}
      style={
        src
          ? undefined
          : {
              fontSize: GLYPH[size],
              color: `oklch(0.93 0.02 ${hue})`,
              background: `linear-gradient(180deg, oklch(0.52 0.09 ${hue}), oklch(0.44 0.09 ${hue}))`,
              boxShadow: `inset 0 0 0 0.5px oklch(0.6 0.1 ${hue} / 60%)`,
            }
      }
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        initial
      )}
    </span>
  )
}
