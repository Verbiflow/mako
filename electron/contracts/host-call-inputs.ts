// Generated from host handler parameter types by scripts/generate-host-inputs.mjs.
// Regenerate after changing a handler's arguments; never edit this table by hand.
import { z } from "zod"

export const hostCallInputs = {
  "mako:abort": z.tuple([]),
  "mako:account-capture": z.tuple([z.string(), z.string()]),
  "mako:account-remove": z.tuple([z.string(), z.string()]),
  "mako:account-select": z.tuple([z.string(), z.union([z.null(), z.string()])]),
  "mako:account-usage": z.tuple([z.string(), z.string()]),
  "mako:accounts": z.tuple([]),
  "mako:activate-tab": z.tuple([z.string()]),
  "mako:appshot-capture": z.tuple([
    z.object({ pid: z.number(), windowId: z.number() }),
  ]),
  "mako:appshot-windows": z.tuple([]),
  "mako:automation-enabled": z.tuple([z.string(), z.boolean()]),
  "mako:automations": z.tuple([]),
  "mako:boot": z.tuple([]),
  "mako:browser-control-connect": z.tuple([z.string()]),
  "mako:browser-control-disconnect": z.tuple([z.string()]),
  "mako:browser-control-status": z.tuple([]),
  "mako:browser-extension-setup": z.tuple([]),
  "mako:build-update": z.tuple([]),
  "mako:capabilities": z.tuple([]),
  "mako:check-updates": z.tuple([]),
  "mako:clear-crashes": z.tuple([]),
  "mako:clear-queue": z.tuple([]),
  "mako:close-tab": z.tuple([z.string()]),
  "mako:compact": z.tuple([z.string().optional()]),
  "mako:computer-driver": z.tuple([]),
  "mako:computer-driver-update": z.tuple([]),
  "mako:computer-permissions": z.tuple([]),
  "mako:computer-permissions-request": z.tuple([]),
  "mako:control-preview": z.tuple([z.string(), z.boolean(), z.string()]),
  "mako:control-preview-source": z.tuple([z.string()]),
  "mako:copy": z.tuple([z.string()]),
  "mako:crashes": z.tuple([]),
  "mako:crashes-dir": z.tuple([]),
  "mako:create-pull": z.tuple([
    z.object({
      title: z.string(),
      body: z.string(),
      base: z.string().optional(),
      draft: z.boolean().optional(),
    }),
  ]),
  "mako:create-workspace-text": z.tuple([z.string(), z.string(), z.string()]),
  "mako:daemon-login": z.tuple([]),
  "mako:daemon-login-set": z.tuple([z.boolean()]),
  "mako:daemon-status": z.tuple([]),
  "mako:default-commit-prompt": z.tuple([]),
  "mako:delete-plugin": z.tuple([z.string()]),
  "mako:external-editors": z.tuple([]),
  "mako:fork": z.tuple([
    z.string(),
    z.union([z.literal("before"), z.literal("at")]).optional(),
  ]),
  "mako:git-cancel-generation": z.tuple([z.string()]),
  "mako:git-commit": z.tuple([
    z.string(),
    z.object({ amend: z.boolean().optional() }).optional(),
  ]),
  "mako:git-commit-diff-all": z.tuple([z.string()]),
  "mako:git-commit-file-diff": z.tuple([z.string(), z.string()]),
  "mako:git-commit-files": z.tuple([z.string()]),
  "mako:git-diff": z.tuple([z.string()]),
  "mako:git-diff-all": z.tuple([]),
  "mako:git-generate-message": z.tuple([
    z.object({
      mode: z.union([z.literal("fast"), z.literal("deep")]).optional(),
      requestId: z.string(),
      cwd: z.string(),
      prompt: z.string().optional(),
      model: z.string().optional(),
    }),
  ]),
  "mako:git-log": z.tuple([z.number().optional()]),
  "mako:git-push": z.tuple([z.object({ cwd: z.string(), branch: z.string() })]),
  "mako:git-stage": z.tuple([z.array(z.string())]),
  "mako:git-stage-all": z.tuple([]),
  "mako:git-status": z.tuple([]),
  "mako:git-unstage": z.tuple([z.array(z.string())]),
  "mako:git-unstage-all": z.tuple([]),
  "mako:github-status": z.tuple([]),
  "mako:harness-availability": z.tuple([]),
  "mako:harness-descriptors": z.tuple([]),
  "mako:harness-profiles": z.tuple([z.boolean().optional()]),
  "mako:harness-start": z.tuple([
    z.string(),
    z.string(),
    z
      .object({
        model: z.string().optional(),
        options: z
          .record(z.string(), z.union([z.boolean(), z.string()]))
          .optional(),
      })
      .optional(),
  ]),
  "mako:harness-tuning": z.tuple([
    z.string(),
    z.string().optional(),
    z.boolean().optional(),
  ]),
  "mako:harness-update": z.tuple([z.string()]),
  "mako:harness-updates": z.tuple([]),
  "mako:host-log-path": z.tuple([]),
  "mako:install-update": z.tuple([]),
  "mako:installation-state": z.tuple([]),
  "mako:integrations": z.tuple([]),
  "mako:lifecycle-command": z.tuple([
    z.union([
      z.object({ kind: z.literal("cancel") }),
      z.object({
        kind: z.literal("wait"),
        action: z.union([
          z.literal("quit"),
          z.literal("install"),
          z.literal("restart"),
        ]),
      }),
      z.object({
        kind: z.literal("stop"),
        action: z.union([
          z.literal("quit"),
          z.literal("install"),
          z.literal("restart"),
        ]),
        revision: z.string(),
      }),
    ]),
  ]),
  "mako:lifecycle-state": z.tuple([]),
  "mako:list-files": z.tuple([]),
  "mako:list-models": z.tuple([]),
  "mako:list-plugins": z.tuple([]),
  "mako:list-sessions": z.tuple([
    z.string().optional(),
    z.union([z.literal("workspace"), z.literal("all")]).optional(),
  ]),
  "mako:live-action": z.tuple([
    z.string(),
    z.union([
      z.object({
        kind: z.literal("steer"),
        id: z.string(),
        requestId: z.string(),
        text: z.string(),
        attachments: z.array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number(),
            data: z.string().optional(),
            path: z.string().optional(),
          })
        ),
      }),
      z.object({ kind: z.literal("compact"), id: z.string() }),
    ]),
  ]),
  "mako:live-action-acknowledge": z.tuple([z.string(), z.string()]),
  "mako:live-bind": z.tuple([z.string(), z.string()]),
  "mako:live-cancel": z.tuple([z.string()]),
  "mako:live-capture": z.tuple([z.string(), z.string()]),
  "mako:live-child-cancel": z.tuple([z.string(), z.string()]),
  "mako:live-clear-queue": z.tuple([z.string()]),
  "mako:live-close": z.tuple([z.string()]),
  "mako:live-delegate": z.tuple([
    z.string(),
    z.object({ id: z.string(), provider: z.string(), task: z.string() }),
  ]),
  "mako:live-earlier": z.tuple([z.string()]),
  "mako:live-edit-queued": z.tuple([
    z.string(),
    z.object({
      requestId: z.string(),
      expectedText: z.string(),
      change: z.union([
        z.object({ kind: z.literal("edit"), text: z.string() }),
        z.object({ kind: z.literal("remove") }),
        z.object({ kind: z.literal("pause") }),
        z.object({ kind: z.literal("resume") }),
      ]),
    }),
  ]),
  "mako:live-fork": z.tuple([
    z.string(),
    z.object({
      id: z.string(),
      provider: z.string(),
      point: z.union([
        z.object({ kind: z.literal("run"), requestId: z.string() }),
        z.object({ kind: z.literal("before-run"), requestId: z.string() }),
        z.object({
          kind: z.literal("native"),
          index: z.number(),
          revision: z.string(),
          anchor: z
            .object({
              index: z.number(),
              id: z.string().optional(),
              at: z.string().optional(),
            })
            .optional(),
        }),
      ]),
    }),
  ]),
  "mako:live-merge-fork": z.tuple([z.string(), z.string()]),
  "mako:live-mode": z.tuple([z.string(), z.string()]),
  "mako:live-permission": z.tuple([
    z.string(),
    z.string(),
    z.union([
      z.object({
        kind: z.literal("choice"),
        optionId: z.union([z.null(), z.string()]),
      }),
      z.object({
        kind: z.literal("answers"),
        answers: z.record(z.string(), z.array(z.string())),
      }),
    ]),
  ]),
  "mako:live-prompt": z.tuple([
    z.string(),
    z.string(),
    z.string(),
    z
      .array(
        z.object({
          name: z.string(),
          mimeType: z.string(),
          size: z.number(),
          data: z.string().optional(),
          path: z.string().optional(),
        })
      )
      .optional(),
    z
      .object({
        model: z.string().optional(),
        options: z
          .record(z.string(), z.union([z.boolean(), z.string()]))
          .optional(),
      })
      .optional(),
  ]),
  "mako:live-rewind": z.tuple([
    z.string(),
    z.object({
      id: z.string(),
      requestId: z.string(),
      expectedId: z.string(),
      position: z.union([z.literal("before"), z.literal("after")]).optional(),
    }),
  ]),
  "mako:live-rewind-preview": z.tuple([
    z.string(),
    z.string(),
    z.union([z.literal("before"), z.literal("after")]).optional(),
  ]),
  "mako:live-rewind-recover": z.tuple([]),
  "mako:live-snapshot": z.tuple([z.string()]),
  "mako:live-start": z.tuple([
    z.string(),
    z.string(),
    z.object({
      initialRequest: z
        .object({
          id: z.string(),
          text: z.string(),
          attachments: z.array(
            z.object({
              name: z.string(),
              mimeType: z.string(),
              size: z.number(),
              data: z.string().optional(),
              path: z.string().optional(),
            })
          ),
        })
        .optional(),
      conversationId: z.string(),
      resume: z.string().optional(),
      title: z.string().optional(),
      threadPath: z.string().optional(),
      displayPrompt: z.string().optional(),
      modeId: z.string().optional(),
      tuning: z
        .object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        })
        .optional(),
    }),
  ]),
  "mako:live-state": z.tuple([z.string()]),
  "mako:live-transfer": z.tuple([
    z.string(),
    z.object({
      id: z.string(),
      provider: z.string(),
      text: z.string(),
      attachments: z.array(
        z.object({
          name: z.string(),
          mimeType: z.string(),
          size: z.number(),
          data: z.string().optional(),
          path: z.string().optional(),
        })
      ),
      tuning: z
        .object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        })
        .optional(),
    }),
  ]),
  "mako:mcp-discover": z.tuple([]),
  "mako:mcp-sync-apply": z.tuple([
    z.string(),
    z.object({
      provider: z.string(),
      account: z.string(),
      scope: z.union([z.literal("workspace"), z.literal("user")]),
    }),
  ]),
  "mako:mcp-sync-preview": z.tuple([
    z.string(),
    z.object({
      provider: z.string(),
      account: z.string(),
      scope: z.union([z.literal("workspace"), z.literal("user")]),
    }),
  ]),
  "mako:merge-pull": z.tuple([
    z.union([z.literal("merge"), z.literal("squash"), z.literal("rebase")]),
  ]),
  "mako:native-dismiss": z.tuple([z.string()]),
  "mako:native-edit-queued": z.tuple([
    z.object({
      requestId: z.string(),
      expectedText: z.string(),
      change: z.union([
        z.object({ kind: z.literal("edit"), text: z.string() }),
        z.object({ kind: z.literal("remove") }),
        z.object({ kind: z.literal("pause") }),
        z.object({ kind: z.literal("resume") }),
      ]),
    }),
  ]),
  "mako:native-receipt": z.tuple([z.string()]),
  "mako:native-requests": z.tuple([]),
  "mako:native-submit": z.tuple([
    z.object({
      id: z.string(),
      path: z.string(),
      text: z.string(),
      attachments: z.array(
        z.object({
          name: z.string(),
          mimeType: z.string(),
          size: z.number(),
          data: z.string().optional(),
          path: z.string().optional(),
        })
      ),
      tuning: z
        .object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        })
        .optional(),
    }),
  ]),
  "mako:navigate-tree": z.tuple([z.string()]),
  "mako:new-session": z.tuple([]),
  "mako:notification-permission": z.tuple([]),
  "mako:notify": z.tuple([
    z.object({
      id: z.string(),
      subject: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
      body: z.string(),
      silent: z.boolean(),
    }),
  ]),
  "mako:notify-dismiss": z.tuple([z.string()]),
  "mako:open-in-editor": z.tuple([z.string(), z.string().optional()]),
  "mako:open-preview-window": z.tuple([]),
  "mako:open-session": z.tuple([z.string()]),
  "mako:open-tab": z.tuple([
    z
      .object({
        cwd: z.string().optional(),
        sessionPath: z.string().optional(),
      })
      .optional(),
  ]),
  "mako:open-url": z.tuple([z.string()]),
  "mako:pick-folder": z.tuple([]),
  "mako:plugins-dir": z.tuple([]),
  "mako:prompt": z.tuple([
    z.string(),
    z.union([z.literal("steer"), z.literal("followUp")]).optional(),
    z.array(z.object({ mimeType: z.string(), data: z.string() })).optional(),
  ]),
  "mako:provider-connection-action": z.tuple([
    z.string(),
    z.union([
      z.object({ kind: z.literal("refresh") }),
      z.object({ kind: z.literal("sign-in-browser") }),
      z.object({ kind: z.literal("sign-in-key"), apiKey: z.string() }),
      z.object({ kind: z.literal("sign-out") }),
    ]),
  ]),
  "mako:provider-connections": z.tuple([z.boolean().optional()]),
  "mako:pull-branches": z.tuple([]),
  "mako:pull-request": z.tuple([]),
  "mako:pull-requests": z.tuple([z.number().optional()]),
  "mako:quit-client": z.tuple([]),
  "mako:read-file": z.tuple([z.string()]),
  "mako:read-live-file": z.tuple([z.string(), z.string()]),
  "mako:relaunch": z.tuple([]),
  "mako:reload-automations": z.tuple([]),
  "mako:repo-avatar": z.tuple([z.string()]),
  "mako:report-crash": z.tuple([
    z.union([z.literal("renderer-error"), z.literal("renderer-rejection")]),
    z.object({
      message: z.string(),
      stack: z.string().optional(),
      source: z.string().optional(),
    }),
  ]),
  "mako:request-notification-permission": z.tuple([]),
  "mako:rerun-checks": z.tuple([]),
  "mako:reveal": z.tuple([z.string()]),
  "mako:reveal-plugins": z.tuple([]),
  "mako:run-automation": z.tuple([z.string()]),
  "mako:run-command": z.tuple([z.string(), z.string().optional()]),
  "mako:save-automations": z.tuple([
    z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        prompt: z.string(),
        trigger: z.union([
          z.object({ kind: z.literal("manual") }),
          z.object({ kind: z.literal("files"), paths: z.array(z.string()) }),
          z.object({ kind: z.literal("commit") }),
          z.object({
            kind: z.literal("slack"),
            event: z.union([
              z.literal("message_in_channel"),
              z.literal("reaction_added"),
              z.literal("channel_created"),
            ]),
            channels: z.array(z.string()),
            messageFilter: z.string().optional(),
          }),
          z.object({
            kind: z.literal("gmail"),
            event: z.literal("message_received"),
            from: z.array(z.string()),
            to: z.array(z.string()),
            subjectFilter: z.string().optional(),
            labels: z.array(z.string()),
            hasAttachment: z.boolean(),
          }),
          z.object({
            kind: z.literal("google_calendar"),
            event: z.union([
              z.literal("event_created"),
              z.literal("event_updated"),
              z.literal("event_cancelled"),
              z.literal("event_starting_soon"),
              z.literal("event_ended"),
            ]),
            calendars: z.array(z.string()),
            titleFilter: z.string().optional(),
          }),
          z.object({ kind: z.literal("webhook"), path: z.string() }),
        ]),
        enabled: z.boolean(),
      })
    ),
  ]),
  "mako:search": z.tuple([
    z.string(),
    z
      .object({
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
        threads: z.boolean().optional(),
        scope: z.union([z.literal("workspace"), z.literal("all")]).optional(),
      })
      .optional(),
  ]),
  "mako:select-update-source": z.tuple([z.string()]),
  "mako:set-active-tools": z.tuple([z.array(z.string())]),
  "mako:set-auto-compaction": z.tuple([z.boolean()]),
  "mako:set-badge-count": z.tuple([z.number()]),
  "mako:set-cwd": z.tuple([z.string()]),
  "mako:set-model": z.tuple([z.string(), z.string()]),
  "mako:set-name": z.tuple([z.string()]),
  "mako:set-thinking": z.tuple([
    z.union([
      z.literal("off"),
      z.literal("minimal"),
      z.literal("low"),
      z.literal("medium"),
      z.literal("high"),
      z.literal("xhigh"),
      z.literal("max"),
    ]),
  ]),
  "mako:shutdown-ack": z.tuple([z.string()]),
  "mako:skills-discover": z.tuple([]),
  "mako:skills-remove-preview": z.tuple([
    z.string(),
    z.object({
      provider: z.string(),
      account: z.string(),
      scope: z.union([z.literal("workspace"), z.literal("user")]),
    }),
  ]),
  "mako:skills-resolve": z.tuple([z.array(z.string()), z.string()]),
  "mako:skills-sync-apply": z.tuple([
    z.string(),
    z.array(
      z.object({
        provider: z.string(),
        account: z.string(),
        scope: z.union([z.literal("workspace"), z.literal("user")]),
      })
    ),
  ]),
  "mako:skills-sync-preview": z.tuple([
    z.string(),
    z.object({
      provider: z.string(),
      account: z.string(),
      scope: z.union([z.literal("workspace"), z.literal("user")]),
    }),
  ]),
  "mako:stage-file": z.tuple([z.string(), z.string()]),
  "mako:stage-file-path": z.tuple([z.string()]),
  "mako:terminal-acknowledge": z.tuple([z.string(), z.number()]),
  "mako:terminal-attach": z.tuple([z.string()]),
  "mako:terminal-create": z.tuple([
    z.object({
      cwd: z.string(),
      title: z.string().optional(),
      cols: z.number(),
      rows: z.number(),
    }),
  ]),
  "mako:terminal-detach": z.tuple([z.string()]),
  "mako:terminal-kill": z.tuple([z.string()]),
  "mako:terminal-list": z.tuple([]),
  "mako:terminal-resize": z.tuple([z.string(), z.number(), z.number()]),
  "mako:terminal-write": z.tuple([z.string(), z.string()]),
  "mako:thread-abort-run": z.tuple([z.string()]),
  "mako:thread-archive": z.tuple([
    z.object({
      id: z.string(),
      target: z.union([
        z.object({ kind: z.literal("live"), id: z.string() }),
        z.object({ kind: z.literal("file"), path: z.string() }),
        z.object({
          kind: z.literal("native"),
          provider: z.string(),
          nativeId: z.string(),
        }),
      ]),
      archived: z.boolean(),
    }),
  ]),
  "mako:thread-archives": z.tuple([]),
  "mako:thread-block": z.tuple([
    z.string(),
    z.object({ entry: z.number(), block: z.number() }),
  ]),
  "mako:thread-contexts": z.tuple([
    z.array(z.string()),
    z.object({ inline: z.boolean().optional() }).optional(),
  ]),
  "mako:thread-continuation-plan": z.tuple([z.string()]),
  "mako:thread-continue-with": z.tuple([
    z.string(),
    z.string(),
    z.string().optional(),
    z.union([z.literal("native"), z.literal("transcript")]).optional(),
  ]),
  "mako:thread-controls": z.tuple([
    z.union([
      z.object({ kind: z.literal("live"), id: z.string() }),
      z.object({ kind: z.literal("file"), path: z.string() }),
      z.object({
        kind: z.literal("native"),
        provider: z.string(),
        nativeId: z.string(),
      }),
    ]),
  ]),
  "mako:thread-file": z.tuple([z.string(), z.string()]),
  "mako:thread-follow": z.tuple([z.string(), z.number()]),
  "mako:thread-fork": z.tuple([
    z.string(),
    z.number(),
    z.string(),
    z
      .object({
        index: z.number(),
        id: z.string().optional(),
        at: z.string().optional(),
      })
      .optional(),
  ]),
  "mako:thread-open": z.tuple([z.string()]),
  "mako:thread-page": z.tuple([
    z.string(),
    z.number().optional(),
    z.number().optional(),
  ]),
  "mako:thread-remember-mode": z.tuple([z.string(), z.string()]),
  "mako:thread-run": z.tuple([z.string()]),
  "mako:thread-stop": z.tuple([
    z.union([
      z.object({
        kind: z.literal("live"),
        id: z.string(),
        requestId: z.string(),
      }),
      z.object({
        kind: z.literal("native"),
        path: z.string(),
        token: z.string(),
      }),
    ]),
  ]),
  "mako:thread-unfollow": z.tuple([]),
  "mako:threads": z.tuple([
    z
      .object({ cwd: z.string().optional(), harness: z.string().optional() })
      .optional(),
  ]),
  "mako:unwatch-file": z.tuple([]),
  "mako:update-state": z.tuple([]),
  "mako:usage": z.tuple([]),
  "mako:user-avatar": z.tuple([]),
  "mako:utility-model-catalog": z.tuple([
    z.union([
      z.object({
        source: z.literal("catalog"),
        provider: z.union([
          z.literal("google"),
          z.literal("openai"),
          z.literal("anthropic"),
          z.literal("openai-compatible"),
        ]),
        refresh: z.boolean().optional(),
      }),
      z.intersection(
        z.object({ source: z.literal("provider") }),
        z.object({
          provider: z.union([
            z.literal("google"),
            z.literal("openai"),
            z.literal("anthropic"),
            z.literal("openai-compatible"),
          ]),
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
        })
      ),
    ]),
  ]),
  "mako:utility-model-connect": z.tuple([
    z.object({
      apiKey: z.string().optional(),
      provider: z.union([
        z.literal("google"),
        z.literal("openai"),
        z.literal("anthropic"),
        z.literal("openai-compatible"),
      ]),
      model: z.string(),
      baseUrl: z.string().optional(),
      contextTokens: z.number(),
    }),
  ]),
  "mako:utility-model-disconnect": z.tuple([
    z.union([
      z.literal("google"),
      z.literal("openai"),
      z.literal("anthropic"),
      z.literal("openai-compatible"),
    ]),
  ]),
  "mako:utility-model-settings": z.tuple([]),
  "mako:watch-file": z.tuple([z.string()]),
  "mako:write-plugin": z.tuple([z.string(), z.string()]),
}
