import { useThreads } from "@/state/thread-store"
import type { HarnessMark } from "../../../electron/contracts/harness-presentation"
import { useId, type SVGProps } from "react"
import { cn } from "@/lib/utils"

/**
 * Provider marks.
 *
 * A model picker that shows the same generic glyph on every row is telling you
 * nothing — the provider is the single most recognisable fact about a model,
 * and a brand mark is read at a glance where a name has to be parsed. Each
 * mark carries the provider's own colour, which is the one place in this
 * otherwise achromatic interface where hue is worth spending: it is
 * information, not decoration.
 */

type Mark = (props: SVGProps<SVGSVGElement>) => React.ReactElement

const Anthropic: Mark = (props) => (
  <svg viewBox="0 0 256 257" fill="currentColor" {...props}>
    <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
  </svg>
)

const OpenAI: Mark = (props) => (
  <svg viewBox="0 0 256 260" fill="currentColor" {...props}>
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
)

const Google: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M11.3.39c.18-.5.89-.49 1.06.01l.48 1.4a14.83 14.83 0 0 0 8.96 9.1l1.56.57c.49.18.49.88 0 1.06l-1.56.57a14.83 14.83 0 0 0-8.82 8.81l-.61 1.66c-.18.5-.88.5-1.06 0l-.64-1.71a14.83 14.83 0 0 0-8.78-8.75l-1.59-.58c-.49-.18-.49-.88 0-1.06l1.62-.6a14.83 14.83 0 0 0 8.74-8.76L11.3.4Z" />
  </svg>
)

const XAI: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M6.469 8.776 16.512 23h-4.464L2.005 8.776H6.47Zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324ZM22 2.582V23h-3.659V7.764L22 2.582ZM22 1l-9.952 14.095-2.233-3.163L17.533 1H22Z" />
  </svg>
)

const DeepSeek: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M22.5 5.3c-.3-.15-.43.07-.6.2-.06.05-.11.1-.16.16-.44.47-.95.78-1.63.74-1-.06-1.85.25-2.6.99-.16-.9-.68-1.44-1.47-1.79-.41-.18-.83-.36-1.12-.75-.2-.28-.25-.59-.35-.9-.06-.19-.13-.38-.35-.41-.24-.04-.33.16-.43.33-.38.7-.53 1.47-.51 2.24.04 1.74.79 3.12 2.27 4.11.17.11.21.23.16.4-.1.33-.21.65-.31.98-.06.21-.16.26-.39.16a5.3 5.3 0 0 1-1.7-1.29c-.86-.9-1.64-1.9-2.61-2.69a12.4 12.4 0 0 0-.74-.55c-1.05-1.02.14-1.86.41-1.96.29-.1.1-.46-.83-.46-.93.01-1.78.32-2.86.74-.16.06-.33.11-.5.15a9.6 9.6 0 0 0-2.83-.1c-1.9.2-3.42 1.1-4.52 2.63C.1 9.34-.23 11.4.18 13.55c.43 2.26 1.58 4.13 3.35 5.6 1.84 1.5 3.95 2.24 6.37 2.1 1.47-.09 3.11-.28 4.96-1.85.47.23.96.32 1.77.4.63.05 1.23-.04 1.7-.14.73-.16.68-.84.42-.96-2.14-1-1.67-.59-2.1-.92 1.1-1.3 2.75-2.65 3.4-7.02.05-.35 0-.57 0-.85 0-.17.03-.24.23-.26.55-.06 1.08-.21 1.57-.48 1.42-.78 2-2.07 2.13-3.6.02-.23 0-.47-.24-.6ZM11.62 19.4c-2.08-1.63-3.08-2.17-3.5-2.14-.38.02-.31.46-.23.75.1.28.22.48.39.73.12.17.2.42-.11.61-.68.42-1.87-.15-1.92-.18-1.39-.82-2.55-1.9-3.37-3.38-.79-1.43-1.25-2.96-1.33-4.59-.02-.4.1-.54.49-.61.52-.1 1.05-.12 1.57-.04 2.19.32 4.05 1.3 5.62 2.85.89.89 1.56 1.94 2.25 2.97.74 1.1 1.53 2.14 2.54 3 .35.3.63.53.9.7-.81.09-2.17.11-3.3-.67Zm1-6.44a.24.24 0 0 1 .25-.24c.06 0 .12.02.16.06l.05.06.28.64c.05.14-.03.28-.17.3a.24.24 0 0 1-.28-.17l-.29-.65Zm2.03 1.04a1 1 0 0 1-.45.34.87.87 0 0 1-.53.04c-.34-.08-.6-.28-.8-.55a.9.9 0 0 1-.18-.5.75.75 0 0 1 .1-.4c.2-.31.5-.4.87-.25.3.12.5.36.66.64.11.2.2.4.2.55a.9.9 0 0 1 .13.13Zm3.36-.9c-.22.09-.44.16-.65.17a1.44 1.44 0 0 1-.9-.25c-.31-.2-.53-.4-.64-.7a.63.63 0 0 1 0-.44c.1-.2.28-.3.53-.3.35 0 .65.13.9.36.19.16.32.36.48.55.1.11.2.23.36.28.06.02.08.06.05.11-.03.11-.09.16-.13.22Z" />
  </svg>
)

const Meta: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M6.9 4.5c-2.2 0-3.9 2-4.6 4.7-.5 1.9-.5 4 .1 5.6.6 1.6 1.8 2.7 3.4 2.7 1.4 0 2.5-.7 3.6-2.1.9-1.2 1.7-2.7 2.5-4.2.7 1.4 1.5 2.9 2.4 4.1 1.1 1.5 2.3 2.2 3.7 2.2 1.7 0 2.9-1.2 3.4-2.9.5-1.7.4-3.9-.2-5.7-.8-2.5-2.5-4.4-4.7-4.4-1.6 0-2.9.9-4.1 2.3-.3.4-.6.8-.9 1.2-.3-.4-.6-.9-.9-1.3-1.2-1.4-2.5-2.2-4-2.2Zm.2 2c.8 0 1.6.5 2.5 1.6.3.4.6.8.9 1.3-1 1.8-1.8 3.4-2.6 4.4-.7.9-1.2 1.2-1.8 1.2-.7 0-1.2-.5-1.5-1.4-.4-1.1-.4-2.7 0-4.1.4-1.6 1.3-3 2.5-3Zm10 0c1.2 0 2.1 1.3 2.6 3 .4 1.4.5 3.1.2 4.2-.3.9-.8 1.4-1.5 1.4-.6 0-1.1-.3-1.9-1.3-.8-1-1.7-2.6-2.7-4.4.3-.5.6-.9.9-1.3.9-1.1 1.6-1.6 2.4-1.6Z" />
  </svg>
)

const Mistral: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M3 3h3.6v3.6H3V3Zm13.8 0H21v3.6h-4.2V3ZM3 6.6h3.6v3.6H3V6.6Zm10.2 0h3.6v3.6h-3.6V6.6Zm3.6 0H21v3.6h-4.2V6.6ZM3 10.2h3.6v3.6H3v-3.6Zm6.6 0h3.6v3.6H9.6v-3.6Zm3.6 0h3.6v3.6h-3.6v-3.6Zm3.6 0H21v3.6h-4.2v-3.6ZM3 13.8h3.6v3.6H3v-3.6Zm13.8 0H21v3.6h-4.2v-3.6ZM3 17.4h3.6V21H3v-3.6Zm13.8 0H21V21h-4.2v-3.6Z" />
  </svg>
)

const GitHub: Mark = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
)

/** Marks by model-provider id, with the tint each brand is recognised by. */
const MARKS = {
  anthropic: { mark: Anthropic, tint: "#D97757" },
  openai: { mark: OpenAI, tint: "currentColor" },
  azure: { mark: OpenAI, tint: "currentColor" },
  google: { mark: Google, tint: "#4285F4" },
  "google-vertex": { mark: Google, tint: "#4285F4" },
  xai: { mark: XAI, tint: "currentColor" },
  deepseek: { mark: DeepSeek, tint: "#4D6BFE" },
  groq: { mark: Meta, tint: "#F55036" },
  meta: { mark: Meta, tint: "#0866FF" },
  mistral: { mark: Mistral, tint: "#FA520F" },
  openrouter: { mark: Mistral, tint: "currentColor" },
  github: { mark: GitHub, tint: "currentColor" },
  copilot: { mark: GitHub, tint: "currentColor" },
}

/** A harness's declared mark, or initials when the host has described none. */
export function HarnessIcon({
  harness,
  className,
  tinted = true,
}: {
  harness: string
  className?: string
  tinted?: boolean
}) {
  const mark = useThreads((state) => state.descriptors.find((entry) => entry.provider === harness)?.presentation?.mark)
  return mark ? <DeclaredMark mark={mark} tinted={tinted} className={className} /> : <Initials name={harness} className={className} />
}

/** Draws a mark from its data; a gradient spans the viewBox top to bottom. */
function DeclaredMark({ mark, tinted, className }: { mark: HarnessMark; tinted: boolean; className?: string }) {
  const gradient = useId()
  const [x = 0, y = 0, width = 0, height = 0] = mark.viewBox.split(" ").map(Number)
  const fill = mark.gradient ? `url(#${gradient})` : undefined
  return (
    <svg
      viewBox={mark.viewBox}
      fill="currentColor"
      className={cn("shrink-0", className)}
      style={tinted && !mark.gradient && mark.tint !== "currentColor" ? { color: mark.tint } : undefined}
      aria-hidden
    >
      {mark.gradient ? (
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={x + width / 2} x2={x + width / 2} y1={y} y2={y + height}>
            {mark.gradient.map((stop) => <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />)}
          </linearGradient>
        </defs>
      ) : null}
      {mark.paths.map((path, index) => <path key={index} d={path.d} fillRule={path.fillRule} fill={fill} />)}
    </svg>
  )
}

function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] bg-foreground/10",
        "text-[7px] font-bold tracking-tight text-muted-foreground uppercase",
        className
      )}
      aria-hidden
    >
      {name.slice(0, 2)}
    </span>
  )
}

/**
 * Renders a provider's mark, falling back to its initials — which still reads
 * as identity, where a wrench would read as "unknown".
 */
export function ProviderIcon({
  provider,
  className,
  tinted = true,
}: {
  provider: string
  className?: string
  /** Off inside a coloured surface, where the brand tint would clash. */
  tinted?: boolean
}) {
  const key = provider.toLowerCase()
  const fallbackKey = key.split(/[-/]/)[0]
  const found = Object.entries(MARKS).find(([id]) => id === key)?.[1]
    ?? Object.entries(MARKS).find(([id]) => id === fallbackKey)?.[1]
  // A model a harness serves itself, such as Cursor's Composer, wears the harness's mark.
  const harnessMark = useThreads((state) => found ? undefined : state.descriptors.find((entry) => entry.provider === key || entry.provider === fallbackKey)?.presentation?.mark)

  if (!found) return harnessMark ? <DeclaredMark mark={harnessMark} tinted={tinted} className={className} /> : <Initials name={provider} className={className} />

  const Mark = found.mark
  return (
    <Mark
      className={cn("shrink-0", className)}
      style={tinted && found.tint !== "currentColor" ? { color: found.tint } : undefined}
      aria-hidden
    />
  )
}
