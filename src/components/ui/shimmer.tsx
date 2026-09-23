/** Loading text with a crest of light running through it; read once, as words. */
export function Shimmer({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="shimmer-chars">
        {Array.from(text, (glyph, index) => (
          <span key={index}>{glyph}</span>
        ))}
      </span>
    </span>
  )
}
