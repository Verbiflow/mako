import { randomUUID } from "node:crypto"
import { problem, type MediaHandler } from "@mako/protocol"
import { CONTROL_VIDEO_ENDINGS, ControlVideoWatchSchema, NOTHING_SHOWN } from "../contracts/control-video.js"
import { hostWarn } from "../base/host-log.js"
import type { ControlPreviews } from "./previews.js"
import type { PreviewVideoSender } from "./preview-video.js"

/**
 * A host's previews as the live video clients watch through its link (`contracts/control-video.ts`): a cloud
 * machine's for its Threads' clients, and a Mac's for the account's other devices. `loaded` is the previews once
 * control has loaded (`core.ts`): a watch doesn't load it.
 */
export function controlVideoMedia(loaded: () => ControlPreviews | undefined): MediaHandler {
  return {
    watch(stream, _threadId, request, sender) {
      const asked = ControlVideoWatchSchema.safeParse(request.decode())
      if (!asked.success) {
        hostWarn("control", "refused a video watch it couldn't read", { stream })
        return sender.end(problem("bad-request", "Not a preview video request", randomUUID(), "not-applied", { status: 400 }))
      }
      const watcher: PreviewVideoSender = {
        send: (packet) => sender.send(packet),
        end: (why) => {
          const ending = CONTROL_VIDEO_ENDINGS[why.kind]
          if (why.kind === "failed") hostWarn("control", "a preview's video stopped", { stream, reason: why.reason })
          sender.end(problem(ending.type, ending.title, randomUUID(), "not-applied", { detail: why.reason }))
        },
      }
      const previews = loaded()
      // Before control has loaded nothing is shown for any conversation, which is what its previews would answer.
      if (!previews) return watcher.end({ kind: "gone", reason: NOTHING_SHOWN })
      previews.watchVideo(asked.data.conversationId, stream, asked.data.box, watcher)
    },
    acked: (stream, received) => loaded()?.videoAcked(stream, received),
    unwatched: (stream) => loaded()?.unwatchVideo(stream),
  }
}
