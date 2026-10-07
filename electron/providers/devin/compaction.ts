import type { AcpCompactionSpec } from "../../acp-compaction.js"

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
