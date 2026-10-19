// Generated from host handler parameter types by scripts/generate-host-inputs.mjs.
// Regenerate after changing a handler's arguments; never edit this table by hand.
import { z } from "zod"

const inputs = {
  "mako:abort": () => z.tuple([]),
  "mako:account-capture": () => z.tuple([z.string(), z.string()]),
  "mako:account-keep": () => z.tuple([z.string(), z.string()]),
  "mako:account-login-cancel": () => z.tuple([z.string()]),
  "mako:account-login-code": () => z.tuple([z.string(), z.string()]),
  "mako:account-login-start": () =>
    z.tuple([z.string(), z.string().optional()]),
  "mako:account-login-wait": () => z.tuple([z.string()]),
  "mako:account-removal-plan": () => z.tuple([z.string(), z.string()]),
  "mako:account-remove": () => z.tuple([z.string(), z.string()]),
  "mako:account-reset": () => z.tuple([z.string(), z.string(), z.string()]),
  "mako:account-select": () =>
    z.tuple([z.string(), z.union([z.null(), z.string()])]),
  "mako:account-usage": () => z.tuple([z.string(), z.string()]),
  "mako:accounts": () => z.tuple([]),
  "mako:activate-tab": () => z.tuple([z.string()]),
  "mako:appshot-capture": () =>
    z.tuple([z.object({ pid: z.number(), windowId: z.number() })]),
  "mako:appshot-feedback": () =>
    z.tuple([
      z.object({
        id: z.string(),
        phase: z.union([
          z.literal("capturing"),
          z.literal("added"),
          z.literal("failed"),
        ]),
        app: z.string(),
        title: z.string(),
        bounds: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional(),
        icon: z.string().optional(),
        thumbnail: z.string().optional(),
        destination: z.string().optional(),
        message: z.string().optional(),
        colors: z
          .object({
            surface: z.string(),
            text: z.string(),
            muted: z.string(),
            border: z.string(),
            font: z.string(),
          })
          .optional(),
      }),
    ]),
  "mako:appshot-front": () =>
    z.tuple([
      z.object({ exclude: z.array(z.number()), front: z.number().optional() }),
    ]),
  "mako:appshot-shortcut": () =>
    z.tuple([
      z.union([
        z.null(),
        z.object({
          kind: z.literal("modifiers"),
          modifier: z.union([
            z.literal("shift"),
            z.literal("command"),
            z.literal("option"),
            z.literal("control"),
          ]),
        }),
        z.object({ kind: z.literal("keys"), chord: z.string() }),
      ]),
    ]),
  "mako:appshot-windows": () => z.tuple([]),
  "mako:automation-enabled": () => z.tuple([z.string(), z.boolean()]),
  "mako:automations": () => z.tuple([]),
  "mako:boot": () => z.tuple([]),
  "mako:browser-control-connect": () => z.tuple([z.string()]),
  "mako:browser-control-disconnect": () => z.tuple([z.string()]),
  "mako:browser-control-prefer": () =>
    z.tuple([z.union([z.null(), z.string()])]),
  "mako:browser-control-status": () => z.tuple([]),
  "mako:browser-extension-setup": () => z.tuple([]),
  "mako:build-update": () => z.tuple([]),
  "mako:capabilities": () => z.tuple([]),
  "mako:change-usage": () => z.tuple([]),
  "mako:chat-folders": () => z.tuple([z.array(z.string())]),
  "mako:check-updates": () => z.tuple([]),
  "mako:checkout-heads": () => z.tuple([z.array(z.string())]),
  "mako:choose-file-reference": () =>
    z.tuple([
      z.object({
        liveId: z.string().min(1).max(200).optional(),
        threadPath: z.string().min(1).max(16_384).optional(),
        asOf: z
          .number()
          .int()
          .nonnegative()
          .max(8_640_000_000_000_000)
          .optional(),
      }),
      z.string().min(1).max(4_096),
      z.string().min(2).max(4_096).startsWith("/"),
    ]),
  "mako:clear-crashes": () => z.tuple([]),
  "mako:clear-queue": () => z.tuple([]),
  "mako:close-tab": () => z.tuple([z.string()]),
  "mako:cloud-account": () => z.tuple([]),
  "mako:cloud-device-remove": () => z.tuple([z.string()]),
  "mako:cloud-devices": () => z.tuple([]),
  "mako:cloud-sign-in": () => z.tuple([]),
  "mako:cloud-sign-in-cancel": () => z.tuple([]),
  "mako:cloud-sign-ins": () => z.tuple([]),
  "mako:cloud-sign-ins-connect": () => z.tuple([z.string()]),
  "mako:cloud-sign-ins-disconnect": () => z.tuple([z.string()]),
  "mako:cloud-sign-ins-share": () => z.tuple([z.boolean()]),
  "mako:cloud-sign-out": () => z.tuple([]),
  "mako:compact": () => z.tuple([z.string().optional()]),
  "mako:computer-driver": () => z.tuple([]),
  "mako:computer-driver-connections": () => z.tuple([]),
  "mako:computer-driver-update": () => z.tuple([]),
  "mako:computer-permissions": () => z.tuple([]),
  "mako:computer-permissions-request": () => z.tuple([]),
  "mako:control-preview": () =>
    z.tuple([
      z.string(),
      z.boolean(),
      z.string(),
      z.object({ width: z.number(), height: z.number() }).optional(),
    ]),
  "mako:control-preview-source": () => z.tuple([z.string()]),
  "mako:control-preview-viewers": () => z.tuple([z.string()]),
  "mako:copy": () => z.tuple([z.string()]),
  "mako:crashes": () => z.tuple([]),
  "mako:crashes-dir": () => z.tuple([]),
  "mako:create-pull": () =>
    z.tuple([
      z.object({
        title: z.string(),
        body: z.string(),
        base: z.string().optional(),
        draft: z.boolean().optional(),
      }),
    ]),
  "mako:create-workspace-text": () =>
    z.tuple([z.string(), z.string(), z.string()]),
  "mako:daemon-login": () => z.tuple([]),
  "mako:daemon-login-set": () => z.tuple([z.boolean()]),
  "mako:daemon-status": () => z.tuple([]),
  "mako:default-commit-prompt": () => z.tuple([]),
  "mako:delete-plugin": () => z.tuple([z.string()]),
  "mako:element-pick-cancel": () => z.tuple([z.string()]),
  "mako:element-pick-start": () =>
    z.tuple([
      z.union([
        z.object({
          id: z.string(),
          target: z.object({ browser: z.string(), tab: z.string() }),
        }),
        z.object({ id: z.string(), conversation: z.string() }),
      ]),
    ]),
  "mako:element-pick-targets": () => z.tuple([]),
  "mako:element-pick-wait": () => z.tuple([z.string(), z.number()]),
  "mako:external-editors": () => z.tuple([]),
  "mako:fork": () =>
    z.tuple([
      z.string(),
      z.union([z.literal("before"), z.literal("at")]).optional(),
    ]),
  "mako:git-cancel-generation": () => z.tuple([z.string()]),
  "mako:git-changed-since": () => z.tuple([z.string()]),
  "mako:git-commit": () =>
    z.tuple([
      z.string(),
      z.object({ amend: z.boolean().optional() }).optional(),
    ]),
  "mako:git-commit-diff-all": () => z.tuple([z.string()]),
  "mako:git-commit-file-diff": () => z.tuple([z.string(), z.string()]),
  "mako:git-commit-files": () => z.tuple([z.string()]),
  "mako:git-default-branch": () => z.tuple([]),
  "mako:git-diff": () => z.tuple([z.string()]),
  "mako:git-diff-all": () => z.tuple([]),
  "mako:git-discard": () => z.tuple([z.array(z.string())]),
  "mako:git-doctor": () => z.tuple([z.string()]),
  "mako:git-generate-message": () =>
    z.tuple([
      z.object({
        mode: z.union([z.literal("fast"), z.literal("deep")]).optional(),
        requestId: z.string(),
        cwd: z.string(),
        prompt: z.string().optional(),
        model: z.string().optional(),
      }),
    ]),
  "mako:git-log": () => z.tuple([z.number().optional()]),
  "mako:git-push": () =>
    z.tuple([z.object({ cwd: z.string(), branch: z.string() })]),
  "mako:git-remote": () =>
    z.tuple([
      z.object({
        head: z.string().optional(),
        action: z.union([
          z.literal("abort"),
          z.literal("merge"),
          z.literal("fetch"),
          z.literal("pull"),
          z.literal("continue"),
          z.literal("merge_autostash"),
        ]),
        cwd: z.string(),
        branch: z.string(),
      }),
    ]),
  "mako:git-restore-discarded": () => z.tuple([z.string()]),
  "mako:git-select-repository": () => z.tuple([z.string(), z.string()]),
  "mako:git-since-diff": () => z.tuple([z.string(), z.string()]),
  "mako:git-stage": () => z.tuple([z.array(z.string())]),
  "mako:git-stage-all": () => z.tuple([]),
  "mako:git-status": () => z.tuple([]),
  "mako:git-unstage": () => z.tuple([z.array(z.string())]),
  "mako:git-unstage-all": () => z.tuple([]),
  "mako:github-status": () => z.tuple([]),
  "mako:harness-availability": () => z.tuple([]),
  "mako:harness-descriptors": () => z.tuple([]),
  "mako:harness-install": () => z.tuple([z.string()]),
  "mako:harness-order": () => z.tuple([z.array(z.string())]),
  "mako:harness-order-saved": () => z.tuple([]),
  "mako:harness-profiles": () => z.tuple([z.boolean().optional()]),
  "mako:harness-start": () =>
    z.tuple([
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
  "mako:harness-tuning": () =>
    z.tuple([z.string(), z.string().optional(), z.boolean().optional()]),
  "mako:harness-update": () => z.tuple([z.string()]),
  "mako:harness-updates": () => z.tuple([z.boolean().optional()]),
  "mako:host-log-path": () => z.tuple([]),
  "mako:install-update": () => z.tuple([]),
  "mako:installation-state": () => z.tuple([]),
  "mako:integrations": () => z.tuple([]),
  "mako:launch-prewarm": () => z.tuple([z.string()]),
  "mako:lifecycle-command": () =>
    z.tuple([
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
  "mako:lifecycle-state": () => z.tuple([]),
  "mako:list-files": () => z.tuple([]),
  "mako:list-models": () => z.tuple([]),
  "mako:list-plugins": () => z.tuple([]),
  "mako:list-sessions": () =>
    z.tuple([
      z.string().optional(),
      z.union([z.literal("workspace"), z.literal("all")]).optional(),
    ]),
  "mako:live-action": () =>
    z.tuple([
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
              size: z.number().optional(),
              data: z.string().optional(),
              path: z.string().optional(),
            })
          ),
          displayText: z.string().optional(),
        }),
        z.object({
          kind: z.literal("steer-queued"),
          id: z.string(),
          requestId: z.string(),
          queuedRequestId: z.string(),
          text: z.string(),
          attachments: z.array(
            z.object({
              name: z.string(),
              mimeType: z.string(),
              size: z.number().optional(),
              data: z.string().optional(),
              path: z.string().optional(),
            })
          ),
          displayText: z.string().optional(),
        }),
        z.object({
          kind: z.literal("compact"),
          id: z.string(),
          requestId: z.string().optional(),
        }),
      ]),
    ]),
  "mako:live-action-acknowledge": () => z.tuple([z.string(), z.string()]),
  "mako:live-attach": () => z.tuple([z.string()]),
  "mako:live-bind": () => z.tuple([z.string(), z.string()]),
  "mako:live-cancel": () => z.tuple([z.string()]),
  "mako:live-capture": () => z.tuple([z.string(), z.string()]),
  "mako:live-clear-queue": () => z.tuple([z.string()]),
  "mako:live-close": () => z.tuple([z.string()]),
  "mako:live-context-breakdown": () => z.tuple([z.string()]),
  "mako:live-continue": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.string(),
      z.string(),
      z
        .array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
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
  "mako:live-earlier": () => z.tuple([z.string()]),
  "mako:live-edit-queued": () =>
    z.tuple([
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
  "mako:live-fork": () =>
    z.tuple([
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
                at: z.number().optional(),
              })
              .optional(),
          }),
        ]),
        thread: z.union([z.literal("new"), z.literal("parent")]).optional(),
        worktree: z.boolean().optional(),
        move: z.boolean().optional(),
      }),
    ]),
  "mako:live-goal": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({
          kind: z.literal("set"),
          objective: z.string(),
          tokenBudget: z.number().optional(),
        }),
        z.object({ kind: z.literal("pause") }),
        z.object({ kind: z.literal("resume") }),
        z.object({ kind: z.literal("clear") }),
      ]),
      z
        .object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        })
        .optional(),
    ]),
  "mako:live-locate": () => z.tuple([z.string(), z.string()]),
  "mako:live-merge-fork": () => z.tuple([z.string(), z.string()]),
  "mako:live-mode": () => z.tuple([z.string(), z.string()]),
  "mako:live-permission": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.union([
        z.object({
          kind: z.literal("choice"),
          optionId: z.union([z.null(), z.string()]),
          feedback: z.string().trim().min(1).optional(),
        }),
        z.object({
          kind: z.literal("answers"),
          answers: z.record(z.string(), z.array(z.string())),
        }),
      ]),
    ]),
  "mako:live-prewarm": () => z.tuple([z.string()]),
  "mako:live-prompt": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.string(),
      z
        .array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
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
  "mako:live-read": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({
          kind: z.literal("snapshot"),
          from: z.object({ blocks: z.number(), base: z.number() }).optional(),
          epoch: z.string().optional(),
          ifCurrent: z
            .object({ token: z.string(), revision: z.number() })
            .optional(),
        }),
        z.object({
          kind: z.literal("earlier"),
          token: z.string(),
          before: z.object({ blocks: z.number(), base: z.number() }),
        }),
        z.object({
          kind: z.literal("range"),
          token: z.string(),
          from: z.object({ blocks: z.number(), base: z.number() }),
          to: z.object({ blocks: z.number(), base: z.number() }),
        }),
        z.object({
          kind: z.literal("detail"),
          token: z.string(),
          at: z.union([
            z.object({ kind: z.literal("live"), index: z.number() }),
            z.object({ kind: z.literal("base"), id: z.string() }),
          ]),
        }),
        z.object({
          kind: z.literal("original"),
          token: z.string(),
          at: z.union([
            z.object({ kind: z.literal("live"), index: z.number() }),
            z.object({ kind: z.literal("base"), id: z.string() }),
          ]),
        }),
        z.object({
          kind: z.literal("part"),
          record: z.string(),
          offset: z.number(),
        }),
      ]),
    ]),
  "mako:live-review": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({ kind: z.literal("changes") }),
        z.object({ kind: z.literal("branch"), base: z.string() }),
        z.object({
          kind: z.literal("commit"),
          sha: z.string(),
          title: z.string().optional(),
        }),
      ]),
      z
        .object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        })
        .optional(),
    ]),
  "mako:live-rewind": () =>
    z.tuple([
      z.string(),
      z.object({
        id: z.string(),
        requestId: z.string(),
        expectedId: z.string(),
        position: z.union([z.literal("before"), z.literal("after")]).optional(),
      }),
    ]),
  "mako:live-rewind-preview": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.union([z.literal("before"), z.literal("after")]).optional(),
    ]),
  "mako:live-rewind-recover": () => z.tuple([]),
  "mako:live-side-question": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({ kind: z.literal("ask"), question: z.string() }),
        z.object({ kind: z.literal("stop") }),
        z.object({ kind: z.literal("close") }),
      ]),
    ]),
  "mako:live-sign-in-readiness": () => z.tuple([z.string()]),
  "mako:live-sign-in-resume": () => z.tuple([z.string(), z.boolean()]),
  "mako:live-snapshot": () => z.tuple([z.string()]),
  "mako:live-start": () =>
    z.tuple([
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
                size: z.number().optional(),
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
        launchModeId: z.string().optional(),
        tuning: z
          .object({
            model: z.string().optional(),
            options: z
              .record(z.string(), z.union([z.boolean(), z.string()]))
              .optional(),
          })
          .optional(),
        session: z.string().optional(),
        worktree: z.boolean().optional(),
        worktreeStart: z
          .union([
            z.object({ kind: z.literal("from"), ref: z.string() }),
            z.object({ kind: z.literal("branch"), branch: z.string() }),
            z.object({
              kind: z.literal("pull"),
              number: z.number(),
              branch: z.string(),
              cross: z.boolean(),
            }),
          ])
          .optional(),
        purpose: z.literal("setup").optional(),
        goal: z
          .object({ objective: z.string(), tokenBudget: z.number().optional() })
          .optional(),
        review: z
          .union([
            z.object({ kind: z.literal("changes") }),
            z.object({ kind: z.literal("branch"), base: z.string() }),
            z.object({
              kind: z.literal("commit"),
              sha: z.string(),
              title: z.string().optional(),
            }),
          ])
          .optional(),
        cloud: z
          .object({
            repository: z
              .object({ url: z.string(), branch: z.string().optional() })
              .optional(),
          })
          .optional(),
      }),
    ]),
  "mako:live-state": () => z.tuple([z.string()]),
  "mako:live-steer-queued": () =>
    z.tuple([
      z.string(),
      z.object({
        kind: z.literal("steer-queued"),
        id: z.string(),
        requestId: z.string(),
        queuedRequestId: z.string(),
        text: z.string(),
        attachments: z.array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
            data: z.string().optional(),
            path: z.string().optional(),
          })
        ),
        displayText: z.string().optional(),
      }),
    ]),
  "mako:live-stop-agent": () => z.tuple([z.string(), z.string()]),
  "mako:live-transfer": () =>
    z.tuple([
      z.string(),
      z.object({
        id: z.string(),
        provider: z.string(),
        text: z.string(),
        attachments: z.array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
            data: z.string().optional(),
            path: z.string().optional(),
          })
        ),
        bindingId: z.string().optional(),
        displayText: z.string().optional(),
        tuning: z
          .object({
            model: z.string().optional(),
            options: z
              .record(z.string(), z.union([z.boolean(), z.string()]))
              .optional(),
          })
          .optional(),
        modeId: z.string().optional(),
        carry: z
          .union([z.literal("native"), z.literal("transcript")])
          .optional(),
      }),
    ]),
  "mako:live-turn-changes": () => z.tuple([z.string(), z.string()]),
  "mako:live-turn-diff": () => z.tuple([z.string(), z.string(), z.string()]),
  "mako:lost-versions": () =>
    z.tuple([
      z.union([
        z.object({ thread: z.string() }),
        z.object({ path: z.string() }),
      ]),
    ]),
  "mako:machine-woke": () =>
    z.tuple([z.union([z.literal("resume"), z.literal("unlock-screen")])]),
  "mako:mcp-discover": () => z.tuple([]),
  "mako:mcp-sync-apply": () =>
    z.tuple([
      z.string(),
      z.object({
        provider: z.string(),
        account: z.string(),
        scope: z.union([z.literal("workspace"), z.literal("user")]),
      }),
    ]),
  "mako:mcp-sync-preview": () =>
    z.tuple([
      z.string(),
      z.object({
        provider: z.string(),
        account: z.string(),
        scope: z.union([z.literal("workspace"), z.literal("user")]),
      }),
    ]),
  "mako:merge-pull": () =>
    z.tuple([
      z.union([z.literal("merge"), z.literal("squash"), z.literal("rebase")]),
    ]),
  "mako:native-authoring-apply": () =>
    z.tuple([
      z.object({
        provider: z.string(),
        family: z.union([
          z.literal("hooks"),
          z.literal("commands"),
          z.literal("mcp"),
        ]),
        cwd: z.string(),
      }),
      z.union([
        z.object({
          kind: z.literal("create"),
          sourceId: z.string(),
          draft: z.union([
            z.object({
              kind: z.literal("hook"),
              event: z.string(),
              matcher: z.string().optional(),
              type: z.string(),
              run: z.string(),
              timeout: z.number().optional(),
            }),
            z.object({
              kind: z.literal("command"),
              invocation: z.string(),
              text: z.string(),
            }),
            z.object({
              kind: z.literal("module"),
              name: z.string(),
              text: z.string(),
            }),
          ]),
        }),
        z.object({
          kind: z.literal("edit"),
          entryId: z.string(),
          draft: z.union([
            z.object({
              kind: z.literal("hook"),
              event: z.string(),
              matcher: z.string().optional(),
              type: z.string(),
              run: z.string(),
              timeout: z.number().optional(),
            }),
            z.object({
              kind: z.literal("command"),
              invocation: z.string(),
              text: z.string(),
            }),
            z.object({
              kind: z.literal("module"),
              name: z.string(),
              text: z.string(),
            }),
          ]),
        }),
        z.object({
          kind: z.literal("enable"),
          entryId: z.string(),
          enabled: z.boolean(),
        }),
        z.object({ kind: z.literal("remove"), entryId: z.string() }),
        z.object({ kind: z.literal("trust"), entryId: z.string() }),
      ]),
      z.union([z.null(), z.string()]),
    ]),
  "mako:native-authoring-catalog": () => z.tuple([]),
  "mako:native-authoring-preview": () =>
    z.tuple([
      z.object({
        provider: z.string(),
        family: z.union([
          z.literal("hooks"),
          z.literal("commands"),
          z.literal("mcp"),
        ]),
        cwd: z.string(),
      }),
      z.union([
        z.object({
          kind: z.literal("create"),
          sourceId: z.string(),
          draft: z.union([
            z.object({
              kind: z.literal("hook"),
              event: z.string(),
              matcher: z.string().optional(),
              type: z.string(),
              run: z.string(),
              timeout: z.number().optional(),
            }),
            z.object({
              kind: z.literal("command"),
              invocation: z.string(),
              text: z.string(),
            }),
            z.object({
              kind: z.literal("module"),
              name: z.string(),
              text: z.string(),
            }),
          ]),
        }),
        z.object({
          kind: z.literal("edit"),
          entryId: z.string(),
          draft: z.union([
            z.object({
              kind: z.literal("hook"),
              event: z.string(),
              matcher: z.string().optional(),
              type: z.string(),
              run: z.string(),
              timeout: z.number().optional(),
            }),
            z.object({
              kind: z.literal("command"),
              invocation: z.string(),
              text: z.string(),
            }),
            z.object({
              kind: z.literal("module"),
              name: z.string(),
              text: z.string(),
            }),
          ]),
        }),
        z.object({
          kind: z.literal("enable"),
          entryId: z.string(),
          enabled: z.boolean(),
        }),
        z.object({ kind: z.literal("remove"), entryId: z.string() }),
        z.object({ kind: z.literal("trust"), entryId: z.string() }),
      ]),
    ]),
  "mako:native-authoring-view": () =>
    z.tuple([
      z.object({
        provider: z.string(),
        family: z.union([
          z.literal("hooks"),
          z.literal("commands"),
          z.literal("mcp"),
        ]),
        cwd: z.string(),
      }),
    ]),
  "mako:native-dismiss": () => z.tuple([z.string()]),
  "mako:native-edit-queued": () =>
    z.tuple([
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
  "mako:native-receipt": () => z.tuple([z.string()]),
  "mako:native-requests": () => z.tuple([]),
  "mako:native-submit": () =>
    z.tuple([
      z.object({
        id: z.string(),
        path: z.string(),
        text: z.string(),
        attachments: z.array(
          z.object({
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
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
  "mako:navigate-tree": () => z.tuple([z.string()]),
  "mako:new-session": () => z.tuple([]),
  "mako:notification-permission": () => z.tuple([]),
  "mako:notify": () =>
    z.tuple([
      z.object({
        id: z.string(),
        subject: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        body: z.string(),
        silent: z.boolean(),
      }),
    ]),
  "mako:notify-dismiss": () => z.tuple([z.string()]),
  "mako:open-in-editor": () => z.tuple([z.string(), z.string().optional()]),
  "mako:open-preview-window": () => z.tuple([]),
  "mako:open-session": () => z.tuple([z.string()]),
  "mako:open-tab": () =>
    z.tuple([
      z
        .object({
          cwd: z.string().optional(),
          sessionPath: z.string().optional(),
        })
        .optional(),
    ]),
  "mako:open-url": () => z.tuple([z.string()]),
  "mako:pick-folder": () => z.tuple([]),
  "mako:plan-build-claim": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({
        conversation: z.string().optional(),
        thread: z.string().optional(),
      }),
      z.union([z.null(), z.number()]),
    ]),
  "mako:plan-build-record": () =>
    z.tuple([
      z.string(),
      z.object({
        at: z.number(),
        conversation: z.string().optional(),
        thread: z.string().optional(),
      }),
    ]),
  "mako:plan-build-release": () => z.tuple([z.string()]),
  "mako:plan-builds": () => z.tuple([]),
  "mako:plugins-dir": () => z.tuple([]),
  "mako:project-app-setup": () => z.tuple([z.string()]),
  "mako:prompt": () =>
    z.tuple([
      z.string(),
      z.union([z.literal("steer"), z.literal("followUp")]).optional(),
      z.array(z.object({ mimeType: z.string(), data: z.string() })).optional(),
    ]),
  "mako:provider-connection-action": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({ kind: z.literal("refresh") }),
        z.object({ kind: z.literal("sign-in-browser") }),
        z.object({ kind: z.literal("sign-in-key"), apiKey: z.string() }),
        z.object({ kind: z.literal("sign-out") }),
      ]),
    ]),
  "mako:provider-connections": () => z.tuple([z.boolean().optional()]),
  "mako:provider-residency": () => z.tuple([]),
  "mako:pull-branches": () => z.tuple([]),
  "mako:pull-request": () => z.tuple([]),
  "mako:pull-request-search": () =>
    z.tuple([
      z.object({ query: z.string().optional(), limit: z.number().optional() }),
    ]),
  "mako:pull-requests": () => z.tuple([z.number().optional()]),
  "mako:quit-client": () => z.tuple([]),
  "mako:read-file": () => z.tuple([z.string()]),
  "mako:read-live-file": () => z.tuple([z.string(), z.string()]),
  "mako:relaunch": () => z.tuple([]),
  "mako:reload-automations": () => z.tuple([]),
  "mako:repo-avatar": () => z.tuple([z.string()]),
  "mako:report-crash": () =>
    z.tuple([
      z.union([z.literal("renderer-error"), z.literal("renderer-rejection")]),
      z.object({
        message: z.string(),
        stack: z.string().optional(),
        source: z.string().optional(),
      }),
    ]),
  "mako:request-notification-permission": () => z.tuple([]),
  "mako:rerun-checks": () => z.tuple([]),
  "mako:resolve-file-references": () =>
    z.tuple([
      z.object({
        liveId: z.string().min(1).max(200).optional(),
        threadPath: z.string().min(1).max(16_384).optional(),
        asOf: z
          .number()
          .int()
          .nonnegative()
          .max(8_640_000_000_000_000)
          .optional(),
      }),
      z.array(z.string().min(1).max(4_096)).max(400),
    ]),
  "mako:restore-version": () => z.tuple([z.string(), z.number()]),
  "mako:reveal": () => z.tuple([z.string()]),
  "mako:reveal-plugins": () => z.tuple([]),
  "mako:run-automation": () => z.tuple([z.string()]),
  "mako:run-command": () => z.tuple([z.string(), z.string().optional()]),
  "mako:save-automations": () =>
    z.tuple([
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
  "mako:search": () =>
    z.tuple([
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
  "mako:select-update-source": () => z.tuple([z.string()]),
  "mako:set-active-tools": () => z.tuple([z.array(z.string())]),
  "mako:set-auto-compaction": () => z.tuple([z.boolean()]),
  "mako:set-badge-count": () => z.tuple([z.number()]),
  "mako:set-cwd": () => z.tuple([z.string()]),
  "mako:set-model": () => z.tuple([z.string(), z.string()]),
  "mako:set-name": () => z.tuple([z.string()]),
  "mako:set-thinking": () =>
    z.tuple([
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
  "mako:shutdown-ack": () => z.tuple([z.string()]),
  "mako:skills-discover": () => z.tuple([]),
  "mako:skills-remove-preview": () =>
    z.tuple([
      z.string(),
      z.object({
        provider: z.string(),
        account: z.string(),
        scope: z.union([z.literal("workspace"), z.literal("user")]),
      }),
    ]),
  "mako:skills-resolve": () => z.tuple([z.array(z.string()), z.string()]),
  "mako:skills-sync-apply": () =>
    z.tuple([
      z.string(),
      z.array(
        z.object({
          provider: z.string(),
          account: z.string(),
          scope: z.union([z.literal("workspace"), z.literal("user")]),
        })
      ),
    ]),
  "mako:skills-sync-preview": () =>
    z.tuple([
      z.string(),
      z.object({
        provider: z.string(),
        account: z.string(),
        scope: z.union([z.literal("workspace"), z.literal("user")]),
      }),
    ]),
  "mako:stage-file": () => z.tuple([z.string(), z.string()]),
  "mako:stage-file-path": () => z.tuple([z.string()]),
  "mako:store-formats": () => z.tuple([]),
  "mako:surface-window": () => z.tuple([]),
  "mako:telemetry": () => z.tuple([]),
  "mako:telemetry-choose": () =>
    z.tuple([
      z.object({
        usage: z.boolean().optional(),
        errors: z.boolean().optional(),
      }),
    ]),
  "mako:terminal-acknowledge": () => z.tuple([z.string(), z.number()]),
  "mako:terminal-attach": () => z.tuple([z.string()]),
  "mako:terminal-create": () =>
    z.tuple([
      z.object({
        cwd: z.string(),
        title: z.string().optional(),
        cols: z.number(),
        rows: z.number(),
      }),
    ]),
  "mako:terminal-detach": () => z.tuple([z.string()]),
  "mako:terminal-kill": () => z.tuple([z.string()]),
  "mako:terminal-list": () => z.tuple([]),
  "mako:terminal-resize": () => z.tuple([z.string(), z.number(), z.number()]),
  "mako:terminal-write": () => z.tuple([z.string(), z.string()]),
  "mako:thread-abort-run": () => z.tuple([z.string()]),
  "mako:thread-app": () => z.tuple([z.string(), z.string().optional()]),
  "mako:thread-app-check": () =>
    z.tuple([
      z.string(),
      z.union([z.literal("full"), z.literal("quick")]),
      z.string().optional(),
      z.array(z.string()).optional(),
    ]),
  "mako:thread-app-make-room": () =>
    z.tuple([z.string(), z.string().optional()]),
  "mako:thread-app-marks": () => z.tuple([]),
  "mako:thread-app-output": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({ file: z.string(), offset: z.number() }).optional(),
    ]),
  "mako:thread-app-probe": () => z.tuple([z.string()]),
  "mako:thread-app-restart": () => z.tuple([z.string(), z.string().optional()]),
  "mako:thread-app-room": () => z.tuple([]),
  "mako:thread-app-start": () => z.tuple([z.string(), z.string().optional()]),
  "mako:thread-app-stop": () => z.tuple([z.string()]),
  "mako:thread-app-stop-apps": () => z.tuple([z.array(z.string())]),
  "mako:thread-app-take-turn": () =>
    z.tuple([z.string(), z.string().optional()]),
  "mako:thread-archive": () =>
    z.tuple([
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
  "mako:thread-archives": () => z.tuple([]),
  "mako:thread-changes": () => z.tuple([z.string()]),
  "mako:thread-child-follow": () => z.tuple([z.string(), z.number()]),
  "mako:thread-child-unfollow": () => z.tuple([]),
  "mako:thread-children": () => z.tuple([z.string()]),
  "mako:thread-contexts": () =>
    z.tuple([
      z.array(z.string()),
      z
        .object({
          inline: z.boolean().optional(),
          children: z.boolean().optional(),
        })
        .optional(),
    ]),
  "mako:thread-continuation-plan": () => z.tuple([z.string()]),
  "mako:thread-continuation-resolve": () => z.tuple([z.string()]),
  "mako:thread-continue-with": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.string().optional(),
      z.union([z.literal("native"), z.literal("transcript")]).optional(),
    ]),
  "mako:thread-controls": () =>
    z.tuple([
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
  "mako:thread-create-session": () => z.tuple([z.string(), z.string()]),
  "mako:thread-entry": () => z.tuple([z.string(), z.string()]),
  "mako:thread-file": () => z.tuple([z.string(), z.string()]),
  "mako:thread-follow": () => z.tuple([z.string(), z.number()]),
  "mako:thread-fork": () =>
    z.tuple([
      z.string(),
      z.number(),
      z.string(),
      z
        .object({
          index: z.number(),
          id: z.string().optional(),
          at: z.number().optional(),
        })
        .optional(),
    ]),
  "mako:thread-groups": () => z.tuple([]),
  "mako:thread-open": () => z.tuple([z.string()]),
  "mako:thread-original": () => z.tuple([z.string(), z.string()]),
  "mako:thread-owner-resolve": () => z.tuple([z.string()]),
  "mako:thread-page": () =>
    z.tuple([z.string(), z.number().optional(), z.number().optional()]),
  "mako:thread-preview": () => z.tuple([z.string()]),
  "mako:thread-purposes": () => z.tuple([]),
  "mako:thread-remember-mode": () => z.tuple([z.string(), z.string()]),
  "mako:thread-rename": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.union([z.null(), z.string()]),
      z.string().optional(),
    ]),
  "mako:thread-run": () => z.tuple([z.string()]),
  "mako:thread-stop": () =>
    z.tuple([
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
  "mako:thread-titles": () => z.tuple([]),
  "mako:thread-titles-import": () =>
    z.tuple([z.array(z.object({ thread: z.string(), title: z.string() }))]),
  "mako:thread-unfollow": () => z.tuple([]),
  "mako:threads": () =>
    z.tuple([
      z
        .object({ cwd: z.string().optional(), harness: z.string().optional() })
        .optional(),
    ]),
  "mako:transcript-document": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("live"), id: z.string() }),
        z.object({ kind: z.literal("file"), path: z.string() }),
      ]),
      z.union([z.literal("full"), z.literal("concise")]),
    ]),
  "mako:unwatch-file": () => z.tuple([]),
  "mako:update-state": () => z.tuple([]),
  "mako:usage": () => z.tuple([]),
  "mako:user-avatar": () => z.tuple([]),
  "mako:utility-choice": () => z.tuple([z.string(), z.string()]),
  "mako:utility-model-catalog": () =>
    z.tuple([
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
  "mako:utility-model-connect": () =>
    z.tuple([
      z.object({
        apiKey: z.string().optional(),
        provider: z.union([
          z.literal("google"),
          z.literal("openai"),
          z.literal("anthropic"),
          z.literal("openai-compatible"),
        ]),
        model: z.string(),
        name: z.string().optional(),
        baseUrl: z.string().optional(),
        contextTokens: z.number(),
      }),
    ]),
  "mako:utility-model-disconnect": () =>
    z.tuple([
      z.union([
        z.literal("google"),
        z.literal("openai"),
        z.literal("anthropic"),
        z.literal("openai-compatible"),
      ]),
    ]),
  "mako:utility-model-settings": () => z.tuple([]),
  "mako:watch-file": () => z.tuple([z.string()]),
  "mako:workspace-move-answer": () =>
    z.tuple([
      z.string(),
      z.union([z.literal("allow"), z.literal("always"), z.literal("deny")]),
    ]),
  "mako:workspace-move-bring": () => z.tuple([z.string(), z.boolean()]),
  "mako:workspace-move-bring-stayed": () => z.tuple([z.string()]),
  "mako:workspace-move-forget": () => z.tuple([z.string()]),
  "mako:workspace-move-hold": () =>
    z.tuple([
      z.object({
        thread: z.string(),
        cwd: z.string(),
        conversation: z.string().optional(),
      }),
    ]),
  "mako:workspace-move-outcome": () => z.tuple([z.string()]),
  "mako:workspace-move-put-back": () =>
    z.tuple([z.string(), z.array(z.string().min(1)).min(1).max(1_000)]),
  "mako:workspace-moves": () => z.tuple([]),
  "mako:worktree-ahead": () => z.tuple([z.string()]),
  "mako:worktree-branches": () => z.tuple([z.string()]),
  "mako:worktree-inventory": () => z.tuple([]),
  "mako:worktree-merge": () => z.tuple([z.string()]),
  "mako:worktree-pulls": () => z.tuple([z.string()]),
  "mako:worktree-removal": () => z.tuple([z.string()]),
  "mako:worktree-remove": () => z.tuple([z.string()]),
  "mako:worktree-review": () => z.tuple([z.string()]),
  "mako:worktree-review-diffs": () => z.tuple([z.string()]),
  "mako:worktree-skip": () => z.tuple([z.string()]),
  "mako:worktree-start-point": () => z.tuple([z.string(), z.boolean()]),
  "mako:worktree-summaries": () => z.tuple([]),
  "mako:worktree-update": () => z.tuple([z.string()]),
  "mako:worktree-want": () => z.tuple([z.string()]),
  "mako:worktrees": () => z.tuple([]),
  "mako:write-plugin": () => z.tuple([z.string(), z.string()]),
}

export type HostChannel = keyof typeof inputs
export type HostCallInput<Channel extends HostChannel> = ReturnType<
  (typeof inputs)[Channel]
>
export type HostArguments<Channel extends HostChannel> = z.output<
  HostCallInput<Channel>
>

/** A domain of the host that declares methods. */
export type HostMethodDomain =
  | "application"
  | "attribution"
  | "control"
  | "conversations"
  | "git"
  | "harnesses"
  | "terminals"
  | "threads"
  | "tools"
  | "usage"
  | "workspaces"

const domains = new Map<HostChannel, HostMethodDomain>([
  ["mako:abort", "workspaces"],
  ["mako:account-capture", "harnesses"],
  ["mako:account-keep", "harnesses"],
  ["mako:account-login-cancel", "harnesses"],
  ["mako:account-login-code", "harnesses"],
  ["mako:account-login-start", "harnesses"],
  ["mako:account-login-wait", "harnesses"],
  ["mako:account-removal-plan", "harnesses"],
  ["mako:account-remove", "harnesses"],
  ["mako:account-reset", "harnesses"],
  ["mako:account-select", "harnesses"],
  ["mako:account-usage", "harnesses"],
  ["mako:accounts", "harnesses"],
  ["mako:activate-tab", "workspaces"],
  ["mako:appshot-capture", "control"],
  ["mako:appshot-front", "control"],
  ["mako:appshot-windows", "control"],
  ["mako:automation-enabled", "workspaces"],
  ["mako:automations", "workspaces"],
  ["mako:boot", "workspaces"],
  ["mako:browser-control-connect", "control"],
  ["mako:browser-control-disconnect", "control"],
  ["mako:browser-control-prefer", "control"],
  ["mako:browser-control-status", "control"],
  ["mako:browser-extension-setup", "control"],
  ["mako:build-update", "application"],
  ["mako:capabilities", "workspaces"],
  ["mako:change-usage", "attribution"],
  ["mako:chat-folders", "threads"],
  ["mako:check-updates", "application"],
  ["mako:checkout-heads", "workspaces"],
  ["mako:choose-file-reference", "attribution"],
  ["mako:clear-crashes", "application"],
  ["mako:clear-queue", "workspaces"],
  ["mako:close-tab", "workspaces"],
  ["mako:cloud-account", "usage"],
  ["mako:cloud-device-remove", "usage"],
  ["mako:cloud-devices", "usage"],
  ["mako:cloud-sign-in", "usage"],
  ["mako:cloud-sign-in-cancel", "usage"],
  ["mako:cloud-sign-ins", "usage"],
  ["mako:cloud-sign-ins-connect", "usage"],
  ["mako:cloud-sign-ins-disconnect", "usage"],
  ["mako:cloud-sign-ins-share", "usage"],
  ["mako:cloud-sign-out", "usage"],
  ["mako:compact", "workspaces"],
  ["mako:computer-driver", "control"],
  ["mako:computer-driver-connections", "control"],
  ["mako:computer-driver-update", "control"],
  ["mako:computer-permissions", "control"],
  ["mako:computer-permissions-request", "control"],
  ["mako:control-preview", "control"],
  ["mako:control-preview-source", "control"],
  ["mako:control-preview-viewers", "control"],
  ["mako:crashes", "application"],
  ["mako:crashes-dir", "application"],
  ["mako:create-pull", "git"],
  ["mako:create-workspace-text", "workspaces"],
  ["mako:daemon-login", "threads"],
  ["mako:daemon-login-set", "threads"],
  ["mako:daemon-status", "threads"],
  ["mako:default-commit-prompt", "git"],
  ["mako:delete-plugin", "tools"],
  ["mako:element-pick-cancel", "control"],
  ["mako:element-pick-start", "control"],
  ["mako:element-pick-targets", "control"],
  ["mako:element-pick-wait", "control"],
  ["mako:external-editors", "workspaces"],
  ["mako:fork", "workspaces"],
  ["mako:git-cancel-generation", "git"],
  ["mako:git-changed-since", "git"],
  ["mako:git-commit", "git"],
  ["mako:git-commit-diff-all", "git"],
  ["mako:git-commit-file-diff", "git"],
  ["mako:git-commit-files", "git"],
  ["mako:git-default-branch", "git"],
  ["mako:git-diff", "git"],
  ["mako:git-diff-all", "git"],
  ["mako:git-discard", "git"],
  ["mako:git-doctor", "git"],
  ["mako:git-generate-message", "git"],
  ["mako:git-log", "git"],
  ["mako:git-push", "git"],
  ["mako:git-remote", "git"],
  ["mako:git-restore-discarded", "git"],
  ["mako:git-select-repository", "git"],
  ["mako:git-since-diff", "git"],
  ["mako:git-stage", "git"],
  ["mako:git-stage-all", "git"],
  ["mako:git-status", "git"],
  ["mako:git-unstage", "git"],
  ["mako:git-unstage-all", "git"],
  ["mako:github-status", "git"],
  ["mako:harness-availability", "harnesses"],
  ["mako:harness-descriptors", "harnesses"],
  ["mako:harness-install", "harnesses"],
  ["mako:harness-order", "git"],
  ["mako:harness-order-saved", "git"],
  ["mako:harness-profiles", "harnesses"],
  ["mako:harness-start", "conversations"],
  ["mako:harness-tuning", "harnesses"],
  ["mako:harness-update", "harnesses"],
  ["mako:harness-updates", "harnesses"],
  ["mako:host-log-path", "application"],
  ["mako:install-update", "application"],
  ["mako:installation-state", "application"],
  ["mako:integrations", "tools"],
  ["mako:launch-prewarm", "tools"],
  ["mako:lifecycle-command", "application"],
  ["mako:lifecycle-state", "application"],
  ["mako:list-files", "workspaces"],
  ["mako:list-models", "workspaces"],
  ["mako:list-plugins", "tools"],
  ["mako:list-sessions", "workspaces"],
  ["mako:live-action", "conversations"],
  ["mako:live-action-acknowledge", "conversations"],
  ["mako:live-attach", "conversations"],
  ["mako:live-bind", "conversations"],
  ["mako:live-cancel", "conversations"],
  ["mako:live-capture", "conversations"],
  ["mako:live-clear-queue", "conversations"],
  ["mako:live-close", "conversations"],
  ["mako:live-context-breakdown", "conversations"],
  ["mako:live-continue", "conversations"],
  ["mako:live-earlier", "conversations"],
  ["mako:live-edit-queued", "conversations"],
  ["mako:live-fork", "conversations"],
  ["mako:live-goal", "conversations"],
  ["mako:live-locate", "conversations"],
  ["mako:live-merge-fork", "conversations"],
  ["mako:live-mode", "conversations"],
  ["mako:live-permission", "conversations"],
  ["mako:live-prewarm", "conversations"],
  ["mako:live-prompt", "conversations"],
  ["mako:live-read", "conversations"],
  ["mako:live-review", "conversations"],
  ["mako:live-rewind", "conversations"],
  ["mako:live-rewind-preview", "conversations"],
  ["mako:live-rewind-recover", "conversations"],
  ["mako:live-side-question", "conversations"],
  ["mako:live-sign-in-readiness", "conversations"],
  ["mako:live-sign-in-resume", "conversations"],
  ["mako:live-snapshot", "conversations"],
  ["mako:live-start", "conversations"],
  ["mako:live-state", "conversations"],
  ["mako:live-steer-queued", "conversations"],
  ["mako:live-stop-agent", "conversations"],
  ["mako:live-transfer", "conversations"],
  ["mako:live-turn-changes", "conversations"],
  ["mako:live-turn-diff", "conversations"],
  ["mako:lost-versions", "attribution"],
  ["mako:machine-woke", "application"],
  ["mako:mcp-discover", "tools"],
  ["mako:mcp-sync-apply", "tools"],
  ["mako:mcp-sync-preview", "tools"],
  ["mako:merge-pull", "git"],
  ["mako:native-authoring-apply", "tools"],
  ["mako:native-authoring-catalog", "tools"],
  ["mako:native-authoring-preview", "tools"],
  ["mako:native-authoring-view", "tools"],
  ["mako:native-dismiss", "conversations"],
  ["mako:native-edit-queued", "conversations"],
  ["mako:native-receipt", "conversations"],
  ["mako:native-requests", "conversations"],
  ["mako:native-submit", "conversations"],
  ["mako:navigate-tree", "workspaces"],
  ["mako:new-session", "workspaces"],
  ["mako:open-in-editor", "workspaces"],
  ["mako:open-session", "workspaces"],
  ["mako:open-tab", "workspaces"],
  ["mako:pick-folder", "workspaces"],
  ["mako:plan-build-claim", "workspaces"],
  ["mako:plan-build-record", "workspaces"],
  ["mako:plan-build-release", "workspaces"],
  ["mako:plan-builds", "workspaces"],
  ["mako:plugins-dir", "tools"],
  ["mako:project-app-setup", "workspaces"],
  ["mako:prompt", "workspaces"],
  ["mako:provider-connection-action", "harnesses"],
  ["mako:provider-connections", "harnesses"],
  ["mako:provider-residency", "conversations"],
  ["mako:pull-branches", "git"],
  ["mako:pull-request", "git"],
  ["mako:pull-request-search", "git"],
  ["mako:pull-requests", "git"],
  ["mako:read-file", "workspaces"],
  ["mako:read-live-file", "conversations"],
  ["mako:relaunch", "application"],
  ["mako:reload-automations", "workspaces"],
  ["mako:repo-avatar", "git"],
  ["mako:report-crash", "application"],
  ["mako:rerun-checks", "git"],
  ["mako:resolve-file-references", "attribution"],
  ["mako:restore-version", "attribution"],
  ["mako:reveal", "workspaces"],
  ["mako:reveal-plugins", "tools"],
  ["mako:run-automation", "workspaces"],
  ["mako:run-command", "workspaces"],
  ["mako:save-automations", "workspaces"],
  ["mako:search", "workspaces"],
  ["mako:select-update-source", "application"],
  ["mako:set-active-tools", "workspaces"],
  ["mako:set-auto-compaction", "workspaces"],
  ["mako:set-cwd", "workspaces"],
  ["mako:set-model", "workspaces"],
  ["mako:set-name", "workspaces"],
  ["mako:set-thinking", "workspaces"],
  ["mako:shutdown-ack", "application"],
  ["mako:skills-discover", "tools"],
  ["mako:skills-remove-preview", "tools"],
  ["mako:skills-resolve", "tools"],
  ["mako:skills-sync-apply", "tools"],
  ["mako:skills-sync-preview", "tools"],
  ["mako:stage-file", "workspaces"],
  ["mako:stage-file-path", "workspaces"],
  ["mako:store-formats", "threads"],
  ["mako:telemetry", "usage"],
  ["mako:telemetry-choose", "usage"],
  ["mako:terminal-acknowledge", "terminals"],
  ["mako:terminal-attach", "terminals"],
  ["mako:terminal-create", "terminals"],
  ["mako:terminal-detach", "terminals"],
  ["mako:terminal-kill", "terminals"],
  ["mako:terminal-list", "terminals"],
  ["mako:terminal-resize", "terminals"],
  ["mako:terminal-write", "terminals"],
  ["mako:thread-abort-run", "conversations"],
  ["mako:thread-app", "workspaces"],
  ["mako:thread-app-check", "workspaces"],
  ["mako:thread-app-make-room", "workspaces"],
  ["mako:thread-app-marks", "workspaces"],
  ["mako:thread-app-output", "workspaces"],
  ["mako:thread-app-probe", "workspaces"],
  ["mako:thread-app-restart", "workspaces"],
  ["mako:thread-app-room", "workspaces"],
  ["mako:thread-app-start", "workspaces"],
  ["mako:thread-app-stop", "workspaces"],
  ["mako:thread-app-stop-apps", "workspaces"],
  ["mako:thread-app-take-turn", "workspaces"],
  ["mako:thread-archive", "threads"],
  ["mako:thread-archives", "threads"],
  ["mako:thread-changes", "attribution"],
  ["mako:thread-child-follow", "threads"],
  ["mako:thread-child-unfollow", "threads"],
  ["mako:thread-children", "threads"],
  ["mako:thread-contexts", "threads"],
  ["mako:thread-continuation-plan", "conversations"],
  ["mako:thread-continuation-resolve", "conversations"],
  ["mako:thread-continue-with", "threads"],
  ["mako:thread-controls", "threads"],
  ["mako:thread-create-session", "threads"],
  ["mako:thread-entry", "threads"],
  ["mako:thread-file", "threads"],
  ["mako:thread-follow", "threads"],
  ["mako:thread-fork", "threads"],
  ["mako:thread-groups", "threads"],
  ["mako:thread-open", "threads"],
  ["mako:thread-original", "threads"],
  ["mako:thread-owner-resolve", "conversations"],
  ["mako:thread-page", "threads"],
  ["mako:thread-preview", "threads"],
  ["mako:thread-purposes", "threads"],
  ["mako:thread-remember-mode", "threads"],
  ["mako:thread-rename", "threads"],
  ["mako:thread-run", "conversations"],
  ["mako:thread-stop", "threads"],
  ["mako:thread-titles", "threads"],
  ["mako:thread-titles-import", "threads"],
  ["mako:thread-unfollow", "threads"],
  ["mako:threads", "threads"],
  ["mako:transcript-document", "conversations"],
  ["mako:unwatch-file", "workspaces"],
  ["mako:update-state", "application"],
  ["mako:usage", "usage"],
  ["mako:user-avatar", "git"],
  ["mako:utility-choice", "git"],
  ["mako:utility-model-catalog", "git"],
  ["mako:utility-model-connect", "git"],
  ["mako:utility-model-disconnect", "git"],
  ["mako:utility-model-settings", "git"],
  ["mako:watch-file", "workspaces"],
  ["mako:workspace-move-answer", "workspaces"],
  ["mako:workspace-move-bring", "workspaces"],
  ["mako:workspace-move-bring-stayed", "workspaces"],
  ["mako:workspace-move-forget", "workspaces"],
  ["mako:workspace-move-hold", "workspaces"],
  ["mako:workspace-move-outcome", "workspaces"],
  ["mako:workspace-move-put-back", "workspaces"],
  ["mako:workspace-moves", "workspaces"],
  ["mako:worktree-ahead", "workspaces"],
  ["mako:worktree-branches", "workspaces"],
  ["mako:worktree-inventory", "workspaces"],
  ["mako:worktree-merge", "workspaces"],
  ["mako:worktree-pulls", "workspaces"],
  ["mako:worktree-removal", "workspaces"],
  ["mako:worktree-remove", "workspaces"],
  ["mako:worktree-review", "workspaces"],
  ["mako:worktree-review-diffs", "workspaces"],
  ["mako:worktree-skip", "workspaces"],
  ["mako:worktree-start-point", "workspaces"],
  ["mako:worktree-summaries", "workspaces"],
  ["mako:worktree-update", "workspaces"],
  ["mako:worktree-want", "workspaces"],
  ["mako:worktrees", "workspaces"],
  ["mako:write-plugin", "tools"],
])

/** The domain that declares a host method, so a call can load it before its handler exists; a client call has none. */
export function hostChannelDomain(
  channel: HostChannel
): HostMethodDomain | undefined {
  return domains.get(channel)
}

export function isHostChannel(name: string): name is HostChannel {
  return Object.hasOwn(inputs, name)
}

export const hostChannels: readonly HostChannel[] =
  Object.keys(inputs).filter(isHostChannel)

/** A call's argument schema, built anew; a caller that parses often keeps it (`HostCallInputs`). */
export function hostCallSchema<Channel extends HostChannel>(
  channel: Channel
): HostCallInput<Channel> {
  // SAFETY: inputs[channel] is the builder HostCallInput<Channel> is the return type of; TypeScript loses that correlation when calling through a generic key.
  return inputs[channel]() as HostCallInput<Channel>
}

/** Call schemas, each built at its first use rather than when the process starts, kept for as long as their holder lives. */
export class HostCallInputs {
  readonly #built = new Map<HostChannel, z.ZodType>()

  of<Channel extends HostChannel>(channel: Channel): HostCallInput<Channel> {
    let schema = this.#built.get(channel)
    if (!schema) this.#built.set(channel, (schema = hostCallSchema(channel)))
    // SAFETY: `#built` only holds what hostCallSchema(channel) returned for this same key.
    return schema as HostCallInput<Channel>
  }
}
