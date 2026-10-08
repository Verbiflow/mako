import { useId } from "react"
import { cn } from "@/lib/utils"

/**
 * The Mako fin, in its only two forms, both drawn from the app icon's own
 * path so every place shows the same shape:
 *
 * - `MakoMark`, the flat glyph in the text's colour, for inline uses up to
 *   about 32px, where a gradient would only blur. Always full strength;
 *   it is a name, not a decoration to fade.
 * - `MakoTile`, the app icon itself (the favicon's drawing), for every place
 *   the mark stands on its own as an object: menus, Settings, dialogs.
 *
 * Inline rather than an <img>: it stays sharp at 12px and follows the theme.
 */
const FIN = "M4.97 5.01C14.94 6.3 20.86 13.77 27.77 26.99L4.97 26.99C8.16 22.52 10.88 13.84 4.97 5.01Z"

export function MakoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="2 2 28 28" fill="currentColor" aria-hidden className={cn("shrink-0 text-foreground", className)}>
      <path d={FIN} />
    </svg>
  )
}

export function MakoTile({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("shrink-0 drop-shadow-xs", className)}>
      <defs>
        <linearGradient id={`${id}ground`} x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2b3134" />
          <stop offset="1" stopColor="#14181b" />
        </linearGradient>
        <radialGradient id={`${id}sheen`} cx="16" cy="3" r="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6a7276" stopOpacity="0.5" />
          <stop offset="1" stopColor="#6a7276" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}fin`} x1="9" y1="5" x2="25" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset=".5" stopColor="#e8edef" />
          <stop offset="1" stopColor="#a8b2b7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill={`url(#${id}ground)`} />
      <rect width="32" height="32" rx="7" fill={`url(#${id}sheen)`} />
      <path d={FIN} fill={`url(#${id}fin)`} transform="translate(16 16) scale(0.62) translate(-16.4 -16)" />
    </svg>
  )
}
