/** One filled outline of a mark, in its `viewBox`'s coordinates. */
export interface MarkPath {
  d: string
  fillRule?: "evenodd"
}

/**
 * A harness's brand mark as data, declared with the harness and drawn by
 * the renderer's one `HarnessIcon`, so a new harness brings its own mark.
 */
export interface HarnessMark {
  viewBox: string
  paths: readonly MarkPath[]
  /** The brand colour, or `currentColor` to follow the text around it. */
  tint: string
  /** Stops of a top-to-bottom gradient that fills the mark in place of the tint. */
  gradient?: readonly { offset: number; color: string }[]
}

export interface HarnessPresentation {
  mark: HarnessMark
}
