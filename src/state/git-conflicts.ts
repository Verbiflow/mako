import { gitPullBlocker } from "@/state/git-push"
import { getMako } from "@/lib/bridge"
import { attachmentReference } from "@/lib/attachment-references"
import { gitConflictContext } from "@/lib/git-conflict-context"
import type { Attachment, AttachmentInput } from "@/lib/attachments"
import { actions, store } from "@/state/session"

export function gitConflictAttachment(): AttachmentInput | null {
  const status = store.get().git
  const context = gitConflictContext(status, undefined, gitPullBlocker(status?.root ?? "", status?.branch ?? ""))
  return context ? { file: new File([context.text], context.name, { type: "text/markdown" }), contextLabel: context.label } : null
}

export async function copyGitConflictContext(): Promise<boolean> {
  const status = store.get().git
  const context = gitConflictContext(status, undefined, gitPullBlocker(status?.root ?? "", status?.branch ?? ""))
  if (!context) throw new Error("No conflicts remain. Refresh the Git panel to see the latest state.")
  const bytes = new TextEncoder().encode(context.text)
  const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
  const staged = await getMako().stageFile(context.name, data)
  const attachment: Attachment = {
    id: crypto.randomUUID(), index: 1, name: context.name, contextLabel: context.label,
    mimeType: "text/markdown", kind: "text", size: bytes.length, stagedPath: staged.path,
  }
  return actions.copy(attachmentReference(attachment), { attachments: [attachment], notify: false })
}
