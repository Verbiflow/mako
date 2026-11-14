// Generated from host handler parameter types by scripts/generate-host-inputs.mjs.
// Regenerate after changing a handler's arguments; never edit this table by hand.
import { z } from "zod"

const inputs = {
  "mako:abort": () => z.tuple([]),
  "mako:access-adopt": () => z.tuple([z.record(z.string(), z.string())]),
  "mako:access-choices": () => z.tuple([]),
  "mako:access-choose": () => z.tuple([z.string(), z.string()]),
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
  "mako:agent-ask-answer": () => z.tuple([z.string(), z.string(), z.boolean()]),
  "mako:agents-answer": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        to: z.string(),
        ask: z.string().optional(),
        answer: z.string().optional(),
        allow: z.boolean().optional(),
        person: z.boolean().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:agents-cancel": () =>
    z.tuple([
      z.object({
        version: z.number(),
        op: z.string(),
        parent: z.object({
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
        }),
        reason: z.string().optional(),
      }),
    ]),
  "mako:agents-capabilities": () => z.tuple([]),
  "mako:agents-continue-next": () => z.tuple([z.string(), z.string()]),
  "mako:agents-diagnostics": () => z.tuple([]),
  "mako:agents-direct": () =>
    z.tuple([
      z.string(),
      z.object({
        to: z.string(),
        request: z.string(),
        text: z.string(),
        attachments: z
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
      }),
    ]),
  "mako:agents-link": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        session: z.string(),
        harness: z.string(),
        pid: z.number().optional(),
        name: z.string().optional(),
        role: z
          .union([
            z.literal("lead"),
            z.literal("worker"),
            z.literal("reviewer"),
            z.literal("verifier"),
            z.literal("researcher"),
          ])
          .optional(),
      }),
    ]),
  "mako:agents-list": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        presentation: z
          .union([z.literal("full"), z.literal("summary")])
          .optional(),
        scope: z
          .union([
            z.literal("children"),
            z.literal("tree"),
            z.literal("crew"),
            z.literal("apexes"),
            z.literal("threads"),
          ])
          .optional(),
        query: z.string().optional(),
      }),
    ]),
  "mako:agents-move": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        child: z.string().optional(),
        all: z.boolean().optional(),
        harness: z.string(),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        fast: z.boolean().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:agents-next-place": () => z.tuple([z.string()]),
  "mako:agents-notice": () =>
    z.tuple([
      z.object({
        id: z.string(),
        op: z.string(),
        parent: z.object({ thread: z.string(), session: z.string() }),
        child: z.string(),
        report: z.object({
          id: z.string(),
          child: z.string(),
          status: z.union([
            z.literal("failed"),
            z.literal("progress"),
            z.literal("blocked"),
            z.literal("done"),
            z.literal("needs-input"),
          ]),
          summary: z.string(),
          ownerGeneration: z.number(),
          at: z.number(),
          artifacts: z
            .array(
              z.object({
                kind: z.union([
                  z.literal("file"),
                  z.literal("branch"),
                  z.literal("commit"),
                  z.literal("link"),
                  z.literal("pull-request"),
                  z.literal("screenshot"),
                  z.literal("test-run"),
                ]),
                ref: z.string(),
                label: z.string().optional(),
              })
            )
            .optional(),
          question: z.string().optional(),
          retainsQuestion: z.literal(true).optional(),
          supersedes: z.array(z.string()).optional(),
          decides: z.union([z.literal("person"), z.literal("apex")]).optional(),
          waitingOn: z
            .array(
              z.union([
                z.object({
                  kind: z.literal("pull-request"),
                  ref: z.string(),
                  repository: z.string().optional(),
                  number: z.number().optional(),
                  until: z
                    .union([
                      z.literal("checks"),
                      z.literal("merge"),
                      z.literal("review"),
                    ])
                    .optional(),
                }),
                z.object({ kind: z.literal("person"), what: z.string() }),
                z.object({ kind: z.literal("other"), text: z.string() }),
              ])
            )
            .optional(),
          options: z
            .array(
              z.object({ label: z.string(), detail: z.string().optional() })
            )
            .optional(),
          recommended: z.number().optional(),
          action: z.string().optional(),
          followUp: z
            .object({ ref: z.string(), version: z.string() })
            .optional(),
          for: z.literal("person").optional(),
          told: z.literal(true).optional(),
          implicit: z.literal(true).optional(),
          handoff: z
            .object({
              to: z.string(),
              child: z.string().optional(),
              text: z.string().optional(),
            })
            .optional(),
        }),
        standing: z
          .object({
            heard: z.number(),
            working: z.boolean(),
            owner: z.number(),
            seq: z.number(),
          })
          .optional(),
      }),
    ]),
  "mako:agents-place": () =>
    z.tuple([
      z.object({
        version: z.number(),
        op: z.string(),
        clientKey: z.string(),
        parent: z.object({
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
        }),
        brief: z.object({
          objective: z.string(),
          doneWhen: z.array(z.string()).optional(),
          boundaries: z.array(z.string()).optional(),
          output: z.string().optional(),
        }),
        name: z.string(),
        title: z.string().optional(),
        role: z
          .union([
            z.literal("lead"),
            z.literal("worker"),
            z.literal("reviewer"),
            z.literal("verifier"),
            z.literal("researcher"),
          ])
          .optional(),
        harness: z.string(),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        fast: z.boolean().optional(),
        access: z.union([
          z.literal("ask"),
          z.literal("auto"),
          z.literal("full"),
          z.literal("deny"),
          z.literal("plan"),
          z.literal("edits"),
          z.literal("chat"),
        ]),
        workspace: z.object({
          remote: z.string().optional(),
          branch: z.string().optional(),
          base: z.string().optional(),
          folder: z.string().optional(),
        }),
        mode: z.union([z.literal("wait"), z.literal("background")]).optional(),
        wake: z
          .union([
            z.literal("never"),
            z.literal("decisions"),
            z.literal("finish"),
          ])
          .optional(),
        queue: z.boolean().optional(),
      }),
    ]),
  "mako:agents-read": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        child: z.string(),
        view: z
          .union([
            z.literal("report"),
            z.literal("transcript"),
            z.literal("pulls"),
            z.literal("actions"),
          ])
          .optional(),
        snapshot: z.string().optional(),
        offset: z.number().optional(),
        limit: z.number().optional(),
        maxChars: z.number().optional(),
        report: z.string().optional(),
        afterAction: z.string().optional(),
        afterAsk: z.string().optional(),
      }),
    ]),
  "mako:agents-redirect": () =>
    z.tuple([
      z.string(),
      z.object({ from: z.string(), request: z.string(), to: z.string() }),
    ]),
  "mako:agents-report": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        status: z.union([
          z.literal("failed"),
          z.literal("progress"),
          z.literal("blocked"),
          z.literal("done"),
          z.literal("needs-input"),
        ]),
        summary: z.string(),
        artifacts: z
          .array(
            z.object({
              kind: z.union([
                z.literal("file"),
                z.literal("branch"),
                z.literal("commit"),
                z.literal("link"),
                z.literal("pull-request"),
                z.literal("screenshot"),
                z.literal("test-run"),
              ]),
              ref: z.string(),
              label: z.string().optional(),
            })
          )
          .optional(),
        question: z.string().optional(),
        supersedes: z.array(z.string()).optional(),
        options: z
          .array(z.object({ label: z.string(), detail: z.string().optional() }))
          .optional(),
        recommended: z.number().optional(),
        action: z.string().optional(),
        followUp: z.object({ ref: z.string(), version: z.string() }).optional(),
        decides: z.union([z.literal("person"), z.literal("apex")]).optional(),
        waitingOn: z
          .array(
            z.union([
              z.object({
                kind: z.literal("pull-request"),
                ref: z.string(),
                repository: z.string().optional(),
                number: z.number().optional(),
                until: z
                  .union([
                    z.literal("checks"),
                    z.literal("merge"),
                    z.literal("review"),
                  ])
                  .optional(),
              }),
              z.object({ kind: z.literal("person"), what: z.string() }),
              z.object({ kind: z.literal("other"), text: z.string() }),
            ])
          )
          .optional(),
        handoff: z.object({ to: z.string() }).optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:agents-respond": () =>
    z.tuple([
      z.string(),
      z.object({
        fin: z.string(),
        ask: z.string(),
        option: z.number().optional(),
        answer: z.string().optional(),
        allow: z.boolean().optional(),
        request: z.string(),
      }),
    ]),
  "mako:agents-send": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        to: z.string(),
        forward: z.boolean().optional(),
        text: z.string().optional(),
        deliver: z
          .union([
            z.literal("queue"),
            z.literal("steer"),
            z.literal("interrupt"),
          ])
          .optional(),
        reply: z.literal("none").optional(),
        context: z.array(z.object({ thread: z.string() })).optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:agents-settle": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        to: z.string(),
        report: z.string(),
        version: z.number(),
        target: z.object({ ref: z.string(), version: z.string() }),
        disposition: z.union([
          z.object({ kind: z.literal("resolve"), evidence: z.string() }),
          z.object({ kind: z.literal("reclaim"), reason: z.string() }),
          z.object({ kind: z.literal("dismiss"), reason: z.string() }),
          z.object({
            kind: z.literal("defer"),
            reason: z.string(),
            resume: z.string(),
          }),
          z.object({
            kind: z.literal("supersede"),
            report: z.string(),
            reason: z.string(),
          }),
          z.object({
            kind: z.literal("dispatch"),
            to: z.string(),
            request: z.string(),
          }),
          z.object({
            kind: z.literal("handoff"),
            to: z.string(),
            request: z.string(),
          }),
        ]),
        clientKey: z.string(),
      }),
    ]),
  "mako:agents-start": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        brief: z.object({
          objective: z.string(),
          doneWhen: z.array(z.string()).optional(),
          boundaries: z.array(z.string()).optional(),
          output: z.string().optional(),
        }),
        name: z.string().optional(),
        harness: z.string().optional(),
        model: z.string().optional(),
        reasoning: z.string().optional(),
        fast: z.boolean().optional(),
        rule: z.number().optional(),
        access: z
          .union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ])
          .optional(),
        place: z.string().optional(),
        workspace: z
          .object({
            branch: z.string().optional(),
            base: z.string().optional(),
          })
          .optional(),
        title: z.string().optional(),
        role: z
          .union([
            z.literal("lead"),
            z.literal("worker"),
            z.literal("reviewer"),
            z.literal("verifier"),
            z.literal("researcher"),
          ])
          .optional(),
        mode: z.union([z.literal("wait"), z.literal("background")]).optional(),
        wake: z
          .union([
            z.literal("never"),
            z.literal("decisions"),
            z.literal("finish"),
          ])
          .optional(),
        timeoutMs: z.number().optional(),
        after: z.array(z.string()).optional(),
        queue: z.boolean().optional(),
        context: z.array(z.object({ thread: z.string() })).optional(),
        clientKey: z.string(),
        cwd: z.string().optional(),
      }),
    ]),
  "mako:agents-stop": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({ child: z.string(), reason: z.string().optional() }),
    ]),
  "mako:agents-wait": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        children: z.array(z.string()).optional(),
        timeoutMs: z.number().optional(),
        after: z.number().optional(),
      }),
    ]),
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
  "mako:automation-context": () => z.tuple([]),
  "mako:automation-enabled": () =>
    z.tuple([z.string(), z.boolean(), z.string().optional()]),
  "mako:automations": () => z.tuple([]),
  "mako:automations-act": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        action: z.union([
          z.literal("run"),
          z.literal("off"),
          z.literal("on"),
          z.literal("list"),
        ]),
        id: z.string().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:boot": () => z.tuple([]),
  "mako:browser-control-connect": () => z.tuple([z.string()]),
  "mako:browser-control-disconnect": () => z.tuple([z.string()]),
  "mako:browser-control-prefer": () =>
    z.tuple([z.union([z.null(), z.string()])]),
  "mako:browser-control-status": () => z.tuple([]),
  "mako:browser-extension-setup": () => z.tuple([]),
  "mako:build-update": () =>
    z.tuple([
      z.union([z.literal("upstream"), z.literal("checkout")]).optional(),
    ]),
  "mako:capabilities": () => z.tuple([]),
  "mako:change-usage": () => z.tuple([]),
  "mako:chat-folders": () => z.tuple([z.array(z.string())]),
  "mako:check-update-source": () => z.tuple([z.boolean()]),
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
  "mako:cloud-browser-session-end": () => z.tuple([z.string()]),
  "mako:cloud-browser-sessions": () => z.tuple([]),
  "mako:cloud-browser-sessions-end": () => z.tuple([]),
  "mako:cloud-carried-files": () => z.tuple([z.string()]),
  "mako:cloud-carried-files-decide": () => z.tuple([z.string(), z.boolean()]),
  "mako:cloud-carried-files-keep": () =>
    z.tuple([z.string(), z.string(), z.boolean()]),
  "mako:cloud-device-remove": () => z.tuple([z.string()]),
  "mako:cloud-devices": () => z.tuple([]),
  "mako:cloud-offer-projects": () => z.tuple([z.array(z.string())]),
  "mako:cloud-prepare": () =>
    z.tuple([
      z.string(),
      z.number(),
      z
        .object({
          harness: z.string(),
          modeId: z.string().optional(),
          tuning: z
            .object({
              model: z.string().optional(),
              options: z
                .record(z.string(), z.union([z.boolean(), z.string()]))
                .optional(),
            })
            .optional(),
        })
        .optional(),
    ]),
  "mako:cloud-sign-in": () => z.tuple([]),
  "mako:cloud-sign-in-cancel": () => z.tuple([]),
  "mako:cloud-sign-ins": () => z.tuple([]),
  "mako:cloud-sign-ins-share": () => z.tuple([z.boolean()]),
  "mako:cloud-sign-out": () => z.tuple([]),
  "mako:cloud-turn-on": () => z.tuple([]),
  "mako:cloud-turn-on-check": () => z.tuple([]),
  "mako:cloud-turn-on-retry-bases": () => z.tuple([]),
  "mako:compact": () => z.tuple([z.string().optional()]),
  "mako:computer-driver": () => z.tuple([]),
  "mako:computer-driver-connections": () => z.tuple([]),
  "mako:computer-driver-update": () => z.tuple([]),
  "mako:computer-permissions": () => z.tuple([]),
  "mako:computer-permissions-request": () => z.tuple([]),
  "mako:continue-readings": () => z.tuple([]),
  "mako:control-preview": () =>
    z.tuple([
      z.string(),
      z.boolean(),
      z.string(),
      z.object({ width: z.number(), height: z.number() }).optional(),
    ]),
  "mako:control-preview-source": () => z.tuple([z.string()]),
  "mako:control-preview-viewers": () => z.tuple([z.string()]),
  "mako:control-video": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({ width: z.number(), height: z.number() }).optional(),
    ]),
  "mako:conversation-settings": () => z.tuple([]),
  "mako:conversation-settings-set": () =>
    z.tuple([z.object({ continueAfterRestart: z.boolean() })]),
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
        as: z.literal("app").optional(),
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
  "mako:file-events-dismiss": () => z.tuple([]),
  "mako:file-events-restart": () => z.tuple([]),
  "mako:file-events-service": () => z.tuple([]),
  "mako:files-find": () => z.tuple([z.string(), z.number().optional()]),
  "mako:files-folders": () =>
    z.tuple([
      z.array(z.string()),
      z
        .object({
          limit: z.number().optional(),
          since: z.number().optional(),
          epoch: z.string().optional(),
        })
        .optional(),
    ]),
  "mako:files-grep": () =>
    z.tuple([
      z.string(),
      z
        .object({
          regex: z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          wholeWord: z.boolean().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    ]),
  "mako:fin-ceiling-set": () => z.tuple([z.number()]),
  "mako:fin-default-choose": () =>
    z.tuple([
      z.string(),
      z.union([
        z.null(),
        z.object({
          model: z.string().optional(),
          options: z
            .record(z.string(), z.union([z.boolean(), z.string()]))
            .optional(),
        }),
      ]),
    ]),
  "mako:fin-defaults": () => z.tuple([]),
  "mako:fin-limit-set": () => z.tuple([z.union([z.null(), z.number()])]),
  "mako:fin-move-on-limit": () => z.tuple([z.boolean()]),
  "mako:fin-policy-save": () =>
    z.tuple([
      z.object({
        rules: z.array(
          z.object({
            id: z.string(),
            when: z.string(),
            target: z.object({
              harness: z.string(),
              settings: z
                .object({
                  model: z.string().optional(),
                  options: z
                    .record(z.string(), z.union([z.boolean(), z.string()]))
                    .optional(),
                })
                .optional(),
            }),
          })
        ),
        otherwise: z
          .object({
            harness: z.string(),
            settings: z
              .object({
                model: z.string().optional(),
                options: z
                  .record(z.string(), z.union([z.boolean(), z.string()]))
                  .optional(),
              })
              .optional(),
          })
          .optional(),
        forFins: z.string().optional(),
        forApexes: z.string().optional(),
      }),
    ]),
  "mako:fin-role-rules-save": () =>
    z.tuple([
      z.union([z.literal("forFins"), z.literal("forApexes")]),
      z.string(),
    ]),
  "mako:fork": () =>
    z.tuple([
      z.string(),
      z.union([z.literal("at"), z.literal("before")]).optional(),
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
          z.literal("merge"),
          z.literal("abort"),
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
  "mako:github-authorship": () => z.tuple([]),
  "mako:github-authorship-save": () =>
    z.tuple([z.union([z.literal("you"), z.literal("mako")])]),
  "mako:github-status": () => z.tuple([]),
  "mako:github-token": () => z.tuple([]),
  "mako:github-token-remove": () => z.tuple([]),
  "mako:github-token-save": () => z.tuple([z.string(), z.string().optional()]),
  "mako:handoff": () => z.tuple([z.string(), z.literal("quit")]),
  "mako:handoff-away-held": () => z.tuple([]),
  "mako:handoff-candidates": () => z.tuple([]),
  "mako:handoff-run-here": () => z.tuple([z.string()]),
  "mako:handoff-settings": () => z.tuple([]),
  "mako:handoff-settings-set": () => z.tuple([z.boolean()]),
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
  "mako:harnesses-act": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        action: z.union([
          z.literal("install"),
          z.literal("read"),
          z.literal("update"),
        ]),
        harness: z.string().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:host-log-path": () => z.tuple([]),
  "mako:install-update": () => z.tuple([]),
  "mako:installation-state": () => z.tuple([]),
  "mako:integrations": () => z.tuple([]),
  "mako:keep-awake": () => z.tuple([]),
  "mako:keep-awake-set": () =>
    z.tuple([
      z.object({
        on: z.boolean().optional(),
        lidClosed: z.boolean().optional(),
      }),
    ]),
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
      z.union([z.literal("all"), z.literal("workspace")]).optional(),
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
  "mako:live-continue-turn": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({
        reason: z.literal("handed-off"),
        continues: z.string(),
        stopped: z.array(z.string()).optional(),
      }),
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
  "mako:live-files-find": () =>
    z.tuple([z.string(), z.string(), z.number().optional()]),
  "mako:live-files-folders": () =>
    z.tuple([
      z.string(),
      z.array(z.string()),
      z
        .object({
          limit: z.number().optional(),
          since: z.number().optional(),
          epoch: z.string().optional(),
        })
        .optional(),
    ]),
  "mako:live-files-grep": () =>
    z.tuple([
      z.string(),
      z.string(),
      z
        .object({
          regex: z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          wholeWord: z.boolean().optional(),
          limit: z.number().optional(),
        })
        .optional(),
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
        thread: z.union([z.literal("parent"), z.literal("new")]).optional(),
        worktree: z.boolean().optional(),
        move: z.boolean().optional(),
        session: z.string().optional(),
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
  "mako:live-hold-until": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({ after: z.string(), at: z.number() }),
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
        position: z.union([z.literal("after"), z.literal("before")]).optional(),
      }),
    ]),
  "mako:live-rewind-preview": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.union([z.literal("after"), z.literal("before")]).optional(),
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
            grants: z.array(z.string()).optional(),
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
        account: z.string().optional(),
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
        parent: z
          .object({
            op: z.string(),
            parent: z.string(),
            name: z.string(),
            role: z.union([
              z.literal("lead"),
              z.literal("worker"),
              z.literal("reviewer"),
              z.literal("verifier"),
              z.literal("researcher"),
            ]),
            origin: z.union([
              z.literal("started"),
              z.literal("attached"),
              z.literal("discovered"),
              z.literal("linked"),
            ]),
            asked: z.object({
              brief: z.object({
                objective: z.string(),
                doneWhen: z.array(z.string()).optional(),
                boundaries: z.array(z.string()).optional(),
                output: z.string().optional(),
              }),
              harness: z.string().optional(),
              model: z.string().optional(),
              reasoning: z.string().optional(),
              fast: z.boolean().optional(),
              rule: z.number().optional(),
              access: z
                .union([
                  z.literal("ask"),
                  z.literal("auto"),
                  z.literal("full"),
                  z.literal("deny"),
                  z.literal("plan"),
                  z.literal("edits"),
                  z.literal("chat"),
                ])
                .optional(),
              place: z.string().optional(),
              workspace: z
                .object({
                  branch: z.string().optional(),
                  base: z.string().optional(),
                })
                .optional(),
              mode: z
                .union([z.literal("wait"), z.literal("background")])
                .optional(),
              wake: z
                .union([
                  z.literal("never"),
                  z.literal("decisions"),
                  z.literal("finish"),
                ])
                .optional(),
            }),
            parentSession: z.string(),
            startedBy: z.union([
              z.object({ kind: z.literal("person"), principal: z.string() }),
              z.object({ kind: z.literal("agent"), session: z.string() }),
              z.object({
                kind: z.literal("service"),
                name: z.union([
                  z.literal("handoff"),
                  z.literal("workspace"),
                  z.literal("goal"),
                  z.literal("catalog"),
                  z.literal("migration"),
                  z.literal("auto-continue"),
                  z.literal("relay"),
                  z.literal("pull-watch"),
                ]),
              }),
            ]),
            remote: z
              .object({
                device: z.string(),
                access: z.union([
                  z.literal("ask"),
                  z.literal("auto"),
                  z.literal("full"),
                  z.literal("deny"),
                  z.literal("plan"),
                  z.literal("edits"),
                  z.literal("chat"),
                ]),
                conversation: z.string().optional(),
                heard: z.number().optional(),
              })
              .optional(),
            tuned: z
              .object({
                source: z.union([
                  z.literal("apex"),
                  z.literal("harness"),
                  z.literal("rule"),
                  z.literal("mako"),
                  z.literal("asked"),
                  z.literal("fins"),
                  z.literal("used"),
                  z.literal("connection"),
                ]),
                note: z.string().optional(),
                rerouted: z
                  .object({
                    from: z.string(),
                    until: z.number().optional(),
                    instead: z.string().optional(),
                    account: z.string().optional(),
                    to: z
                      .union([
                        z.object({
                          why: z.literal("account"),
                          harness: z.string(),
                          account: z.string(),
                          label: z.string(),
                        }),
                        z.object({
                          why: z.literal("connection"),
                          harness: z.string(),
                          connection: z.string(),
                          connectionName: z.string(),
                          model: z.string(),
                        }),
                        z.object({
                          why: z.literal("harness"),
                          harness: z.string(),
                        }),
                      ])
                      .optional(),
                    at: z.number().optional(),
                    line: z.string().optional(),
                  })
                  .optional(),
                rule: z
                  .object({ when: z.string(), n: z.number().optional() })
                  .optional(),
              })
              .optional(),
            placed: z
              .object({
                target: z.union([
                  z.object({
                    kind: z.literal("device"),
                    device: z.string(),
                    name: z.string(),
                  }),
                  z.object({ kind: z.literal("cloud"), thread: z.string() }),
                ]),
                session: z.string().optional(),
                conversation: z.string().optional(),
                working: z.boolean().optional(),
                epoch: z.number().optional(),
                stop: z.object({ at: z.number(), why: z.string() }).optional(),
                said: z
                  .object({ owner: z.number(), seq: z.number() })
                  .optional(),
              })
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
        account: z.string().optional(),
        grants: z.array(z.string()).optional(),
        notification: z.literal(true).optional(),
      }),
    ]),
  "mako:live-turn-changes": () =>
    z.tuple([z.string(), z.string(), z.string().optional()]),
  "mako:live-turn-diff": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.string(),
      z.object({ only: z.boolean().optional() }).optional(),
    ]),
  "mako:live-turn-hunks": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.string(),
      z.object({ context: z.number().optional() }).optional(),
    ]),
  "mako:live-turn-undo": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({ kind: z.literal("turn"), requestId: z.string() }),
        z.object({ kind: z.literal("thread") }),
      ]),
      z.string(),
    ]),
  "mako:live-turn-undo-preview": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({ kind: z.literal("turn"), requestId: z.string() }),
        z.object({ kind: z.literal("thread") }),
      ]),
    ]),
  "mako:live-turn-writers": () => z.tuple([z.string(), z.string(), z.string()]),
  "mako:lost-versions": () =>
    z.tuple([
      z.union([
        z.object({ thread: z.string() }),
        z.object({ path: z.string() }),
      ]),
    ]),
  "mako:machine-leaving": () =>
    z.tuple([z.union([z.literal("suspend"), z.literal("shutdown")])]),
  "mako:machine-woke": () =>
    z.tuple([z.union([z.literal("resume"), z.literal("unlock-screen")])]),
  "mako:mako-footprint": () => z.tuple([]),
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
  "mako:measure-update-again": () => z.tuple([]),
  "mako:merge-pull": () =>
    z.tuple([
      z.union([z.literal("merge"), z.literal("squash"), z.literal("rebase")]),
      z.literal("app").optional(),
    ]),
  "mako:model-connection-add": () =>
    z.tuple([
      z.object({
        name: z.string().optional(),
        models: z.array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            contextTokens: z.number().optional(),
          })
        ),
        provider: z.string(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
      }),
    ]),
  "mako:model-connection-check": () =>
    z.tuple([
      z.object({
        provider: z.string(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
      }),
    ]),
  "mako:model-connection-enable": () => z.tuple([z.string(), z.boolean()]),
  "mako:model-connection-local": () => z.tuple([]),
  "mako:model-connection-remove": () => z.tuple([z.string()]),
  "mako:model-connection-test": () => z.tuple([z.string()]),
  "mako:model-connections": () => z.tuple([]),
  "mako:move-arrive": () =>
    z.tuple([
      z.object({
        move: z.string(),
        folder: z.string(),
        sessions: z.array(
          z.object({
            harness: z.string(),
            nativeId: z.string(),
            holdings: z.record(z.string(), z.number()).optional(),
            open: z
              .object({
                conversationId: z.string(),
                cwd: z.string().optional(),
                modeId: z.string().optional(),
                tuning: z
                  .object({
                    model: z.string().optional(),
                    options: z
                      .record(z.string(), z.union([z.boolean(), z.string()]))
                      .optional(),
                  })
                  .optional(),
              })
              .optional(),
          })
        ),
        checkpoint: z
          .object({
            version: z.literal(1),
            sha256: z.string(),
            bytes: z.number(),
            head: z.string(),
            index: z.string(),
            work: z.string(),
            branch: z.string().optional(),
          })
          .optional(),
        handoff: z
          .object({
            move: z.string(),
            source: z.union([
              z.object({ kind: z.literal("device"), device: z.string() }),
              z.object({ kind: z.literal("cloud"), runtime: z.string() }),
            ]),
            target: z.union([
              z.object({ kind: z.literal("device"), device: z.string() }),
              z.object({ kind: z.literal("cloud"), runtime: z.string() }),
            ]),
            releasedAt: z.number(),
            thread: z.object({
              id: z.string(),
              owner: z.string(),
              title: z.string().optional(),
              titleSource: z
                .union([
                  z.literal("auto"),
                  z.literal("user"),
                  z.literal("frozen"),
                ])
                .optional(),
              originalTitle: z.string().optional(),
            }),
            sessions: z.array(
              z.object({
                id: z.string(),
                origin: z.union([
                  z.literal("new"),
                  z.literal("started"),
                  z.literal("imported"),
                  z.literal("captured"),
                  z.literal("fork"),
                ]),
                position: z.number(),
                generation: z.number(),
                journals: z.array(z.string()),
                parent: z.string().optional(),
              })
            ),
          })
          .optional(),
        carry: z.object({ sha256: z.string(), bytes: z.number() }).optional(),
        others: z
          .array(
            z.object({
              path: z.string(),
              url: z.string(),
              checkpoint: z.object({
                version: z.literal(1),
                sha256: z.string(),
                bytes: z.number(),
                head: z.string(),
                index: z.string(),
                work: z.string(),
                branch: z.string().optional(),
              }),
              branch: z.string().optional(),
            })
          )
          .optional(),
      }),
    ]),
  "mako:move-depart": () =>
    z.tuple([
      z.object({
        move: z.string(),
        folder: z.string(),
        conversations: z.array(z.string()),
        device: z.string(),
        carry: z.literal(true).optional(),
      }),
    ]),
  "mako:move-follow": () => z.tuple([z.object({ folder: z.string() })]),
  "mako:move-ready": () =>
    z.tuple([
      z.object({
        folder: z.string(),
        repositories: z
          .array(
            z.object({
              path: z.string(),
              url: z.string(),
              branch: z.string().optional(),
            })
          )
          .optional(),
        harnesses: z.array(z.string()).optional(),
        launches: z
          .array(
            z.object({
              harness: z.string(),
              tuning: z
                .object({
                  model: z.string().optional(),
                  options: z
                    .record(z.string(), z.union([z.boolean(), z.string()]))
                    .optional(),
                })
                .optional(),
            })
          )
          .optional(),
      }),
    ]),
  "mako:move-stage": () =>
    z.tuple([
      z.object({
        move: z.string(),
        folder: z.string(),
        checkpoint: z.object({
          version: z.literal(1),
          sha256: z.string(),
          bytes: z.number(),
          head: z.string(),
          index: z.string(),
          work: z.string(),
          branch: z.string().optional(),
        }),
        sessions: z.array(
          z.object({ harness: z.string(), nativeId: z.string() })
        ),
      }),
    ]),
  "mako:move-stay": () =>
    z.tuple([
      z.object({ move: z.string(), device: z.string(), reason: z.string() }),
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
  "mako:native-routing": () => z.tuple([]),
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
        thread: z.string().optional(),
        conversation: z.string().optional(),
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
      z.union([z.literal("followUp"), z.literal("steer")]).optional(),
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
  "mako:read-live-file": () =>
    z.tuple([z.string(), z.string(), z.literal("preview").optional()]),
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
  "mako:resolve-turn-media": () =>
    z.tuple([
      z
        .array(
          z.object({
            callId: z.string().min(1).max(512),
            path: z.string().min(2).max(4_096).startsWith("/"),
            evidence: z.enum(["shown", "produced", "wrote", "named"]),
            startedAt: z
              .number()
              .int()
              .nonnegative()
              .max(8_640_000_000_000_000)
              .optional(),
            endedAt: z
              .number()
              .int()
              .nonnegative()
              .max(8_640_000_000_000_000)
              .optional(),
            digest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
        )
        .max(200),
    ]),
  "mako:restore-version": () => z.tuple([z.string(), z.number()]),
  "mako:reveal": () => z.tuple([z.string()]),
  "mako:reveal-plugins": () => z.tuple([]),
  "mako:run-automation": () =>
    z.tuple([z.string(), z.string().optional(), z.string().optional()]),
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
          scope: z.union([z.literal("all"), z.literal("workspace")]).optional(),
        })
        .optional(),
    ]),
  "mako:select-update-source": () => z.tuple([z.string()]),
  "mako:session-reader-history": () => z.tuple([]),
  "mako:set-active-tools": () => z.tuple([z.array(z.string())]),
  "mako:set-auto-compaction": () => z.tuple([z.boolean()]),
  "mako:set-badge-count": () => z.tuple([z.number()]),
  "mako:set-cwd": () => z.tuple([z.string(), z.string().optional()]),
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
  "mako:settings-act": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        action: z.union([z.literal("set"), z.literal("read")]),
        setting: z.string().optional(),
        value: z
          .union([z.boolean(), z.string(), z.array(z.string())])
          .optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:setup": () => z.tuple([z.string()]),
  "mako:setup-act": () =>
    z.tuple([
      z.string(),
      z.union([
        z.object({
          act: z.literal("answer"),
          ask: z.string(),
          answer: z.union([
            z.literal("add-to-setup"),
            z.literal("allow-project"),
            z.literal("allow-thread"),
            z.literal("decline"),
          ]),
        }),
        z.object({
          act: z.literal("row"),
          place: z.string(),
          row: z.string(),
          action: z.union([
            z.literal("stop"),
            z.literal("add"),
            z.literal("keep"),
            z.literal("retry"),
            z.literal("send"),
          ]),
        }),
        z.object({ act: z.literal("rebuild") }),
      ]),
    ]),
  "mako:shutdown-ack": () => z.tuple([z.string()]),
  "mako:simulator-setup": () => z.tuple([z.boolean().optional()]),
  "mako:simulator-setup-press": () =>
    z.tuple([
      z.union([
        z.literal("get-xcode"),
        z.literal("finish-xcode"),
        z.literal("download-runtime"),
        z.literal("create-simulators"),
        z.literal("install-tools"),
        z.literal("allow-agents"),
        z.literal("try"),
      ]),
      z
        .object({
          folder: z.string().optional(),
          allowed: z.boolean().optional(),
        })
        .optional(),
    ]),
  "mako:simulators-act": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        action: z.union([
          z.object({ kind: z.literal("open-url"), url: z.string() }),
          z.object({
            kind: z.literal("tap"),
            at: z.object({ x: z.number(), y: z.number() }),
          }),
          z.object({
            kind: z.literal("touch"),
            phase: z.union([
              z.literal("move"),
              z.literal("begin"),
              z.literal("end"),
            ]),
            at: z.object({ x: z.number(), y: z.number() }),
          }),
          z.object({
            kind: z.literal("swipe"),
            from: z.object({ x: z.number(), y: z.number() }),
            to: z.object({ x: z.number(), y: z.number() }),
            ms: z.number().optional(),
          }),
          z.object({
            kind: z.literal("pinch"),
            at: z.object({ x: z.number(), y: z.number() }),
            scale: z.number(),
            ms: z.number().optional(),
          }),
          z.object({ kind: z.literal("type"), text: z.string() }),
          z.object({
            kind: z.literal("key"),
            key: z.union([
              z.literal("tab"),
              z.literal("return"),
              z.literal("backspace"),
              z.literal("escape"),
              z.literal("space"),
              z.literal("up"),
              z.literal("down"),
              z.literal("left"),
              z.literal("right"),
            ]),
          }),
          z.object({
            kind: z.literal("rotate"),
            to: z.union([
              z.literal("portrait"),
              z.literal("landscape-left"),
              z.literal("landscape-right"),
              z.literal("portrait-upside-down"),
            ]),
          }),
          z.object({ kind: z.literal("keyboard"), shown: z.boolean() }),
          z.object({ kind: z.literal("home") }),
          z.object({ kind: z.literal("add-to-home-screen") }),
        ]),
      }),
    ]),
  "mako:simulators-list": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
    ]),
  "mako:simulators-open": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        url: z.string().optional(),
      }),
    ]),
  "mako:simulators-read": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        what: z.union([
          z.literal("page"),
          z.literal("console"),
          z.literal("accessibility"),
        ]),
        after: z.number().optional(),
      }),
    ]),
  "mako:simulators-record": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        recording: z.union([z.literal("stop"), z.literal("start")]),
      }),
    ]),
  "mako:simulators-release": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({ simulator: z.string(), host: z.string() }),
    ]),
  "mako:simulators-shot": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        inline: z.boolean().optional(),
      }),
    ]),
  "mako:simulators-watch": () =>
    z.tuple([
      z.union([
        z.object({
          kind: z.literal("agent"),
          session: z.string(),
          via: z.object({ from: z.string() }).optional(),
          agent: z
            .object({
              thread: z.string(),
              session: z.string(),
              conversation: z.string().optional(),
              folder: z.string(),
              project: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("person"),
          via: z.object({ from: z.string() }).optional(),
        }),
      ]),
      z.object({
        simulator: z.string(),
        host: z.string(),
        viewer: z.string(),
        box: z.object({ width: z.number(), height: z.number() }).optional(),
        waitMs: z.number().optional(),
        decoded: z.number().optional(),
        leave: z.boolean().optional(),
      }),
    ]),
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
  "mako:storage": () => z.tuple([z.boolean()]),
  "mako:storage-free": () => z.tuple([]),
  "mako:store-formats": () => z.tuple([]),
  "mako:stream-original": () =>
    z.tuple([
      z.object({
        file: z.string().optional(),
        ranges: z.array(z.tuple([z.number(), z.number()])).optional(),
        rows: z
          .array(
            z.object({
              table: z.string(),
              key: z.record(z.string(), z.union([z.string(), z.number()])),
            })
          )
          .optional(),
      }),
    ]),
  "mako:surface-window": () => z.tuple([]),
  "mako:sync-readings": () => z.tuple([]),
  "mako:sync-status": () => z.tuple([]),
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
        anyway: z.literal(true).optional(),
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
      z.object({ children: z.boolean().optional() }).optional(),
    ]),
  "mako:thread-continuation-plan": () => z.tuple([z.string()]),
  "mako:thread-continuation-resolve": () => z.tuple([z.string()]),
  "mako:thread-continue": () => z.tuple([z.string(), z.string()]),
  "mako:thread-continue-offer": () => z.tuple([z.string()]),
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
  "mako:thread-create-session": () =>
    z.tuple([z.string(), z.string(), z.string().optional()]),
  "mako:thread-entry": () => z.tuple([z.string(), z.string()]),
  "mako:thread-file": () =>
    z.tuple([z.string(), z.string(), z.literal("preview").optional()]),
  "mako:thread-follow": () => z.tuple([z.string(), z.number()]),
  "mako:thread-groups": () => z.tuple([]),
  "mako:thread-harness-check": () => z.tuple([z.string()]),
  "mako:thread-move": () =>
    z.tuple([
      z.string(),
      z.string(),
      z
        .object({
          why: z.union([
            z.literal("quit"),
            z.literal("asked"),
            z.literal("shutdown"),
            z.literal("sleep"),
          ]),
          releaseBy: z.number().optional(),
        })
        .optional(),
    ]),
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
  "mako:thread-restore-plan": () => z.tuple([z.string()]),
  "mako:thread-return": () =>
    z.tuple([
      z.string(),
      z.string(),
      z.object({ project: z.string().optional() }).optional(),
    ]),
  "mako:thread-run": () => z.tuple([z.string()]),
  "mako:thread-scratch": () => z.tuple([]),
  "mako:thread-scratch-set": () =>
    z.tuple([
      z.object({
        mode: z.union([z.literal("remove"), z.literal("preview")]),
        idleDays: z.number(),
        kept: z.array(z.string()),
      }),
    ]),
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
  "mako:threads-act": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        action: z.union([
          z.literal("rename"),
          z.literal("archive"),
          z.literal("restore"),
        ]),
        title: z.string().optional(),
        conversation: z.string().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:threads-move": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("agent"), session: z.string() }),
        z.object({ kind: z.literal("person") }),
        z.object({
          kind: z.literal("apex"),
          device: z.string(),
          thread: z.string(),
          session: z.string(),
          conversation: z.string().optional(),
          access: z.union([
            z.literal("ask"),
            z.literal("auto"),
            z.literal("full"),
            z.literal("deny"),
            z.literal("plan"),
            z.literal("edits"),
            z.literal("chat"),
          ]),
          forwards: z.string().optional(),
          epoch: z.number().optional(),
        }),
      ]),
      z.object({
        to: z.union([z.literal("cloud"), z.literal("back")]),
        conversation: z.string().optional(),
        clientKey: z.string(),
      }),
    ]),
  "mako:transcript-document": () =>
    z.tuple([
      z.union([
        z.object({ kind: z.literal("live"), id: z.string() }),
        z.object({ kind: z.literal("file"), path: z.string() }),
      ]),
      z.union([z.literal("full"), z.literal("concise")]),
    ]),
  "mako:unread-records": () => z.tuple([]),
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
      z.union([z.literal("deny"), z.literal("allow"), z.literal("always")]),
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
  "mako:worktree-retention": () => z.tuple([]),
  "mako:worktree-retention-set": () =>
    z.tuple([
      z.object({
        mode: z.union([
          z.literal("checkout"),
          z.literal("preview"),
          z.literal("packages"),
        ]),
        days: z.number(),
        kept: z.array(z.string()),
      }),
    ]),
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
  | "media"
  | "terminals"
  | "threads"
  | "tools"
  | "usage"
  | "workspaces"

const domains = new Map<HostChannel, HostMethodDomain>([
  ["mako:abort", "workspaces"],
  ["mako:access-adopt", "harnesses"],
  ["mako:access-choices", "harnesses"],
  ["mako:access-choose", "harnesses"],
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
  ["mako:agent-ask-answer", "conversations"],
  ["mako:agents-answer", "conversations"],
  ["mako:agents-cancel", "conversations"],
  ["mako:agents-capabilities", "conversations"],
  ["mako:agents-continue-next", "conversations"],
  ["mako:agents-diagnostics", "conversations"],
  ["mako:agents-direct", "conversations"],
  ["mako:agents-link", "conversations"],
  ["mako:agents-list", "conversations"],
  ["mako:agents-move", "conversations"],
  ["mako:agents-next-place", "conversations"],
  ["mako:agents-notice", "conversations"],
  ["mako:agents-place", "conversations"],
  ["mako:agents-read", "conversations"],
  ["mako:agents-redirect", "conversations"],
  ["mako:agents-report", "conversations"],
  ["mako:agents-respond", "conversations"],
  ["mako:agents-send", "conversations"],
  ["mako:agents-settle", "conversations"],
  ["mako:agents-start", "conversations"],
  ["mako:agents-stop", "conversations"],
  ["mako:agents-wait", "conversations"],
  ["mako:appshot-capture", "control"],
  ["mako:appshot-front", "control"],
  ["mako:appshot-windows", "control"],
  ["mako:automation-context", "workspaces"],
  ["mako:automation-enabled", "workspaces"],
  ["mako:automations", "workspaces"],
  ["mako:automations-act", "conversations"],
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
  ["mako:check-update-source", "application"],
  ["mako:check-updates", "application"],
  ["mako:checkout-heads", "workspaces"],
  ["mako:choose-file-reference", "attribution"],
  ["mako:clear-crashes", "application"],
  ["mako:clear-queue", "workspaces"],
  ["mako:close-tab", "workspaces"],
  ["mako:cloud-account", "usage"],
  ["mako:cloud-browser-session-end", "usage"],
  ["mako:cloud-browser-sessions", "usage"],
  ["mako:cloud-browser-sessions-end", "usage"],
  ["mako:cloud-carried-files", "workspaces"],
  ["mako:cloud-carried-files-decide", "workspaces"],
  ["mako:cloud-carried-files-keep", "workspaces"],
  ["mako:cloud-device-remove", "usage"],
  ["mako:cloud-devices", "usage"],
  ["mako:cloud-offer-projects", "conversations"],
  ["mako:cloud-prepare", "conversations"],
  ["mako:cloud-sign-in", "usage"],
  ["mako:cloud-sign-in-cancel", "usage"],
  ["mako:cloud-sign-ins", "usage"],
  ["mako:cloud-sign-ins-share", "usage"],
  ["mako:cloud-sign-out", "usage"],
  ["mako:cloud-turn-on", "conversations"],
  ["mako:cloud-turn-on-check", "conversations"],
  ["mako:cloud-turn-on-retry-bases", "conversations"],
  ["mako:compact", "workspaces"],
  ["mako:computer-driver", "control"],
  ["mako:computer-driver-connections", "control"],
  ["mako:computer-driver-update", "control"],
  ["mako:computer-permissions", "control"],
  ["mako:computer-permissions-request", "control"],
  ["mako:continue-readings", "conversations"],
  ["mako:control-preview", "control"],
  ["mako:control-preview-source", "control"],
  ["mako:control-preview-viewers", "control"],
  ["mako:control-video", "conversations"],
  ["mako:conversation-settings", "conversations"],
  ["mako:conversation-settings-set", "conversations"],
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
  ["mako:file-events-dismiss", "workspaces"],
  ["mako:file-events-restart", "workspaces"],
  ["mako:file-events-service", "workspaces"],
  ["mako:files-find", "workspaces"],
  ["mako:files-folders", "workspaces"],
  ["mako:files-grep", "workspaces"],
  ["mako:fin-ceiling-set", "harnesses"],
  ["mako:fin-default-choose", "harnesses"],
  ["mako:fin-defaults", "harnesses"],
  ["mako:fin-limit-set", "harnesses"],
  ["mako:fin-move-on-limit", "harnesses"],
  ["mako:fin-policy-save", "harnesses"],
  ["mako:fin-role-rules-save", "harnesses"],
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
  ["mako:github-authorship", "usage"],
  ["mako:github-authorship-save", "usage"],
  ["mako:github-status", "git"],
  ["mako:github-token", "usage"],
  ["mako:github-token-remove", "usage"],
  ["mako:github-token-save", "usage"],
  ["mako:handoff", "conversations"],
  ["mako:handoff-away-held", "conversations"],
  ["mako:handoff-candidates", "conversations"],
  ["mako:handoff-run-here", "conversations"],
  ["mako:handoff-settings", "conversations"],
  ["mako:handoff-settings-set", "conversations"],
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
  ["mako:harnesses-act", "conversations"],
  ["mako:host-log-path", "application"],
  ["mako:install-update", "application"],
  ["mako:installation-state", "application"],
  ["mako:integrations", "tools"],
  ["mako:keep-awake", "conversations"],
  ["mako:keep-awake-set", "conversations"],
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
  ["mako:live-continue-turn", "conversations"],
  ["mako:live-earlier", "conversations"],
  ["mako:live-edit-queued", "conversations"],
  ["mako:live-files-find", "conversations"],
  ["mako:live-files-folders", "conversations"],
  ["mako:live-files-grep", "conversations"],
  ["mako:live-fork", "conversations"],
  ["mako:live-goal", "conversations"],
  ["mako:live-hold-until", "conversations"],
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
  ["mako:live-turn-hunks", "conversations"],
  ["mako:live-turn-undo", "conversations"],
  ["mako:live-turn-undo-preview", "conversations"],
  ["mako:live-turn-writers", "conversations"],
  ["mako:lost-versions", "attribution"],
  ["mako:machine-leaving", "application"],
  ["mako:machine-woke", "application"],
  ["mako:mako-footprint", "usage"],
  ["mako:mcp-discover", "tools"],
  ["mako:mcp-sync-apply", "tools"],
  ["mako:mcp-sync-preview", "tools"],
  ["mako:measure-update-again", "application"],
  ["mako:merge-pull", "git"],
  ["mako:model-connection-add", "harnesses"],
  ["mako:model-connection-check", "harnesses"],
  ["mako:model-connection-enable", "harnesses"],
  ["mako:model-connection-local", "harnesses"],
  ["mako:model-connection-remove", "harnesses"],
  ["mako:model-connection-test", "harnesses"],
  ["mako:model-connections", "harnesses"],
  ["mako:move-arrive", "conversations"],
  ["mako:move-depart", "conversations"],
  ["mako:move-follow", "conversations"],
  ["mako:move-ready", "conversations"],
  ["mako:move-stage", "conversations"],
  ["mako:move-stay", "conversations"],
  ["mako:native-authoring-apply", "tools"],
  ["mako:native-authoring-catalog", "tools"],
  ["mako:native-authoring-preview", "tools"],
  ["mako:native-authoring-view", "tools"],
  ["mako:native-dismiss", "conversations"],
  ["mako:native-edit-queued", "conversations"],
  ["mako:native-receipt", "conversations"],
  ["mako:native-requests", "conversations"],
  ["mako:native-routing", "conversations"],
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
  ["mako:resolve-turn-media", "media"],
  ["mako:restore-version", "attribution"],
  ["mako:reveal", "workspaces"],
  ["mako:reveal-plugins", "tools"],
  ["mako:run-automation", "workspaces"],
  ["mako:run-command", "workspaces"],
  ["mako:save-automations", "workspaces"],
  ["mako:search", "workspaces"],
  ["mako:select-update-source", "application"],
  ["mako:session-reader-history", "threads"],
  ["mako:set-active-tools", "workspaces"],
  ["mako:set-auto-compaction", "workspaces"],
  ["mako:set-cwd", "workspaces"],
  ["mako:set-model", "workspaces"],
  ["mako:set-name", "workspaces"],
  ["mako:set-thinking", "workspaces"],
  ["mako:settings-act", "conversations"],
  ["mako:setup", "workspaces"],
  ["mako:setup-act", "workspaces"],
  ["mako:shutdown-ack", "application"],
  ["mako:simulator-setup", "control"],
  ["mako:simulator-setup-press", "control"],
  ["mako:simulators-act", "control"],
  ["mako:simulators-list", "control"],
  ["mako:simulators-open", "control"],
  ["mako:simulators-read", "control"],
  ["mako:simulators-record", "control"],
  ["mako:simulators-release", "control"],
  ["mako:simulators-shot", "control"],
  ["mako:simulators-watch", "control"],
  ["mako:skills-discover", "tools"],
  ["mako:skills-remove-preview", "tools"],
  ["mako:skills-resolve", "tools"],
  ["mako:skills-sync-apply", "tools"],
  ["mako:skills-sync-preview", "tools"],
  ["mako:stage-file", "workspaces"],
  ["mako:stage-file-path", "workspaces"],
  ["mako:storage", "usage"],
  ["mako:storage-free", "usage"],
  ["mako:store-formats", "threads"],
  ["mako:stream-original", "threads"],
  ["mako:sync-readings", "conversations"],
  ["mako:sync-status", "conversations"],
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
  ["mako:thread-continue", "conversations"],
  ["mako:thread-continue-offer", "conversations"],
  ["mako:thread-controls", "threads"],
  ["mako:thread-create-session", "threads"],
  ["mako:thread-entry", "threads"],
  ["mako:thread-file", "threads"],
  ["mako:thread-follow", "threads"],
  ["mako:thread-groups", "threads"],
  ["mako:thread-harness-check", "conversations"],
  ["mako:thread-move", "conversations"],
  ["mako:thread-open", "threads"],
  ["mako:thread-original", "threads"],
  ["mako:thread-owner-resolve", "conversations"],
  ["mako:thread-page", "threads"],
  ["mako:thread-preview", "threads"],
  ["mako:thread-purposes", "threads"],
  ["mako:thread-remember-mode", "threads"],
  ["mako:thread-rename", "threads"],
  ["mako:thread-restore-plan", "conversations"],
  ["mako:thread-return", "conversations"],
  ["mako:thread-run", "conversations"],
  ["mako:thread-scratch", "workspaces"],
  ["mako:thread-scratch-set", "workspaces"],
  ["mako:thread-stop", "threads"],
  ["mako:thread-titles", "threads"],
  ["mako:thread-titles-import", "threads"],
  ["mako:thread-unfollow", "threads"],
  ["mako:threads", "threads"],
  ["mako:threads-act", "conversations"],
  ["mako:threads-move", "conversations"],
  ["mako:transcript-document", "conversations"],
  ["mako:unread-records", "threads"],
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
  ["mako:worktree-retention", "workspaces"],
  ["mako:worktree-retention-set", "workspaces"],
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
