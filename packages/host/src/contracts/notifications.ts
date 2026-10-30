/**
 * What tells the person a Session needs them, as every surface says it (`@mako/protocol/attention`): the five kinds,
 * the rule a Session's change is one of them by, and the one wording. The desktop, the web app and the account's Web
 * Push all read these, so none decides or words a notice on its own.
 */
export {
  ATTENTION_SUMMARY_FROM,
  ATTENTION_WORDS,
  asks,
  attentionHeadline,
  attentionLine,
  attentionSummary,
  foldedBody,
  needsYouWaiting,
  noticeTag,
  requestWaiting,
  type AttentionKind,
  type Waiting,
  type WaitingFor,
} from "@mako/protocol/attention"

/**
 * Desktop notifications and the app-icon badge.
 *
 * The renderer decides *what* deserves attention (it owns the attention model
 * and knows which thread is on screen); the client process only delivers.
 * One notification per subject: a new one for the same subject replaces the
 * banner instead of stacking, and dismissing a subject closes whatever it
 * still has on screen. A subject is a thread identity — a native session path,
 * a live conversation key, or a built-in tab id — never an event.
 */
export interface DesktopNotification {
  /** Unique per delivery; the click event echoes it. */
  id: string
  /** The thread this is about. Replaces an earlier banner for the same subject. */
  subject: string
  title: string
  /** macOS shows this under the title; other platforms fold it into the body. */
  subtitle?: string
  body: string
  /** Suppress the platform's own sound; the desk plays its cue instead. */
  silent: boolean
}

/**
 * What the platform did with a notification. `delivered` is "handed to the
 * operating system", which is all a client can know: macOS may still hide a
 * banner the user turned off in System Settings.
 */
export type NotificationDelivery =
  | { delivered: true }
  | { delivered: false; reason: "unsupported" | "unsigned" | "denied" | "failed" }

/**
 * `unsigned` is a checkout running as the ad-hoc Electron binary: macOS
 * refuses its banners and never prompts, so only the packaged app can notify.
 * `default` is not yet asked; the first banner (or the test one) prompts.
 */
export type NotificationPermission =
  | "granted"
  | "denied"
  | "default"
  | "unsigned"
  | "unsupported"
