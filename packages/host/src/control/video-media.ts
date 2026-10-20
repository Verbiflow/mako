import { randomUUID } from "node:crypto"
import { problem, type MediaHandler } from "@mako/protocol"
import { CONTROL_VIDEO_ENDINGS, ControlVideoWatchSchema } from "../contracts/control-video.js"
import { hostWarn } from "../base/host-log.js"
import type { ControlPreviews } from "./previews.js"

/** A cloud machine's previews, as the live video its Threads' clients watch (`contracts/control-video.ts`). */
export function controlVideoMedia(previews: ControlPreviews): MediaHandler {
  return {
    watch(stream, _threadId, request, sender) {
      const asked = ControlVideoWatchSchema.safeParse(request.decode())
      if (!asked.success) {
        hostWarn("control", "refused a video watch it couldn't read", { stream })
        return sender.end(problem("bad-request", "Not a preview video request", randomUUID(), "not-applied", { status: 400 }))
      }
      previews.watchVideo(asked.data.conversationId, stream, asked.data.box, {
        send: (packet) => sender.send(packet),
        end: (why) => {
          const ending = CONTROL_VIDEO_ENDINGS[why.kind]
          if (why.kind === "failed") hostWarn("control", "a preview's video stopped", { stream, reason: why.reason })
          sender.end(problem(ending.type, ending.title, randomUUID(), "not-applied", { detail: why.reason }))
        },
      })
    },
    acked: (stream, received) => previews.videoAcked(stream, received),
    unwatched: (stream) => previews.unwatchVideo(stream),
  }
}
