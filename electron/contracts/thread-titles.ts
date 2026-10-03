/**
 * A Thread's name as a window draws it, or `null` once it has none of its
 * own and the row shows its Session's native title. `auto` names a title a
 * model wrote; `user` and `frozen` are never replaced automatically.
 */
export interface ThreadTitleEntry {
  thread: string
  title: string | null
  source?: "user" | "frozen" | "auto"
}
