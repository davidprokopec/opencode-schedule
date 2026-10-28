import { describe, expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Commands from "../src/server/commands.ts"

type PromptCall = Parameters<Commands.SessionPort["prompt"]>[0]

/** A stub `Commands.SessionPort` that records every submission, so a command
 * can be run without an OpenCode server. */
const stubSession = (result: Effect.Effect<unknown, unknown> = Effect.void) => {
  const calls: Array<PromptCall> = []
  const session: Commands.SessionPort = {
    prompt: (input) => {
      calls.push(input)
      return result
    },
  }
  return { session, calls }
}

const definition = (name: string): Commands.Definition => {
  const found = Commands.definitions.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no such command: ${name}`)
  return found
}

const invocation = (
  text: string,
  overrides: Partial<Commands.Invocation> = {},
): Commands.Invocation => ({
  sessionID: Session.ID.create(),
  prompt: { text },
  delivery: "queue",
  ...overrides,
})

describe("Commands.render", () => {
  test("gives $1 the duration and $2 the whole remaining prompt", () => {
    const rendered = Commands.render(definition("schedule").template, "1hour do the thing, please")

    expect(rendered).toContain("- `duration`: 1hour")
    expect(rendered).toContain("\nOPENCODE_WAIT_PROMPT\ndo the thing, please\nOPENCODE_WAIT_PROMPT")
  })

  test("trims the argument text before splitting it", () => {
    const rendered = Commands.render(definition("schedule").template, "   1hour   do it   ")

    expect(rendered).toContain("- `duration`: 1hour")
    expect(rendered).toContain("\nOPENCODE_WAIT_PROMPT\ndo it\nOPENCODE_WAIT_PROMPT")
  })

  test("inserts user text verbatim, expanding neither placeholders nor $ sequences in it", () => {
    // `String.replace` treats `$1`, `$&` and `$$` in a *replacement string* as
    // substitution syntax, and a second pass would expand a placeholder the
    // user typed. Either one would rewrite the prompt being scheduled.
    const prompt = "print $1 $2 $ARGUMENTS $& $$ $`"
    const rendered = Commands.render(definition("schedule").template, `1hour ${prompt}`)

    expect(rendered).toContain(`\nOPENCODE_WAIT_PROMPT\n${prompt}\nOPENCODE_WAIT_PROMPT`)
  })

  test("renders a missing argument as empty rather than leaving the placeholder", () => {
    const rendered = Commands.render(definition("schedule").template, "1hour")

    expect(rendered).toContain("- `duration`: 1hour")
    expect(rendered).toContain("\nOPENCODE_WAIT_PROMPT\n\nOPENCODE_WAIT_PROMPT")
    expect(rendered).not.toContain("$2")
  })

  test("renders every placeholder as empty when no arguments were given", () => {
    const rendered = Commands.render(definition("schedule").template, "")

    expect(rendered).toContain("- `duration`: \n")
    expect(rendered).not.toContain("$1")
    expect(rendered).not.toContain("$2")
  })

  test("gives $ARGUMENTS the whole cancellation argument", () => {
    const template = definition("schedule-cancel").template

    expect(Commands.render(template, "  all  ")).toContain("The user wrote: all")
    expect(Commands.render(template, "w7")).toContain("The user wrote: w7")
    expect(Commands.render(template, "")).toContain("The user wrote: \n")
  })

  test("leaves a template without placeholders untouched", () => {
    const template = definition("schedule-list").template

    expect(Commands.render(template, "ignored input")).toBe(template)
  })
})

describe("Commands.command", () => {
  test("every definition becomes a command carrying its name and description", () => {
    const { session } = stubSession()

    expect(Commands.definitions.length).toBeGreaterThan(0)
    for (const candidate of Commands.definitions) {
      const command = Commands.command(candidate, session)
      expect(command.name).toBe(candidate.name)
      expect(command.description).toBe(candidate.description)
    }
  })

  test("submits the rendered template to the invoking session with its delivery", async () => {
    const { session, calls } = stubSession()
    const wait = definition("schedule")
    const command = Commands.command(wait, session)
    const input = invocation("1hour do it", { delivery: "steer" })

    const result = await Effect.runPromise(command.execute(input))

    expect(result).toBeUndefined()
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error("expected session.prompt to have been called")
    expect(call.sessionID).toBe(input.sessionID)
    expect(call.delivery).toBe("steer")
    expect(call.text).toBe(Commands.render(wait.template, "1hour do it"))
  })

  test("forwards the invocation's attachments so mentions still reach the agent", async () => {
    const { session, calls } = stubSession()
    const files = [{ uri: "file:///tmp/notes.md" }]
    const agents = [{ name: "build" }]
    const skills = [{ id: Schema.decodeSync(Skill.ID)("testing") }]
    const command = Commands.command(definition("schedule"), session)

    await Effect.runPromise(
      command.execute(
        invocation("1hour do it", { prompt: { text: "1hour do it", files, agents, skills } }),
      ),
    )

    const call = calls[0]
    if (call === undefined) throw new Error("expected session.prompt to have been called")
    expect(call.files).toEqual(files)
    expect(call.agents).toEqual(agents)
    expect(call.skills).toEqual(skills)
  })

  test("fails when the submission fails, so the host can report it", async () => {
    const { session, calls } = stubSession(Effect.fail("submission rejected"))
    const command = Commands.command(definition("schedule-list"), session)

    const exit = await Effect.runPromiseExit(command.execute(invocation("")))

    expect(calls).toHaveLength(1)
    if (Exit.isSuccess(exit)) throw new Error("expected the command to fail")
    expect(Cause.squash(exit.cause)).toBe("submission rejected")
  })
})

describe("Commands.definitions naming", () => {
  const pairs = [
    ["schedule", "wait", "schedule_create"],
    ["schedule-list", "wait-list", "schedule_list"],
    ["schedule-cancel", "wait-cancel", "schedule_cancel"],
  ] as const

  test("registers the canonical names and the legacy aliases, with no duplicates", () => {
    const names = Commands.definitions.map((candidate) => candidate.name)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      "schedule",
      "schedule-list",
      "schedule-cancel",
      "wait",
      "wait-list",
      "wait-cancel",
    ])
  })

  for (const [canonical, legacy, tool] of pairs) {
    test(`/${legacy} renders exactly what /${canonical} does, calling ${tool}`, () => {
      const current = definition(canonical)
      const alias = definition(legacy)

      expect(alias.template).toBe(current.template)
      expect(current.template).toContain(`\`${tool}\``)
      expect(current.template).not.toMatch(/`wait_(schedule|list|cancel)`/)
      for (const args of ["", "1hour do it", "  all  ", "w7"]) {
        expect(Commands.render(alias.template, args)).toBe(Commands.render(current.template, args))
      }
    })
  }

  test("canonical descriptions use the schedule wording", () => {
    expect(definition("schedule").description).toContain("/schedule 1hour")
    for (const name of ["schedule", "schedule-list", "schedule-cancel"]) {
      expect(definition(name).description.toLowerCase()).not.toContain("wait")
    }
  })

  test("a legacy alias submits the same prompt as its canonical command", async () => {
    const { session, calls } = stubSession()
    const sessionID = Session.ID.create()

    for (const name of ["schedule", "wait"]) {
      await Effect.runPromise(
        Commands.command(definition(name), session).execute(
          invocation("2h30m ship it", { sessionID, delivery: "queue" }),
        ),
      )
    }

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[0]?.text).toContain("- `duration`: 2h30m")
    expect(calls[0]?.text).toContain("\nOPENCODE_WAIT_PROMPT\nship it\nOPENCODE_WAIT_PROMPT")
  })
})
