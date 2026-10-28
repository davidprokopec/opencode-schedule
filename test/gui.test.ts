import { describe, expect, test } from "bun:test"
import type { Context, Command as GuiCommand, MountedSession } from "@opencode/plugin/gui"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import {
  createSessionScope,
  errorMessage,
  parseWaitArguments,
  remaining,
} from "../src/gui/utils.ts"

// Bun shares one module cache across test files. `@opencode/plugin/gui` pulls
// in solid-js, and without OpenTUI's plugin Bun resolves its server build,
// which then breaks the Solid sidebar tests that run later. Register the same
// plugin those tests use before loading the GUI SDK (see sidebar.test.ts).
ensureSolidTransformPlugin()
const { Command } = await import("@opencode/plugin/gui")
const { registerWaitCommands } = await import("../src/gui/commands.ts")

function commandHarness() {
  const commands = new Map<string, GuiCommand>()
  const calls: string[] = []
  const notices: Array<{ title: string; description?: string; variant?: string }> = []
  const opened: string[] = []
  const prompts: string[] = []
  let current: MountedSession | undefined
  let failSchedule: unknown
  let failCancel = false
  const session = (id: string) =>
    ({
      id,
      key: `server\n${id}`,
      prompt: (input: { text: string }) => prompts.push(input.text),
      server: {
        client: {
          rpc: () => ({
            list: async ({ sessionID }: { sessionID: string }) => {
              calls.push(`list:${sessionID}`)
              return []
            },
            schedule: async ({
              sessionID,
              duration,
              prompt,
            }: {
              sessionID: string
              duration: string
              prompt: string
            }) => {
              calls.push(`schedule:${sessionID}:${duration}:${prompt}`)
              if (failSchedule !== undefined) throw failSchedule
              return {
                id: "w1",
                sessionID,
                duration,
                prompt,
                createdAt: 1,
                firesAt: 2,
                attempts: 0,
              }
            },
            cancel: async ({ sessionID, id }: { sessionID: string; id: string }) => {
              calls.push(`cancel:${sessionID}:${id}`)
              if (failCancel) throw new Error("server rejected cancel")
              return true
            },
            cancelAll: async ({ sessionID }: { sessionID: string }) => {
              calls.push(`cancelAll:${sessionID}`)
              return 2
            },
          }),
        },
      },
    }) as unknown as MountedSession
  const ctx = {
    id: "opencode2-waits",
    t: (key: string) => key,
    add: (registry: unknown, contribution: unknown) => {
      if (registry === Command) {
        const command =
          typeof contribution === "function"
            ? (contribution as () => GuiCommand)()
            : (contribution as GuiCommand)
        commands.set(command.id, command)
      }
      return () => {}
    },
    sessions: { current: () => current },
    layout: { open: (key: string) => opened.push(key) },
    toast: {
      show: (notice: { title: string; description?: string; variant?: string }) => {
        notices.push(notice)
        return { dismiss: () => {} }
      },
    },
  } as unknown as Context
  registerWaitCommands(ctx)
  return {
    commands,
    calls,
    notices,
    opened,
    prompts,
    setSession: (id?: string) => {
      current = id ? session(id) : undefined
    },
    failSchedule: (cause: unknown = new Error("server rejected schedule")) => {
      failSchedule = cause
    },
    failCancel: () => {
      failCancel = true
    },
  }
}

describe("GUI wait helpers", () => {
  test("parses the first word as delay and preserves the prompt", () => {
    expect(parseWaitArguments("  1hour  implement the fix carefully  ")).toEqual({
      duration: "1hour",
      prompt: "implement the fix carefully",
    })
  })

  test("rejects missing delay or prompt", () => {
    expect(parseWaitArguments("")).toBeUndefined()
    expect(parseWaitArguments("1hour")).toBeUndefined()
  })

  test("formats remaining time and clamps expired waits", () => {
    expect(remaining(60_000, 0)).toBe("in 1m")
    expect(remaining(3_600_000, 0)).toBe("in 1h")
    expect(remaining(0, 1_000)).toBe("in 0s")
  })

  test("never overstates remaining time at minute and hour boundaries", () => {
    // Exactly 1h, and a fresh 1h wait read a few ms (or a stale 400 ms) late.
    expect(remaining(3_600_000, 0)).toBe("in 1h")
    expect(remaining(3_600_000, 3)).toBe("in 1h")
    expect(remaining(3_600_400, 0)).toBe("in 1h")
    expect(remaining(3_601_000, 0)).toBe("in 1h")
    // Just below 2h must not render a 60m remainder or round up to 2h.
    expect(remaining(7_199_000, 0)).toBe("in 1h 59m")
    expect(remaining(7_140_001, 0)).toBe("in 1h 59m")
    expect(remaining(7_139_400, 0)).toBe("in 1h 58m")
    // Just below 1h stays in minutes without a 60m value.
    expect(remaining(3_599_000, 0)).toBe("in 59m")
    expect(remaining(119_400, 0)).toBe("in 1m")
    expect(remaining(59_400, 0)).toBe("in 59s")
  })

  test("reads messages from Error and plain typed RPC errors, else falls back", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom")
    expect(
      errorMessage(
        { type: "invalid_duration", message: 'Invalid duration "soon"', data: {} },
        "fallback",
      ),
    ).toBe('Invalid duration "soon"')
    expect(errorMessage({ type: "x", message: 42 }, "fallback")).toBe("fallback")
    expect(errorMessage({ type: "x", message: "" }, "fallback")).toBe("fallback")
    expect(errorMessage("text", "fallback")).toBe("fallback")
    expect(errorMessage(null, "fallback")).toBe("fallback")
    expect(errorMessage(undefined, "fallback")).toBe("fallback")
  })

  test("registers actual local palette/slash commands without submitting a session prompt", async () => {
    const harness = commandHarness()
    expect([...harness.commands.keys()].sort()).toEqual([
      "cancel",
      "legacy-wait",
      "legacy-wait-cancel",
      "legacy-wait-list",
      "list",
      "open",
      "wait",
    ])
    expect(harness.commands.get("wait")?.slash).toEqual({ name: "schedule", arguments: true })
    expect(harness.commands.get("cancel")?.slash).toEqual({
      name: "schedule-cancel",
      arguments: true,
    })
    expect(harness.commands.get("list")?.slash).toEqual({ name: "schedule-list", arguments: true })
    expect(harness.commands.get("legacy-wait")?.slash).toEqual({ name: "wait", arguments: true })
    expect(harness.commands.get("legacy-wait-list")?.slash).toEqual({
      name: "wait-list",
      arguments: true,
    })
    expect(harness.commands.get("legacy-wait-cancel")?.slash).toEqual({
      name: "wait-cancel",
      arguments: true,
    })

    harness.setSession("ses-current")
    await harness.commands.get("wait")?.run("2hours  send the summary back")
    expect(harness.calls).toEqual(["schedule:ses-current:2hours:send the summary back"])
    expect(harness.prompts).toEqual([])
    expect(harness.notices.at(-1)?.title).toBe("Prompt scheduled")
    await harness.commands.get("legacy-wait")?.run("2hours  send the summary back")
    expect(harness.calls.at(-1)).toBe("schedule:ses-current:2hours:send the summary back")
    await harness.commands.get("legacy-wait-list")?.run()
    expect(harness.opened.at(-1)).toBe("opencode2-waits:main")
    await harness.commands.get("legacy-wait-cancel")?.run("w123")
    expect(harness.calls.at(-1)).toBe("cancel:ses-current:w123")
  })

  test("handles invalid and sessionless /wait without making an RPC call", async () => {
    const harness = commandHarness()
    await harness.commands.get("wait")?.run("2hours")
    expect(harness.calls).toEqual([])
    expect(harness.notices.at(-1)?.title).toBe("Add a delay and prompt")

    harness.setSession()
    await harness.commands.get("wait")?.run("2hours do it")
    expect(harness.calls).toEqual([])
    expect(harness.notices.at(-1)?.title).toBe("No session open")
  })

  test("runs /wait-cancel by ID or all and reports RPC errors", async () => {
    const harness = commandHarness()
    harness.setSession("ses-one")
    await harness.commands.get("cancel")?.run("w123")
    await harness.commands.get("cancel")?.run("all")
    expect(harness.calls).toEqual(["cancel:ses-one:w123", "cancelAll:ses-one"])
    expect(harness.notices.map(({ title }) => title)).toEqual([
      "Scheduled prompt cancelled.",
      "2 scheduled prompts cancelled.",
    ])

    harness.failCancel()
    await harness.commands.get("cancel")?.run("w123")
    expect(harness.notices.at(-1)?.title).toBe("Could not cancel scheduled prompt")
    expect(harness.notices.at(-1)?.description).toBe("server rejected cancel")

    harness.failSchedule()
    await harness.commands.get("wait")?.run("1m try again")
    expect(harness.notices.at(-1)?.title).toBe("Could not schedule prompt")
    expect(harness.notices.at(-1)?.description).toBe("server rejected schedule")
  })

  test("/wait shows the message of a plain-object typed RPC error", async () => {
    const harness = commandHarness()
    harness.setSession("ses-typed")
    harness.failSchedule({
      type: "invalid_duration",
      message: 'Invalid duration "soon": expected a number at "soon"',
      data: { duration: "soon" },
    })
    await harness.commands.get("wait")?.run("soon do it")
    expect(harness.calls).toEqual(["schedule:ses-typed:soon:do it"])
    expect(harness.notices.at(-1)).toEqual({
      title: "Could not schedule prompt",
      description: 'Invalid duration "soon": expected a number at "soon"',
      variant: "error",
    })

    harness.failSchedule({ type: "unknown" })
    await harness.commands.get("wait")?.run("1m retry")
    expect(harness.notices.at(-1)?.description).toBe("Try again.")
  })

  test("opens the session panel from /wait-list and explains when no session is open", async () => {
    const harness = commandHarness()
    harness.setSession("ses-list")
    await harness.commands.get("list")?.run()
    expect(harness.opened).toEqual(["opencode2-waits:main"])
    harness.setSession()
    await harness.commands.get("list")?.run()
    expect(harness.notices.at(-1)?.title).toBe("No session open")
  })

  test("invalidates completions when panel session changes or unmounts", () => {
    const scope = createSessionScope()
    const first = scope.enter("server-a\nses-a")
    expect(scope.isCurrent("server-a\nses-a", first)).toBe(true)
    const second = scope.enter("server-b\nses-a")
    expect(scope.isCurrent("server-a\nses-a", first)).toBe(false)
    expect(scope.isCurrent("server-b\nses-a", second)).toBe(true)
    scope.dispose()
    expect(scope.isCurrent("server-b\nses-a", second)).toBe(false)
  })
})
