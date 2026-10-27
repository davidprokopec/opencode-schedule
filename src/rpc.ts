import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

/**
 * Typed RPC the server half exposes to clients that cannot run the TUI's
 * slash commands, such as the desktop app's Waits panel.
 *
 * Shared by the server and the GUI bundle, so it may only import modules the
 * desktop app provides to both: `effect` and `@opencode/plugin/rpc`. Every
 * method is scoped to the session the caller names; the server never returns
 * or cancels another session's waits.
 */

/**
 * Same shape as `Session.ID` from `@opencode/schema/session`, redeclared here
 * because that module is not provided to GUI bundles. The shared `SessionID`
 * brand keeps decoded values assignable to `Session.ID` on the server.
 */
const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))

/** A pending wait as clients see it. Plain JSON, so it crosses the wire as is. */
export const WaitRow = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  prompt: Schema.String,
  /** Epoch millis when the wait was created. */
  createdAt: Schema.Number,
  /** Epoch millis when the prompt is delivered. */
  firesAt: Schema.Number,
  /** Delivery attempts already made; non-zero means it is being retried. */
  attempts: Schema.Number,
})
export type WaitRow = typeof WaitRow.Type

const SessionInput = Schema.Struct({ sessionID: SessionID })

/**
 * Clients only accept Standard Schema or JSON Schema contracts, so every
 * schema is wrapped. The result is still an Effect schema, which keeps the
 * server handlers' decoded types.
 */
const portable = Schema.toStandardSchemaV1

export const WaitsRpc = Rpc.define({
  id: "opencode-waits",
  methods: {
    /** Pending waits of one session, soonest first. */
    list: {
      input: portable(SessionInput),
      output: portable(Schema.Array(WaitRow)),
    },
    /** Schedules `prompt` to be sent to the session after `duration`, e.g. "1h30m". */
    schedule: {
      input: portable(
        Schema.Struct({
          sessionID: SessionID,
          duration: Schema.String,
          prompt: Schema.String,
        }),
      ),
      output: portable(WaitRow),
      errors: {
        /** `duration` could not be parsed, is not positive, or exceeds the maximum. */
        invalid_duration: portable(Schema.Struct({ input: Schema.String, reason: Schema.String })),
        /** `prompt` is empty once trimmed. */
        invalid_prompt: portable(Schema.Struct({ reason: Schema.String })),
        /** No such session on this server, so the prompt could never be delivered. */
        session_not_found: portable(Schema.Struct({ sessionID: Schema.String })),
      },
    },
    /** `true` when this call cancelled the wait; `false` when it was not pending in the session. */
    cancel: {
      input: portable(Schema.Struct({ sessionID: SessionID, id: Schema.String })),
      output: portable(Schema.Boolean),
    },
    /** Cancels every pending wait in the session and returns how many it cancelled. */
    cancelAll: {
      input: portable(SessionInput),
      output: portable(Schema.Number),
    },
  },
  events: {},
})
