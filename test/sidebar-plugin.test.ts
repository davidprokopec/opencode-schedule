import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { Duration, Effect } from "effect"
import type { Wait } from "../src/domain.ts"
import * as Node from "../src/node.ts"
import * as Store from "../src/store.ts"

// See sidebar.test.ts: Solid JSX needs OpenTUI's transform, registered before
// the transformed modules (`tui.ts` pulls in `sidebar.tsx`) are loaded.
ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const { createStore, produce } = await import("solid-js/store")
const { default: plugin } = await import("../src/tui.ts")

type Context = Plugin.Context
type Mounted = Awaited<ReturnType<typeof testRender>>
type Claim = Parameters<Context["ui"]["slot"]>[0]
type SidebarClaim = Extract<Claim, { readonly append: "sidebar.content" }>

const isSidebar = (claim: Claim): claim is SidebarClaim => claim.append === "sidebar.content"

const frameLines = (frame: string): ReadonlyArray<string> =>
  frame.split("\n").map((line) => line.trimEnd())

const rowOf = (frame: string, text: string): number => {
  const index = frameLines(frame).findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`"${text}" is not on screen:\n${frame}`)
  return index
}

interface SelectInput {
  readonly title: string
  readonly options: ReadonlyArray<{ readonly title: string; readonly value: string }>
}

/**
 * A host just real enough for the sidebar: Solid-backed `storage.memory` like
 * the TUI's, the slot registry, and recording stand-ins for the dialogs and
 * toasts. Everything the plugin reads from here is behaviour the real host
 * provides; nothing in the sidebar itself is faked.
 */
const makeHost = (session: string) => {
  const claims: Claim[] = []
  const selects: SelectInput[] = []
  const toasts: string[] = []
  let answer: string | undefined
  let cleared = 0

  // Only the members `setup` and the sidebar touch are provided. The full
  // Context is far larger than this test has any business building.
  const context = {
    storage: {
      memory: <Value extends object>(_key: string, options: { readonly initial: Value }) => {
        const [state, setState] = createStore<Value>(structuredClone(options.initial))
        return [state, (mutation: (draft: Value) => void) => setState(produce(mutation))] as const
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: session }) },
      slot: (claim: Claim) => {
        claims.push(claim)
        return () => {}
      },
      toast: { show: (input: { message: string }) => void toasts.push(input.message) },
      dialog: {
        select: async (input: SelectInput) => {
          selects.push(input)
          return answer
        },
        clear: () => {
          cleared += 1
        },
      },
    },
    keymap: { layer: () => {} },
    client: {},
  } as unknown as Context

  return {
    context,
    selects,
    toasts,
    answerWith: (value: string | undefined) => {
      answer = value
    },
    cleared: () => cleared,
    sidebar: (): SidebarClaim => {
      const claim = claims.find(isSidebar)
      if (claim === undefined) throw new Error("the plugin never claimed sidebar.content")
      return claim
    },
  }
}

let directory: string
let previousData: string | undefined
let mounted: Mounted | undefined
let cleanups: Array<() => void> = []
let tick: (() => void) | undefined
const slotRenderCounts = new WeakMap<object, () => number>()

const store = () => Store.make(Node.fileSystem, join(directory, "opencode-waits", "waits"))

const schedule = (input: { session: string; prompt: string; inMs: number }): Promise<Wait> =>
  Effect.runPromise(
    store().create({
      sessionID: input.session as Wait["sessionID"],
      prompt: input.prompt,
      duration: Duration.millis(input.inMs),
      createdAt: Date.now(),
      firesAt: Date.now() + input.inMs,
    }),
  )

const files = () => readdir(join(directory, "opencode-waits", "waits")).catch(() => [] as string[])

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "waits-sidebar-"))
  previousData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = directory
  // The plugin refreshes on a one second interval. Capture it so a test
  // advances time explicitly instead of sleeping.
  tick = undefined
  const realSetInterval = globalThis.setInterval
  spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    // Only the plugin's one second refresh; the renderer has its own timers.
    if (delay !== 1000) return realSetInterval(callback, delay, ...rest)
    tick = callback
    return 0
  }) as unknown as typeof setInterval)
  spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as typeof clearInterval)
})

afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
  for (const cleanup of cleanups) cleanup()
  cleanups = []
  if (previousData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousData
  await rm(directory, { recursive: true, force: true })
  mock.restore()
})

/** Activates the real plugin and mounts its sidebar claim the way a host would. */
const activate = async (host: ReturnType<typeof makeHost>): Promise<Mounted> => {
  const cleanup = await plugin.setup(host.context)
  if (typeof cleanup === "function") cleanups.push(cleanup)
  const claim = host.sidebar()
  // The host may invoke a slot render once only. Component getter props must
  // continue tracking host-owned memory after this boundary has been crossed.
  let renderCalls = 0
  mounted = await testRender(
    () => {
      renderCalls += 1
      return claim.render({ sessionID: "ses_a" })
    },
    { width: 44, height: 12 },
  )
  slotRenderCounts.set(mounted, () => renderCalls)
  expect(renderCalls).toBe(1)
  await settle(mounted)
  return mounted
}

/** Lets the plugin's first async refresh land, then paints. */
const settle = async (setup: Mounted) => {
  await Bun.sleep(25)
  await setup.renderOnce()
}

/** Fires the captured one second refresh and waits for the store read to land. */
const refresh = async (setup: Mounted) => {
  if (tick === undefined) throw new Error("the plugin never started its refresh interval")
  tick()
  await settle(setup)
}

describe("Waits sidebar plugin", () => {
  test("starts expanded, with live rows from the wait store", async () => {
    await schedule({ session: "ses_a", prompt: "implement this", inMs: 3_600_000 })
    await schedule({ session: "ses_b", prompt: "someone else's", inMs: 120_000 })
    const setup = await activate(makeHost("ses_a"))
    const frame = setup.captureCharFrame()

    expect(frame).toContain("▾ Waits (2)")
    expect(frame).toContain("w1 implement this")
    expect(frame).toContain("w2 someone else's")
  })

  test("is expanded with an empty header when there are no waits", async () => {
    const setup = await activate(makeHost("ses_a"))

    expect(setup.captureCharFrame()).toContain("▾ Waits (0)")
  })

  test("collapses on a header click and re-expands on the next", async () => {
    await schedule({ session: "ses_a", prompt: "implement this", inMs: 3_600_000 })
    const setup = await activate(makeHost("ses_a"))
    const header = rowOf(setup.captureCharFrame(), "Waits (1)")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("▸ Waits (1)")
    expect(frame).not.toContain("w1")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("▾ Waits (1)")
    expect(frame).toContain("w1 implement this")
  })

  test("a wait scheduled after activation appears on the next refresh, expanded or collapsed", async () => {
    const setup = await activate(makeHost("ses_a"))
    const header = rowOf(setup.captureCharFrame(), "Waits (0)")

    await schedule({ session: "ses_a", prompt: "arrived late", inMs: 60_000 })
    await refresh(setup)
    expect(setup.captureCharFrame()).toContain("w1 arrived late")
    expect(setup.captureCharFrame()).toContain("Waits (1)")
    expect(slotRenderCounts.get(setup)?.()).toBe(1)

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    await schedule({ session: "ses_a", prompt: "while collapsed", inMs: 60_000 })
    await refresh(setup)
    let frame = setup.captureCharFrame()
    expect(frame).toContain("▸ Waits (2)")
    expect(frame).not.toContain("while collapsed")
    expect(slotRenderCounts.get(setup)?.()).toBe(1)

    // Collapsed state must not be reset by a refresh, and the rows that
    // arrived meanwhile show on re-expand.
    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("▾ Waits (2)")
    expect(frame).toContain("w1 arrived late")
    expect(frame).toContain("w2 while collapsed")
  })

  test("a removed wait leaves the sidebar on the next refresh", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    await schedule({ session: "ses_a", prompt: "second", inMs: 120_000 })
    const setup = await activate(makeHost("ses_a"))
    expect(setup.captureCharFrame()).toContain("w2 second")

    await Effect.runPromise(store().remove("w2"))
    await refresh(setup)

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Waits (1)")
    expect(frame).toContain("w1 first")
    expect(frame).not.toContain("w2")
  })

  test("the countdown shrinks as time passes", async () => {
    await schedule({ session: "ses_a", prompt: "soon", inMs: 90_000 })
    const setup = await activate(makeHost("ses_a"))
    const before = frameLines(setup.captureCharFrame())[2] ?? ""

    const realNow = Date.now
    Date.now = () => realNow() + 60_000
    try {
      await refresh(setup)
    } finally {
      Date.now = realNow
    }
    const after = frameLines(setup.captureCharFrame())[2] ?? ""

    expect(before).toContain("w1 soon")
    expect(after).toContain("w1 soon")
    expect(after).not.toBe(before)
  })

  test("a long prompt is truncated to 27 characters and an ellipsis", async () => {
    await schedule({ session: "ses_a", prompt: "x".repeat(40), inMs: 60_000 })
    const setup = await activate(makeHost("ses_a"))
    const frame = setup.captureCharFrame()

    expect(frame).toContain(`w1 ${"x".repeat(27)}…`)
    expect(frame).not.toContain("x".repeat(28))
  })

  test("clicking a row opens the action menu for that wait", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    await schedule({ session: "ses_a", prompt: "second", inMs: 120_000 })
    const host = makeHost("ses_a")
    const setup = await activate(host)

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w2"))
    await Bun.sleep(25)

    expect(host.selects).toHaveLength(1)
    expect(host.selects[0]?.title).toBe("w2  second")
    expect(host.selects[0]?.options.map((option) => option.value)).toEqual([
      "send",
      "reschedule",
      "edit",
      "delete",
    ])
    // Merely opening the menu changes nothing.
    expect(await files()).toEqual(["w1.json", "w2.json"])
  })

  test("choosing Delete removes the wait, and the sidebar drops it", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    await schedule({ session: "ses_a", prompt: "second", inMs: 120_000 })
    const host = makeHost("ses_a")
    host.answerWith("delete")
    const setup = await activate(host)

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w2"))
    await Bun.sleep(50)

    expect(await files()).toEqual(["w1.json"])
    expect(host.toasts).toEqual(["Cancelled w2."])
    expect(host.cleared()).toBe(1)

    await refresh(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Waits (1)")
    expect(frame).not.toContain("w2")
  })

  test("dismissing the action menu leaves every wait in place", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    const host = makeHost("ses_a")
    host.answerWith(undefined)
    const setup = await activate(host)

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w1"))
    await Bun.sleep(50)

    expect(host.selects).toHaveLength(1)
    expect(await files()).toEqual(["w1.json"])
    expect(host.toasts).toEqual([])
  })

  test("a row stays actionable after the sidebar was collapsed and re-expanded", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    const host = makeHost("ses_a")
    const setup = await activate(host)
    const header = rowOf(setup.captureCharFrame(), "Waits (1)")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w1"))
    await Bun.sleep(25)

    expect(host.selects.map((select) => select.title)).toEqual(["w1  first"])
  })

  test("clicking where a collapsed row used to be opens nothing", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    const host = makeHost("ses_a")
    const setup = await activate(host)
    const frame = setup.captureCharFrame()
    const header = rowOf(frame, "Waits (1)")
    const row = rowOf(frame, "w1")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    await setup.mockMouse.click(3, row)
    await Bun.sleep(25)

    expect(host.selects).toEqual([])
  })

  test("the header click toggles without opening the action menu", async () => {
    await schedule({ session: "ses_a", prompt: "first", inMs: 60_000 })
    const host = makeHost("ses_a")
    const setup = await activate(host)

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "Waits (1)"))
    await Bun.sleep(25)

    expect(host.selects).toEqual([])
  })
})
