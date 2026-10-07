import type { AcpCompactionSpec } from "../../acp-compaction.js"
import type { ProviderAcpSource } from "../acp-source.js"

/** Devin 3000.6.14 returns end_turn before starting /compact. Its command's
 * own transcript notifications confirm the result. Only installed while this
 * explicit command runs; ordinary model prose can never finish an action.
 */
export const devinCompaction: AcpCompactionSpec = {
  kind: "supported",
  command: "/compact",
  completion: {
    kind: "notification",
    observe() {
      let text = ""
      return (update) => {
        if (
          update.sessionUpdate !== "agent_message_chunk" ||
          update.content.type !== "text"
        )
          return
        text = (text + update.content.text).slice(-4096)
        if (
          /^(?:Compacting context…\s*)?(?:Context compacted|Nothing to compact\.)\s*$/.test(
            text
          )
        )
          return { kind: "completed" }
        if (/^(?:Compacting context…\s*)?Compaction canceled\.\s*$/.test(text))
          return { kind: "failed", reason: "Compaction was canceled" }
        const failure =
          /^(?:Compacting context…\s*)?Force compaction failed:\s*(.+)$/s.exec(
            text
          )
        if (failure) return { kind: "failed", reason: failure[1] }
        return undefined
      }
    },
  },
}

/**
 * Devin's own status line for its client, `_meta["cognition.ai/displayMessage"]`:
 * 3000.10.23 reports /compact's result this way ("Context compacted") beside
 * `_cognition.ai/compaction`, and keeps it out of its store. The compaction
 * spec above still reads it.
 */
export const devinTransient: NonNullable<ProviderAcpSource["transient"]> = (notification) =>
  notification.update.sessionUpdate === "agent_message_chunk" && notification.update._meta?.["cognition.ai/displayMessage"] === true
