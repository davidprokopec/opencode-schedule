import { watch } from "node:fs"
import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer } from "effect"
import * as Commands from "./commands.ts"
import * as Delivery from "./delivery.ts"
import * as GuiServer from "./gui-server.ts"
import * as Node from "./node.ts"
import * as Options from "./options.ts"
import { WaitsRpc } from "./rpc.ts"
import * as Store from "./store.ts"
import * as Supervisor from "./supervisor.ts"
import * as Tools from "./tools.ts"

export default Plugin.define({
  id: "opencode2-waits",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Options.resolve(ctx.options)
      const root = Store.directory()
      const store = Store.make(Node.fileSystem, root)

      const probe: Supervisor.SessionProbe = {
        exists: (sessionID) =>
          ctx.session.get({ sessionID }).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
      }

      // Built into the plugin's own scope. `Effect.provide` would release the
      // supervisor as soon as setup returned, taking every timer with it.
      const context = yield* Layer.build(
        Layer.effect(SupervisorTag, Supervisor.make(store, probe)).pipe(
          Layer.provide(Delivery.layer(ctx.session, options)),
        ),
      )
      const supervisor = Context.get(context, SupervisorTag)

      // Arm whatever survived the last shutdown, firing anything overdue.
      yield* supervisor.sync

      // The TUI entrypoint creates waits by writing files here; this process
      // owns the timers, so it has to notice them.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const watcher = watch(root, { persistent: false }, () => {
            Effect.runFork(supervisor.sync)
          })
          watcher.on("error", () => {})
          return watcher
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
        (watcher) => Effect.sync(() => watcher?.close()),
      )

      // Register server commands so clients that do not load the TUI half, such as
      // the web and desktop apps, discover them too. Their templates make the
      // agent call these tools, costing one model turn. The TUI's own slash
      // commands run client side before submission, so they still win there.
      yield* ctx.tool.transform((tools) => {
        for (const tool of Tools.all(supervisor)) tools.add(tool)
      })
      yield* ctx.command.transform((commands) => {
        for (const definition of Commands.definitions) {
          commands.add(Commands.command(definition, ctx.session))
        }
      })

      // Lets the desktop app's Waits panel schedule, list and cancel without a
      // model turn.
      yield* GuiServer.register(ctx.rpc, GuiServer.make(supervisor, probe))
    }),
})

class SupervisorTag extends Context.Service<SupervisorTag, Supervisor.Interface>()(
  "opencode2-waits/Supervisor",
) {}

export { Commands, Delivery, GuiServer, Options, Store, Supervisor, Tools, WaitsRpc }
