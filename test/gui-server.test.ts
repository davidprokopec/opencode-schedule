import { describe, expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Duration, Effect, Layer, Queue, type Scope } from "effect"
import { TestClock } from "effect/testing"
import * as Delivery from "../src/delivery.ts"
import type { Wait } from "../src/domain.ts"
import * as GuiServer from "../src/gui-server.ts"
import { WaitsRpc } from "../src/rpc.ts"
import * as Store from "../src/store.ts"
import * as Supervisor from "../src/supervisor.ts"

const root = "/waits"

const enoent = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" })

const eexist = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" })

/** Same in-memory `Store.FileSystem` fake as `test/supervisor.test.ts`, kept
 * local so this file stands on its own like the others. */
const makeMemoryFileSystem = (): { fs: Store.FileSystem; files: Map<string, string> } => {
  const files = new Map<string, string>()

  const fs: Store.FileSystem = {
    mkdir: async () => {},
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`
      const names: Array<string> = []
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (!rest.includes("/")) names.push(rest)
      }
      return names
    },
    readFile: async (path) => {
      const contents = files.get(path)
      if (contents === undefined) throw enoent(path)
      return contents
    },
    writeNew: async (path, contents) => {
      if (files.has(path)) throw eexist(path)
      files.set(path, contents)
    },
    writeOver: async (path, contents) => {
      files.set(path, contents)
    },
    remove: async (path) => {
      if (!files.has(path)) throw enoent(path)
      files.delete(path)
    },
    claim: async (path) => {
      if (!files.has(path)) return false
      files.delete(path)
      return true
    },
  }

  return { fs, files }
}

/** Records every delivery, i.e. every prompt that would start a model turn. */
const makeDelivery = () => {
  const delivered: Array<Wait> = []
  const attempts = Effect.runSync(Queue.unbounded<Wait>())

  const layer = Layer.succeed(
    Delivery.Service,
    Delivery.Service.of({
      deliver: (wait) =>
        Queue.offer(attempts, wait).pipe(
          Effect.andThen(Effect.sync(() => delivered.push(wait))),
          Effect.as(true),
        ),
    }),
  )

  return { layer, delivered, attempts }
}

const makeProbe = (alive: (sessionID: Session.ID) => boolean): Supervisor.SessionProbe => ({
  exists: (sessionID) => Effect.sync(() => alive(sessionID)),
})

interface Fixture {
  readonly service: GuiServer.Service
  readonly supervisor: Supervisor.Interface
}

/** Builds the RPC service over a real supervisor and store, on a `TestClock`,
 * and tears every timer down once `body` completes. */
const run = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>,
  options: {
    readonly files?: ReturnType<typeof makeMemoryFileSystem>
    readonly delivery?: ReturnType<typeof makeDelivery>
    readonly alive?: (sessionID: Session.ID) => boolean
  } = {},
): Promise<A> => {
  const { fs } = options.files ?? makeMemoryFileSystem()
  const delivery = options.delivery ?? makeDelivery()
  const probe = makeProbe(options.alive ?? (() => true))
  const store = Store.make(fs, root)

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.make(store, probe)
        return yield* body({ service: GuiServer.make(supervisor, probe), supervisor })
      }),
    ).pipe(Effect.provide(delivery.layer), Effect.provide(TestClock.layer())),
  )
}

describe("WaitsRpc contract", () => {
  test("exposes exactly list, schedule, cancel and cancelAll", () => {
    expect(Object.keys(WaitsRpc.methods).sort()).toEqual([
      "cancel",
      "cancelAll",
      "list",
      "schedule",
    ])
    expect(Object.keys(WaitsRpc.events)).toEqual([])
  })

  test("every schema is a Standard Schema, as clients require", () => {
    const methods = Object.values(WaitsRpc.methods)
    for (const method of methods) {
      expect(method.input["~standard"].version).toBe(1)
      expect(method.output["~standard"].version).toBe(1)
    }
    for (const error of Object.values(WaitsRpc.methods.schedule.errors)) {
      expect(error["~standard"].version).toBe(1)
    }
  })

  test("rejects a session id that is not one", async () => {
    const valid = await WaitsRpc.methods.list.input["~standard"].validate({
      sessionID: Session.ID.create(),
    })
    expect(valid.issues).toBeUndefined()

    const invalid = await WaitsRpc.methods.list.input["~standard"].validate({ sessionID: "w1" })
    expect(invalid.issues?.length).toBeGreaterThan(0)

    const missing = await WaitsRpc.methods.schedule.input["~standard"].validate({
      sessionID: Session.ID.create(),
      duration: "1m",
    })
    expect(missing.issues?.length).toBeGreaterThan(0)
  })

  test("a WaitRow round-trips through the output schema unchanged", async () => {
    const row = {
      id: "w1",
      sessionID: "ses_1",
      prompt: "ping",
      createdAt: 1,
      firesAt: 2,
      attempts: 0,
    }
    const result = await WaitsRpc.methods.schedule.output["~standard"].validate(row)
    expect(result.issues).toBeUndefined()
    expect("value" in result ? result.value : undefined).toEqual(row)
  })
})

describe("schedule", () => {
  test("persists a timer through the supervisor without starting a model turn", async () => {
    const files = makeMemoryFileSystem()
    const delivery = makeDelivery()
    const sessionID = Session.ID.create()

    const row = await run(
      ({ service }) =>
        Effect.gen(function* () {
          const row = yield* service.schedule({ sessionID, duration: "10m", prompt: "  ping  " })
          // Scheduling alone must not prompt the session.
          expect(delivery.delivered).toHaveLength(0)
          expect(files.files.has(`${root}/${row.id}.json`)).toBe(true)

          yield* TestClock.adjust(Duration.minutes(10))
          const fired = yield* Queue.take(delivery.attempts)
          expect(fired.id).toBe(row.id)
          return row
        }),
      { files, delivery },
    )

    expect(row).toEqual({
      id: row.id,
      sessionID,
      prompt: "ping",
      createdAt: 0,
      firesAt: Duration.toMillis(Duration.minutes(10)),
      attempts: 0,
    })
    expect(delivery.delivered.map((wait) => wait.prompt)).toEqual(["ping"])
  })

  test("rejects an empty prompt and persists nothing", async () => {
    const files = makeMemoryFileSystem()

    const failure = await run(
      ({ service }) =>
        service
          .schedule({ sessionID: Session.ID.create(), duration: "1m", prompt: " \n\t " })
          .pipe(Effect.flip),
      { files },
    )

    expect(failure).toEqual({
      type: "invalid_prompt",
      message: "Nothing to schedule: a prompt is required.",
      data: { reason: "prompt is empty" },
    })
    expect(files.files.size).toBe(0)
  })

  test.each([
    ["1parsec", 'unknown unit "parsec"'],
    ["soon", 'expected a number at "soon"'],
    ["", "no duration given"],
    ["0s", "duration must be greater than zero"],
    ["31d", "duration must not exceed 30d"],
  ])("rejects the duration %p", async (duration, reason) => {
    const files = makeMemoryFileSystem()

    const failure = await run(
      ({ service }) =>
        service
          .schedule({ sessionID: Session.ID.create(), duration, prompt: "ping" })
          .pipe(Effect.flip),
      { files },
    )

    expect(failure.type).toBe("invalid_duration")
    expect(failure.data).toEqual({ input: duration, reason })
    expect(failure.message).toBe(`Invalid duration ${JSON.stringify(duration)}: ${reason}`)
    expect(files.files.size).toBe(0)
  })

  test("rejects a session that does not exist", async () => {
    const files = makeMemoryFileSystem()
    const sessionID = Session.ID.create()

    const failure = await run(
      ({ service }) =>
        service.schedule({ sessionID, duration: "1m", prompt: "ping" }).pipe(Effect.flip),
      { files, alive: () => false },
    )

    expect(failure).toEqual({
      type: "session_not_found",
      message: `Session ${sessionID} does not exist.`,
      data: { sessionID },
    })
    expect(files.files.size).toBe(0)
  })
})

describe("list", () => {
  test("returns only the named session's waits, soonest first", async () => {
    const mine = Session.ID.create()
    const theirs = Session.ID.create()

    const [listed, others, empty] = await run(({ service }) =>
      Effect.gen(function* () {
        yield* service.schedule({ sessionID: mine, duration: "2h", prompt: "later" })
        yield* service.schedule({ sessionID: theirs, duration: "1m", prompt: "not mine" })
        yield* service.schedule({ sessionID: mine, duration: "1h", prompt: "sooner" })
        return [
          yield* service.list(mine),
          yield* service.list(theirs),
          yield* service.list(Session.ID.create()),
        ] as const
      }),
    )

    expect(listed.map((row) => row.prompt)).toEqual(["sooner", "later"])
    expect(listed.every((row) => row.sessionID === mine)).toBe(true)
    expect(others.map((row) => row.prompt)).toEqual(["not mine"])
    expect(empty).toEqual([])
  })

  test("sees waits the TUI wrote straight to the store", async () => {
    const files = makeMemoryFileSystem()
    const sessionID = Session.ID.create()
    const store = Store.make(files.fs, root)
    await Effect.runPromise(
      store.create({
        sessionID,
        prompt: "from the tui",
        duration: Duration.minutes(5),
        createdAt: 0,
        firesAt: Duration.toMillis(Duration.minutes(5)),
      }),
    )

    const listed = await run(({ service }) => service.list(sessionID), { files })

    expect(listed.map((row) => row.prompt)).toEqual(["from the tui"])
  })
})

describe("cancel", () => {
  test("cancels once, then reports the wait as gone", async () => {
    const files = makeMemoryFileSystem()
    const delivery = makeDelivery()
    const sessionID = Session.ID.create()

    const [first, second, remaining] = await run(
      ({ service }) =>
        Effect.gen(function* () {
          const row = yield* service.schedule({ sessionID, duration: "1m", prompt: "ping" })
          const first = yield* service.cancel(sessionID, row.id)
          const second = yield* service.cancel(sessionID, row.id)
          // The timer is gone too, not just the record.
          yield* TestClock.adjust(Duration.minutes(5))
          return [first, second, yield* service.list(sessionID)] as const
        }),
      { files, delivery },
    )

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(remaining).toEqual([])
    expect(files.files.size).toBe(0)
    expect(delivery.delivered).toHaveLength(0)
  })

  test("cannot cancel another session's wait", async () => {
    const owner = Session.ID.create()
    const intruder = Session.ID.create()

    const [cancelled, remaining] = await run(({ service }) =>
      Effect.gen(function* () {
        const row = yield* service.schedule({ sessionID: owner, duration: "1m", prompt: "ping" })
        return [yield* service.cancel(intruder, row.id), yield* service.list(owner)] as const
      }),
    )

    expect(cancelled).toBe(false)
    expect(remaining.map((row) => row.prompt)).toEqual(["ping"])
  })

  test("an unknown id is not found", async () => {
    const cancelled = await run(({ service }) => service.cancel(Session.ID.create(), "w404"))
    expect(cancelled).toBe(false)
  })

  test("accepts an id pasted with surrounding whitespace", async () => {
    const sessionID = Session.ID.create()
    const cancelled = await run(({ service }) =>
      Effect.gen(function* () {
        const row = yield* service.schedule({ sessionID, duration: "1m", prompt: "ping" })
        return yield* service.cancel(sessionID, ` ${row.id}\n`)
      }),
    )
    expect(cancelled).toBe(true)
  })

  test("losing to the timer reports false: the prompt was already delivered", async () => {
    const delivery = makeDelivery()
    const sessionID = Session.ID.create()

    const cancelled = await run(
      ({ service }) =>
        Effect.gen(function* () {
          const row = yield* service.schedule({ sessionID, duration: "1m", prompt: "ping" })
          yield* TestClock.adjust(Duration.minutes(1))
          yield* Queue.take(delivery.attempts)
          return yield* service.cancel(sessionID, row.id)
        }),
      { delivery },
    )

    expect(cancelled).toBe(false)
    expect(delivery.delivered).toHaveLength(1)
  })

  test("concurrent cancels of one wait: exactly one succeeds", async () => {
    const sessionID = Session.ID.create()

    const results = await run(({ service }) =>
      Effect.gen(function* () {
        const row = yield* service.schedule({ sessionID, duration: "1m", prompt: "ping" })
        return yield* Effect.all(
          [service.cancel(sessionID, row.id), service.cancel(sessionID, row.id)],
          { concurrency: "unbounded" },
        )
      }),
    )

    expect(results.filter((result) => result)).toHaveLength(1)
  })
})

describe("cancelAll", () => {
  test("cancels only the named session's waits and counts them", async () => {
    const delivery = makeDelivery()
    const mine = Session.ID.create()
    const theirs = Session.ID.create()

    const [count, again, mineLeft, theirsLeft] = await run(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.schedule({ sessionID: mine, duration: "1m", prompt: "a" })
          yield* service.schedule({ sessionID: mine, duration: "2m", prompt: "b" })
          yield* service.schedule({ sessionID: theirs, duration: "3m", prompt: "c" })
          const count = yield* service.cancelAll(mine)
          const again = yield* service.cancelAll(mine)
          const lists = [yield* service.list(mine), yield* service.list(theirs)] as const
          yield* TestClock.adjust(Duration.minutes(3))
          yield* Queue.take(delivery.attempts)
          return [count, again, ...lists] as const
        }),
      { delivery },
    )

    expect(count).toBe(2)
    expect(again).toBe(0)
    expect(mineLeft).toEqual([])
    expect(theirsLeft.map((row) => row.prompt)).toEqual(["c"])
    // Only the other session's wait ever reached a model.
    expect(delivery.delivered.map((wait) => wait.prompt)).toEqual(["c"])
  })

  test("does not count a wait the timer delivered first", async () => {
    const delivery = makeDelivery()
    const sessionID = Session.ID.create()

    const count = await run(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.schedule({ sessionID, duration: "1m", prompt: "due" })
          yield* service.schedule({ sessionID, duration: "1h", prompt: "pending" })
          yield* TestClock.adjust(Duration.minutes(1))
          yield* Queue.take(delivery.attempts)
          return yield* service.cancelAll(sessionID)
        }),
      { delivery },
    )

    expect(count).toBe(1)
    expect(delivery.delivered.map((wait) => wait.prompt)).toEqual(["due"])
  })
})
