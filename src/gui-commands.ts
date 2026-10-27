import { Command, type Context, type Command as GuiCommand } from "@opencode/plugin/gui"
import { errorMessage, parseWaitArguments } from "./gui-utils.ts"
import { WaitsRpc } from "./rpc.ts"

export function registerWaitCommands(ctx: Context): void {
  const open = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(`${ctx.id}:main`, session)
    else
      ctx.toast.show({ title: "No session open", description: "Open a session to view its waits." })
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
      slash: { name: "wait-list", arguments: true },
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
      slash: { name: "wait", arguments: true },
      run: async (raw = "") => {
        const match = parseWaitArguments(raw)
        if (!match) {
          ctx.toast.show({
            title: "Add a delay and prompt",
            description: "Use /wait <delay> <prompt>",
            variant: "error",
          })
          return
        }
        const session = ctx.sessions.current()
        if (!session) {
          ctx.toast.show({
            title: "No session open",
            description: "Open a session before scheduling a wait.",
          })
          return
        }
        try {
          await session.server.client
            .rpc(WaitsRpc)
            .schedule({ sessionID: session.id, duration: match.duration, prompt: match.prompt })
          ctx.toast.show({ title: "Wait scheduled", variant: "success" })
        } catch (cause) {
          ctx.toast.show({
            title: "Could not schedule wait",
            description: errorMessage(cause, "Try again."),
            variant: "error",
          })
        }
      },
    }),
  )
  ctx.add(
    Command,
    (): GuiCommand => ({
      id: "cancel",
      title: ctx.t("command.cancel"),
      description: "Cancel one wait by ID, or every wait",
      section: "session",
      slash: { name: "wait-cancel", arguments: true },
      run: async (raw = "") => {
        const argument = raw.trim()
        if (!argument) {
          ctx.toast.show({
            title: "Add an ID or all",
            description: "Use /wait-cancel <id|all>",
            variant: "error",
          })
          return
        }
        const session = ctx.sessions.current()
        if (!session) {
          ctx.toast.show({
            title: "No session open",
            description: "Open a session before cancelling waits.",
          })
          return
        }
        try {
          const rpc = session.server.client.rpc(WaitsRpc)
          const result =
            argument === "all"
              ? `${await rpc.cancelAll({ sessionID: session.id })} waits cancelled.`
              : (await rpc.cancel({ sessionID: session.id, id: argument }))
                ? "Wait cancelled."
                : "No matching wait in this session."
          ctx.toast.show({ title: result })
        } catch (cause) {
          ctx.toast.show({
            title: "Could not cancel wait",
            description: errorMessage(cause, "Try again."),
            variant: "error",
          })
        }
      },
    }),
  )
}
