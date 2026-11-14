/*
 * A fixture's clock, moved by hand: what reads the time through `Date.now` (a row's health, how long Add a machine
 * has waited) reads it later, and a window that reads its clock again when it comes to the front does so at once.
 * Only fixture pages import this; nothing the application loads does.
 */
const read = Date.now.bind(Date)
let ahead = 0

/** Moves this page's clock forward by `ms`, and tells the window, as coming back to the front would. */
export function advanceFixtureClock(ms: number): void {
  ahead += ms
  Date.now = () => read() + ahead
  window.dispatchEvent(new Event("focus"))
}
