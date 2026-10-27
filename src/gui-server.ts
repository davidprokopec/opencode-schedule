import type { Plugin } from "@opencode/plugin/effect"
import type { Session } from "@opencode/schema/session"
import { Effect, Option, type Scope } from "effect"
import type { Wait } from "./domain.ts"
import * as WaitDuration from "./duration.ts"
import { type WaitRow, WaitsRpc } from "./rpc.ts"
import type { Interface as Scheduler, SessionProbe } from "./supervisor.ts"

/** A declared `schedule` error, mirroring `WaitsRpc.methods.schedule.errors`. */
export type ScheduleFailure =
  | {
      readonly type: "invalid_duration"
      readonly message: string
      readonly data: { readonly input: string; readonly reason: string }
    }
  | {
      readonly type: "invalid_prompt"
      readonly message: string
      readonly data: { readonly reason: string }
    }
  | {
      readonly type: "session_not_found"
      readonly message: string
      readonly data: { readonly sessionID: string }
    }

export interface Service {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<WaitRow>>
  readonly schedule: (input: {
    readonly sessionID: Session.ID
    readonly duration: string
    readonly prompt: string
  }) => Effect.Effect<WaitRow, ScheduleFailure>
  readonly cancel: (sessionID: Session.ID, id: string) => Effect.Effect<boolean>
  readonly cancelAll: (sessionID: Session.ID) => Effect.Effect<number>
}

export const toRow = (wait: Wait): WaitRow => ({
  id: wait.id,
  sessionID: wait.sessionID,
  prompt: wait.prompt,
  createdAt: wait.createdAt,
  firesAt: wait.firesAt,
  attempts: wait.attempts,
})

/**
 * The RPC's behaviour, independent of the RPC transport so it can be tested
 * against a real supervisor. Timers, persistence and cancellation all stay with
 * the supervisor; this only validates input and shapes the results.
 */
export const make = (scheduler: Scheduler, probe: SessionProbe): Service => ({
  list: (sessionID) => scheduler.list(sessionID).pipe(Effect.map((waits) => waits.map(toRow))),
  schedule: Effect.fn("WaitsRpc.schedule")(function* (input) {
    const prompt = input.prompt.trim()
    if (prompt === "") {
      return yield* Effect.fail<ScheduleFailure>({
        type: "invalid_prompt",
        message: "Nothing to schedule: a prompt is required.",
        data: { reason: "prompt is empty" },
      })
    }

    const duration = yield* WaitDuration.parse(input.duration).pipe(
      Effect.mapError(
        (error): ScheduleFailure => ({
          type: "invalid_duration",
          message: error.display,
          data: { input: error.input, reason: error.reason },
        }),
      ),
    )

    // Checked before scheduling: a wait for a missing session would only be
    // dropped once it matured, long after the caller could have been told.
    const alive = yield* probe.exists(input.sessionID)
    if (!alive) {
      return yield* Effect.fail<ScheduleFailure>({
        type: "session_not_found",
        message: `Session ${input.sessionID} does not exist.`,
        data: { sessionID: input.sessionID },
      })
    }

    const wait = yield* scheduler.schedule({ sessionID: input.sessionID, prompt, duration })
    return toRow(wait)
  }),
  cancel: (sessionID, id) => scheduler.cancel(sessionID, id.trim()).pipe(Effect.map(Option.isSome)),
  cancelAll: (sessionID) =>
    scheduler.cancelAll(sessionID).pipe(Effect.map((cancelled) => cancelled.length)),
})

/**
 * Registers `WaitsRpc` for the lifetime of the plugin scope.
 *
 * A server that cannot register it, for example one predating plugin RPC,
 * still gets the tools and commands, so the failure is logged, not raised.
 */
export const register = (
  rpc: Plugin.Context["rpc"],
  service: Service,
): Effect.Effect<void, never, Scope.Scope> =>
  rpc
    .register(WaitsRpc, {
      list: (input) => service.list(input.sessionID),
      schedule: (input, context) =>
        service.schedule(input).pipe(
          Effect.mapError((failure) => {
            switch (failure.type) {
              case "invalid_duration":
                return context.error(failure.type, failure.message, failure.data)
              case "invalid_prompt":
                return context.error(failure.type, failure.message, failure.data)
              case "session_not_found":
                return context.error(failure.type, failure.message, failure.data)
            }
          }),
        ),
      cancel: (input) => service.cancel(input.sessionID, input.id),
      cancelAll: (input) => service.cancelAll(input.sessionID),
    })
    .pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logError("opencode-waits: could not register the Waits RPC", cause),
      ),
    )
