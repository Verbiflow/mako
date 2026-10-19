// A message that references a conversation, written as the composer writes
// one (`writeDraft`): the session flows' `reference` flow sends it. Reads
// JSON from stdin:
//   { ref: ThreadRef, words: string, context: ThreadFileContext }
// (the context as `mako:thread-contexts` prepares it) and prints the message text.
//
//   npx tsx --tsconfig tsconfig.app.json scripts/fixtures/reference-message.ts < input.json
import { text } from "node:stream/consumers"
import { z } from "zod"
import { ThreadRefSchema } from "@mako/sessions"
import { writeDraft } from "../../src/lib/context/draft"
import { threadReferenceId, threadToken } from "../../src/lib/mentions"

const InputSchema = z.object({
  ref: ThreadRefSchema,
  words: z.string(),
  context: z.object({
    kind: z.literal("file"),
    file: z.string(),
    note: z.string(),
    title: z.string().optional(),
    harness: z.string(),
    turns: z.number(),
    digest: z.string(),
    losses: z.array(z.string()),
  }),
})

const input = InputSchema.parse(JSON.parse(await text(process.stdin)))
const token = threadToken(input.ref.harness, threadReferenceId(input.ref))
const written = writeDraft({
  draft: `${token} ${input.words}`,
  records: [],
  conversations: new Map([[token, { thread: input.ref, ref: token.slice(1), context: input.context }]]),
})
process.stdout.write(written.text)
