import { Tool } from "@opencode/schema/tool"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import type { Wait } from "../shared/domain.ts"
import * as WaitDuration from "../shared/duration.ts"
import type { Interface as Scheduler } from "./supervisor.ts"

/** `now` is passed in rather than read from `Date`, so it comes from the same
 * clock that produced `firesAt`. */
const describe = (wait: Wait, now: number): string =>
  `${wait.id}  in ${Duration.format(Duration.millis(Math.max(0, wait.firesAt - now)))}` +
  ` (at ${new Date(wait.firesAt).toISOString()})  ${JSON.stringify(wait.prompt)}`

/** Canonical tool names. The `wait_*` names registered alongside them are
 * compatibility aliases for sessions whose history still refers to them. */
export const names = {
  schedule: "schedule_create",
  list: "schedule_list",
  cancel: "schedule_cancel",
} as const

export const legacyNames = {
  schedule: "wait_schedule",
  list: "wait_list",
  cancel: "wait_cancel",
} as const

const aliasNote = (canonical: string): string =>
  ` Compatibility alias of ${canonical}; prefer ${canonical}.`

const scheduleTool = (scheduler: Scheduler, name: string, note = "") =>
  ({
    name,
    description:
      "Schedule a prompt to be sent back to this session after a delay. Returns immediately; " +
      "the prompt is delivered later without any further action. Use this instead of sleeping." +
      note,
    input: Schema.Struct({
      duration: Schema.String.annotate({
        description: 'How long to wait, e.g. "60s", "1hour", "2h30m", "3 days".',
      }),
      prompt: Schema.String.annotate({
        description: "The prompt text to send once the delay has elapsed, verbatim.",
      }),
    }),
    options: { codemode: false },
    execute: Effect.fn(name)(function* (input, context) {
      const prompt = input.prompt.trim()
      if (prompt === "") {
        return yield* Effect.fail(
          new Tool.Error({
            message:
              "Nothing to schedule: a prompt is required, e.g. /schedule 1hour implement this",
          }),
        )
      }

      const duration = yield* WaitDuration.parse(input.duration).pipe(
        Effect.mapError((error) => new Tool.Error({ message: error.display })),
      )

      const wait = yield* scheduler.schedule({
        sessionID: context.sessionID,
        prompt,
        duration,
      })

      return {
        content:
          `Scheduled ${wait.id}: this prompt will be sent in ${Duration.format(duration)} ` +
          `(at ${new Date(wait.firesAt).toISOString()}). ` +
          `Cancel with /schedule-cancel ${wait.id}.` +
          // A `mem-` id means the store could not persist it; it still fires
          // in this process but will not survive a restart.
          (wait.id.startsWith("mem-")
            ? " It could not be saved, so it will be lost if OpenCode restarts."
            : " It is saved and survives an OpenCode restart."),
      }
    }),
  }) satisfies Tool.Info

const listTool = (scheduler: Scheduler, name: string, note = "") =>
  ({
    name,
    description: `List the prompts scheduled by ${names.schedule} that are still pending.${note}`,
    // Declared as raw JSON Schema rather than `Schema.Struct({})`, which
    // generates `anyOf: [object, array]` with no top-level `type`. Anthropic
    // rejects every request in the session when a tool schema omits `type`.
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: Effect.fn(name)(function* (_input: unknown, context) {
      const waits = yield* scheduler.list(context.sessionID)
      if (waits.length === 0) return { content: "No pending scheduled prompts in this session." }
      const now = yield* Clock.currentTimeMillis
      return {
        content: [
          `${waits.length} pending scheduled prompt(s):`,
          ...waits.map((wait) => describe(wait, now)),
        ].join("\n"),
      }
    }),
  }) satisfies Tool.Info

const cancelTool = (scheduler: Scheduler, name: string, note = "") =>
  ({
    name,
    description: `Cancel a scheduled prompt by id, or every scheduled prompt in this session.${note}`,
    input: Schema.Struct({
      id: Schema.optional(
        Schema.String.annotate({ description: `Id returned by ${names.schedule}, e.g. "w1".` }),
      ),
      all: Schema.optional(
        Schema.Boolean.annotate({
          description: "Cancel every scheduled prompt in this session.",
        }),
      ),
    }),
    options: { codemode: false },
    execute: Effect.fn(name)(function* (input, context) {
      // `Schema.optional` renders as `anyOf: [string, null]`, so a provider may
      // legitimately send null rather than omitting the field.
      const id = typeof input.id === "string" ? input.id.trim() : ""

      if (input.all === true) {
        const cancelled = yield* scheduler.cancelAll(context.sessionID)
        if (cancelled.length === 0) return { content: "No pending scheduled prompts to cancel." }
        return {
          content: `Cancelled ${cancelled.length} scheduled prompt(s): ${cancelled.map((wait) => wait.id).join(", ")}`,
        }
      }

      if (id === "") {
        const waits = yield* scheduler.list(context.sessionID)
        return yield* Effect.fail(
          new Tool.Error({
            message:
              waits.length === 0
                ? "No pending scheduled prompts in this session."
                : `Specify which scheduled prompt to cancel, or pass all: true. Pending: ${waits
                    .map((wait) => wait.id)
                    .join(", ")}`,
          }),
        )
      }

      const cancelled = yield* scheduler.cancel(context.sessionID, id)
      if (Option.isNone(cancelled)) {
        const waits = yield* scheduler.list(context.sessionID)
        return yield* Effect.fail(
          new Tool.Error({
            message: `No pending scheduled prompt ${JSON.stringify(id)} in this session.${
              waits.length === 0 ? "" : ` Pending: ${waits.map((wait) => wait.id).join(", ")}`
            }`,
          }),
        )
      }

      return {
        content: `Cancelled ${cancelled.value.id}: ${JSON.stringify(cancelled.value.prompt)}`,
      }
    }),
  }) satisfies Tool.Info

/** Canonical tools first, then the `wait_*` compatibility aliases, which
 * share the same executors and input schemas. */
export const all = (scheduler: Scheduler): ReadonlyArray<Tool.Info> => [
  scheduleTool(scheduler, names.schedule),
  listTool(scheduler, names.list),
  cancelTool(scheduler, names.cancel),
  scheduleTool(scheduler, legacyNames.schedule, aliasNote(names.schedule)),
  listTool(scheduler, legacyNames.list, aliasNote(names.list)),
  cancelTool(scheduler, legacyNames.cancel, aliasNote(names.cancel)),
]
