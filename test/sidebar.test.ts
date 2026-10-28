import { afterEach, describe, expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { Row } from "../src/tui/sidebar.tsx"

// Bun does not compile Solid JSX on its own. Without OpenTUI's transform,
// `sidebar.tsx` would evaluate its JSX expressions once and never react to a
// toggle, which is not how the host runs it. The transform has to be
// registered before the modules it applies to are loaded, hence the dynamic
// imports. It also swaps solid-js's server build for the client one.
ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const { createStore } = await import("solid-js/store")
const { Waits } = await import("../src/tui/sidebar.tsx")

const rows: ReadonlyArray<Row> = [
  { id: "w1", prompt: "implement this", countdown: "1h", mine: true },
  { id: "w2", prompt: "other session", countdown: "2m 5s", mine: false },
]

type Mounted = Awaited<ReturnType<typeof testRender>>

let mounted: Mounted | undefined

afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
})

const mount = async (view: () => ReturnType<typeof Waits>): Promise<Mounted> => {
  mounted = await testRender(view, { width: 40, height: 10 })
  await mounted.renderOnce()
  return mounted
}

const lines = (frame: string): ReadonlyArray<string> =>
  frame.split("\n").map((line) => line.trimEnd())

/** Row index of the first line containing `text`, so clicks follow the layout. */
const rowOf = (frame: string, text: string): number => {
  const index = lines(frame).findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`"${text}" is not on screen:\n${frame}`)
  return index
}

describe("Waits sidebar", () => {
  test("renders every row beneath an expanded header", async () => {
    const setup = await mount(() =>
      Waits({ title: "Schedules (2)", rows, expanded: true, onOpen: () => {}, onToggle: () => {} }),
    )
    const frame = setup.captureCharFrame()

    expect(frame).toContain("▾ Schedules (2)")
    expect(frame).toContain("w1 implement this")
    expect(frame).toContain("1h")
    expect(frame).toContain("w2 other session")
    expect(frame).toContain("2m 5s")
    // Header first, then the rows in order.
    expect(rowOf(frame, "Schedules (2)")).toBeLessThan(rowOf(frame, "w1"))
    expect(rowOf(frame, "w1")).toBeLessThan(rowOf(frame, "w2"))
  })

  test("hides the rows and shows a right caret when collapsed", async () => {
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: false,
        onOpen: () => {},
        onToggle: () => {},
      }),
    )
    const frame = setup.captureCharFrame()

    expect(frame).toContain("▸ Schedules (2)")
    expect(frame).not.toContain("▾")
    expect(frame).not.toContain("w1")
    expect(frame).not.toContain("w2")
  })

  test("renders only the header when there are no waits", async () => {
    const setup = await mount(() =>
      Waits({
        title: "Schedules (0)",
        rows: [],
        expanded: true,
        onOpen: () => {},
        onToggle: () => {},
      }),
    )

    expect(setup.captureCharFrame()).toContain("▾ Schedules (0)")
  })

  test("clicking the header toggles, and never opens a row", async () => {
    const toggled: string[] = []
    const opened: string[] = []
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: true,
        onOpen: (id) => opened.push(id),
        onToggle: () => toggled.push("toggle"),
      }),
    )
    const header = rowOf(setup.captureCharFrame(), "Schedules (2)")

    await setup.mockMouse.click(3, header)

    expect(toggled).toEqual(["toggle"])
    expect(opened).toEqual([])
  })

  test("clicking a row opens exactly that wait, and never toggles", async () => {
    const toggled: string[] = []
    const opened: string[] = []
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: true,
        onOpen: (id) => opened.push(id),
        onToggle: () => toggled.push("toggle"),
      }),
    )

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w2"))
    expect(opened).toEqual(["w2"])

    await setup.mockMouse.click(3, rowOf(setup.captureCharFrame(), "w1"))
    expect(opened).toEqual(["w2", "w1"])
    expect(toggled).toEqual([])
  })

  test("a row opens on release, not on press", async () => {
    const opened: string[] = []
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: true,
        onOpen: (id) => opened.push(id),
        onToggle: () => {},
      }),
    )
    const y = rowOf(setup.captureCharFrame(), "w1")

    await setup.mockMouse.pressDown(3, y)
    expect(opened).toEqual([])
    await setup.mockMouse.release(3, y)
    expect(opened).toEqual(["w1"])
  })

  test("clicking the countdown opens the row too", async () => {
    const opened: string[] = []
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: true,
        onOpen: (id) => opened.push(id),
        onToggle: () => {},
      }),
    )
    const frame = setup.captureCharFrame()
    const y = rowOf(frame, "w1")
    const x = (lines(frame)[y] ?? "").lastIndexOf("1h")

    await setup.mockMouse.click(x, y)

    expect(opened).toEqual(["w1"])
  })

  test("clicking where the rows were while collapsed opens nothing", async () => {
    const opened: string[] = []
    const setup = await mount(() =>
      Waits({
        title: "Schedules (2)",
        rows,
        expanded: false,
        onOpen: (id) => opened.push(id),
        onToggle: () => {},
      }),
    )

    await setup.mockMouse.click(3, 2)
    await setup.mockMouse.click(3, 3)

    expect(opened).toEqual([])
  })

  test("collapses and re-expands from header clicks, driven by reactive state", async () => {
    const [state, setState] = createStore({ expanded: true, rows: [...rows] })
    const setup = await mount(() =>
      Waits({
        // Getters, as Solid compiles reactive props, so each read is tracked.
        get title() {
          return `Schedules (${state.rows.length})`
        },
        get rows() {
          return state.rows
        },
        get expanded() {
          return state.expanded
        },
        onOpen: () => {},
        onToggle: () => setState("expanded", (value) => !value),
      }),
    )
    const header = rowOf(setup.captureCharFrame(), "Schedules (2)")

    expect(setup.captureCharFrame()).toContain("w1 implement this")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    const collapsed = setup.captureCharFrame()
    expect(collapsed).toContain("▸ Schedules (2)")
    expect(collapsed).not.toContain("w1")
    expect(collapsed).not.toContain("w2")

    await setup.mockMouse.click(3, header)
    await setup.renderOnce()
    const expanded = setup.captureCharFrame()
    expect(expanded).toContain("▾ Schedules (2)")
    expect(expanded).toContain("w1 implement this")
    expect(expanded).toContain("w2 other session")
  })

  test("live row updates reach the screen while expanded and survive collapse", async () => {
    const [state, setState] = createStore<{ expanded: boolean; rows: Row[] }>({
      expanded: true,
      rows: [{ id: "w1", prompt: "implement this", countdown: "10s", mine: true }],
    })
    const setup = await mount(() =>
      Waits({
        // Getters, as Solid compiles reactive props, so each read is tracked.
        get title() {
          return `Schedules (${state.rows.length})`
        },
        get rows() {
          return state.rows
        },
        get expanded() {
          return state.expanded
        },
        onOpen: () => {},
        onToggle: () => setState("expanded", (value) => !value),
      }),
    )
    expect(setup.captureCharFrame()).toContain("10s")

    // The countdown ticks.
    setState("rows", (current) => current.map((row) => ({ ...row, countdown: "9s" })))
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("9s")
    expect(frame).not.toContain("10s")

    // A new wait appears, and the title count follows it.
    setState("rows", (current) => [
      ...current,
      { id: "w2", prompt: "added later", countdown: "5m", mine: false },
    ])
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Schedules (2)")
    expect(frame).toContain("w2 added later")

    // Collapsed: rows vanish, but the title count still tracks changes.
    setState("expanded", false)
    await setup.renderOnce()
    setState("rows", (current) => current.filter((row) => row.id !== "w1"))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("▸ Schedules (1)")
    expect(frame).not.toContain("w2")

    // Re-expanding shows what changed while it was collapsed, not stale rows.
    setState("expanded", true)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("w2 added later")
    expect(frame).not.toContain("w1")
  })

  test("a long prompt does not push the countdown off its row", async () => {
    const setup = await mount(() =>
      Waits({
        title: "Schedules (1)",
        rows: [{ id: "w9", prompt: "a".repeat(20), countdown: "3h", mine: true }],
        expanded: true,
        onOpen: () => {},
        onToggle: () => {},
      }),
    )
    const frame = setup.captureCharFrame()
    const line = lines(frame)[rowOf(frame, "w9")] ?? ""

    expect(line).toContain("3h")
    expect(line.indexOf("w9")).toBeLessThan(line.indexOf("3h"))
  })
})
