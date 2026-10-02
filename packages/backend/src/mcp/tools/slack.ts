import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  SlackChannelIdSchema,
  SlackTimestampSchema,
  listSlackChannels,
  readSlackMessages,
  readSlackThread,
  sendSlackMessage,
  slackIdentity,
} from "../../integrations/slack/client"
import { yamlResult } from "../result"

const CursorSchema = z.string().max(512).optional()
const LimitSchema = z.number().int().min(1).max(100).default(50)

export function registerSlackTools(server: McpServer): void {
  server.registerTool(
    "mako_slack_status",
    {
      title: "Slack connection status",
      description:
        "Verify Mako's Vercel Connect Slack installation and return non-secret workspace identity.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => yamlResult(withoutOk(await slackIdentity()))
  )

  server.registerTool(
    "mako_slack_list_channels",
    {
      title: "List Slack conversations",
      description:
        "List bounded Slack channels and conversations visible to the installed Mako app.",
      inputSchema: z.object({
        cursor: CursorSchema,
        limit: LimitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ cursor, limit }) =>
      yamlResult(channelsPage(await listSlackChannels({ cursor, limit })))
  )

  server.registerTool(
    "mako_slack_read_messages",
    {
      title: "Read Slack messages",
      description:
        "Read a bounded page of recent messages from one exact Slack conversation.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        cursor: CursorSchema,
        limit: LimitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, cursor, limit }) =>
      yamlResult(messagesPage(await readSlackMessages({ channel, cursor, limit })))
  )

  server.registerTool(
    "mako_slack_read_thread",
    {
      title: "Read a Slack thread",
      description:
        "Read a bounded page of replies from one exact Slack conversation thread.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        cursor: CursorSchema,
        limit: LimitSchema,
        threadTs: SlackTimestampSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, cursor, limit, threadTs }) =>
      yamlResult(
        messagesPage(await readSlackThread({ channel, cursor, limit, threadTs }))
      )
  )

  server.registerTool(
    "mako_slack_send_message",
    {
      title: "Send a Slack message",
      description:
        "Send one message to an exact Slack destination. Requires an idempotency key so retries cannot duplicate the message.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        idempotencyKey: z.uuid(),
        text: z.string().min(1).max(12_000),
        threadTs: SlackTimestampSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, idempotencyKey, text, threadTs }) =>
      yamlResult(
        withoutOk(
          await sendSlackMessage({
            channel,
            idempotencyKey,
            text,
            threadTs,
          })
        )
      )
  )
}

type Page = {
  ok: true
  has_more?: boolean
  response_metadata?: { next_cursor: string }
}

/** Slack's `ok: true` says nothing once a call has succeeded; failures throw. */
function withoutOk<Reply extends { ok: true }>({ ok: _ok, ...rest }: Reply) {
  return rest
}

/** The cursor for the next page, when there is one; Slack sends an empty one at the end. */
function withNextPage<Listing extends object>(
  listing: Listing,
  { has_more, response_metadata }: Page
): Listing & { has_more?: true; next_cursor?: string } {
  const page: Listing & { has_more?: true; next_cursor?: string } = listing
  if (has_more) page.has_more = true
  if (response_metadata?.next_cursor)
    page.next_cursor = response_metadata.next_cursor
  return page
}

function channelsPage(page: Awaited<ReturnType<typeof listSlackChannels>>) {
  const channels = page.channels.map(({ purpose, topic, ...rest }) => {
    const channel: typeof rest & { purpose?: string; topic?: string } = rest
    if (purpose?.value) channel.purpose = purpose.value
    if (topic?.value) channel.topic = topic.value
    return channel
  })
  return withNextPage({ channels }, page)
}

function messagesPage(page: Awaited<ReturnType<typeof readSlackMessages>>) {
  const messages = page.messages.map(({ type, ...message }) =>
    type === "message" ? message : { type, ...message }
  )
  return withNextPage({ messages }, page)
}
