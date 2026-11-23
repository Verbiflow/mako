/**
 * A Thread's name as a window draws it, or `null` once it has none and the
 * row shows its first Session's title. `user` is a person's rename;
 * `frozen` is a name Mako gave a Thread it started; `auto` is a title Mako
 * generated from the Thread's first exchange, which either of the others
 * replaces.
 */
export interface ThreadTitleEntry {
  thread: string
  title: string | null
  source?: "user" | "frozen" | "auto"
}
