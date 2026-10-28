import { Command, type Context, type Command as GuiCommand } from "@opencode/plugin/gui"
import { WaitsRpc } from "../shared/rpc.ts"
import { errorMessage, parseWaitArguments } from "./utils.ts"

export function registerWaitCommands(ctx: Context): void {
  const schedule = async (raw = "") => {
    const match = parseWaitArguments(raw)
    if (!match)
      return void ctx.toast.show({
        title: "Add a delay and prompt",
        description: "Use /schedule <duration> <prompt>",
        variant: "error",
      })
    const session = ctx.sessions.current()
    if (!session)
      return void ctx.toast.show({
        title: "No session open",
        description: "Open a session before scheduling a prompt.",
      })
    try {
      await session.server.client
        .rpc(WaitsRpc)
        .schedule({ sessionID: session.id, duration: match.duration, prompt: match.prompt })
      ctx.toast.show({ title: "Prompt scheduled", variant: "success" })
    } catch (cause) {
      ctx.toast.show({
        title: "Could not schedule prompt",
        description: errorMessage(cause, "Try again."),
        variant: "error",
      })
    }
  }
  const cancel = async (raw = "") => {
    const argument = raw.trim()
    if (!argument)
      return void ctx.toast.show({
        title: "Add an ID or all",
        description: "Use /schedule-cancel <id|all>",
        variant: "error",
      })
    const session = ctx.sessions.current()
    if (!session)
      return void ctx.toast.show({
        title: "No session open",
        description: "Open a session before cancelling scheduled prompts.",
      })
    try {
      const rpc = session.server.client.rpc(WaitsRpc)
      ctx.toast.show({
        title:
          argument === "all"
            ? `${await rpc.cancelAll({ sessionID: session.id })} scheduled prompts cancelled.`
            : (await rpc.cancel({ sessionID: session.id, id: argument }))
              ? "Scheduled prompt cancelled."
              : "No matching scheduled prompt in this session.",
      })
    } catch (cause) {
      ctx.toast.show({
        title: "Could not cancel scheduled prompt",
        description: errorMessage(cause, "Try again."),
        variant: "error",
      })
    }
  }
  const open = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(`${ctx.id}:main`, session)
    else
      ctx.toast.show({
        title: "No session open",
        description: "Open a session to view its schedules.",
      })
  }
  ctx.add(
    Command,
    (): GuiCommand => ({
      id: "open",
      title: ctx.t("command.open"),
      section: "session",
      run: open,
    }),
  )
  ctx.add(
    Command,
    (): GuiCommand => ({
      id: "list",
      title: ctx.t("command.list"),
      section: "session",
      slash: { name: "schedule-list", arguments: true },
      run: open,
    }),
  )
  ctx.add(
    Command,
    (): GuiCommand => ({
      id: "wait",
      title: ctx.t("command.wait"),
      description: "Schedule a prompt without sending it now",
      section: "session",
      slash: { name: "schedule", arguments: true },
      run: schedule,
    }),
  )
  ctx.add(
    Command,
    (): GuiCommand => ({
      id: "cancel",
      title: ctx.t("command.cancel"),
      description: "Cancel one scheduled prompt by ID, or all scheduled prompts",
      section: "session",
      slash: { name: "schedule-cancel", arguments: true },
      run: cancel,
    }),
  )

  for (const [id, name, title, run] of [
    ["legacy-wait", "wait", "Schedule a prompt (legacy)", schedule],
    ["legacy-wait-list", "wait-list", "Open scheduled prompts (legacy)", open],
    ["legacy-wait-cancel", "wait-cancel", "Cancel a scheduled prompt (legacy)", cancel],
  ] as const) {
    ctx.add(
      Command,
      (): GuiCommand => ({
        id,
        title,
        hidden: true,
        section: "session",
        slash: { name, arguments: true },
        run,
      }),
    )
  }
}
