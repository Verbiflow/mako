import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * A Fin's question answered in the person's own words, wherever its options are drawn: the composer, the Shiver card
 * and the Inbox. Always there for a question, beside its options or as the one way to answer when it has none, so an
 * ask never leaves the person with nothing to answer with.
 */
export function FinTypedAnswer({ title, options, disabled, onAnswer, className }: {
  /** The Fin's title, for the field's label. */
  title: string
  /** How many options the question offers beside the field. */
  options: number
  disabled: boolean
  onAnswer: (words: string) => void
  className?: string
}) {
  const [words, setWords] = useState("")
  return (
    <form
      data-fin-typed
      className={cn("flex min-w-48 flex-1", className)}
      onSubmit={(event) => {
        event.preventDefault()
        if (words.trim()) onAnswer(words.trim())
      }}
    >
      <input
        value={words}
        onChange={(event) => setWords(event.target.value)}
        disabled={disabled}
        aria-label={`Answer ${title} in your own words`}
        placeholder={options ? "Or your own words" : "Your answer"}
        // Under a finger a thumb's height, and the 16 px under which iOS zooms into a field it focuses.
        className="h-7 w-full border border-hairline bg-transparent px-2 text-label text-foreground placeholder:text-faint focus:border-foreground/30 focus:outline-none pointer-coarse:h-11 pointer-coarse:text-prose"
      />
    </form>
  )
}
