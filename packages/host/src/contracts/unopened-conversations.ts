/**
 * A saved conversation this host couldn't open as it started: its journal is kept for recovery, and the rail and
 * Settings › Diagnostics say so, so it never just vanishes from the list.
 */
export interface UnopenedConversation {
  conversation: string
  /** The journal file, kept as it was. */
  journal: string
  /** What opening it met. */
  error: string
}
