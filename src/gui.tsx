/** @jsxImportSource solid-js */
import { type Panel as GuiPanel, Panel, type PanelProps, Plugin, Style } from "@opencode/plugin/gui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { registerWaitCommands } from "./gui-commands.ts"
import { createSessionScope, errorMessage, remaining } from "./gui-utils.ts"
import { type WaitRow, WaitsRpc } from "./rpc.ts"

function WaitsPanel(props: PanelProps) {
  const [rows, setRows] = createSignal<readonly WaitRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [duration, setDuration] = createSignal("1hour")
  const [prompt, setPrompt] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const scope = createSessionScope()
  let active = { key: props.session.key, id: props.session.id, client: props.session.server.client }
  let requestKey: string | undefined
  let requestGeneration = 0
  let refreshAgain = false
  let mutationFailed = false
  // Avoid overlapping list calls while preserving a refresh requested during
  // an in-flight poll (for example immediately after scheduling).
  const refresh = async (target: typeof active, mode: "initial" | "poll" | "manual" = "manual") => {
    if (!scope.isCurrent(target.key, scope.capture())) return
    if (requestKey === target.key) {
      if (mode !== "poll") refreshAgain = true
      return
    }
    const current = scope.capture()
    const request = ++requestGeneration
    requestKey = target.key
    if (mode !== "poll") setLoading(true)
    if (mode !== "poll") {
      setError("")
      mutationFailed = false
    }
    try {
      const result = await target.client.rpc(WaitsRpc).list({ sessionID: target.id })
      if (scope.isCurrent(target.key, current)) {
        // Refresh the clock with the rows so a just-scheduled wait is not
        // measured against a tick up to 5 s old.
        setNow(Date.now())
        setRows(result)
      }
    } catch (cause) {
      if (scope.isCurrent(target.key, current) && !mutationFailed)
        setError(errorMessage(cause, "Could not load waits."))
    } finally {
      if (request === requestGeneration && scope.isCurrent(target.key, current)) {
        requestKey = undefined
        setLoading(false)
        if (refreshAgain) {
          refreshAgain = false
          void refresh(target, "poll")
        }
      }
    }
  }
  createEffect(() => {
    const session = props.session
    active = { key: session.key, id: session.id, client: session.server.client }
    scope.enter(active.key)
    requestKey = undefined
    refreshAgain = false
    setRows([])
    setError("")
    setBusy(false)
    mutationFailed = false
    void refresh(active, "initial")
  })
  const tick = setInterval(() => {
    setNow(Date.now())
    void refresh(active, "poll")
  }, 5000)
  onCleanup(() => {
    scope.dispose()
    clearInterval(tick)
  })
  const schedule = async (event: SubmitEvent) => {
    event.preventDefault()
    const d = duration().trim()
    const text = prompt().trim()
    if (!d || !text || busy()) return
    const target = active
    const revision = scope.capture()
    setBusy(true)
    setError("")
    mutationFailed = false
    try {
      await target.client
        .rpc(WaitsRpc)
        .schedule({ sessionID: target.id, duration: d, prompt: text })
      if (!scope.isCurrent(target.key, revision)) return
      setPrompt("")
      await refresh(target)
    } catch (cause) {
      if (scope.isCurrent(target.key, revision)) {
        mutationFailed = true
        setError(errorMessage(cause, "Could not schedule this wait."))
      }
    } finally {
      if (scope.isCurrent(target.key, revision)) setBusy(false)
    }
  }
  const cancel = async (id: string) => {
    if (busy()) return
    const target = active
    const revision = scope.capture()
    setBusy(true)
    setError("")
    mutationFailed = false
    try {
      await target.client.rpc(WaitsRpc).cancel({ sessionID: target.id, id })
      if (!scope.isCurrent(target.key, revision)) return
      await refresh(target)
    } catch (cause) {
      if (scope.isCurrent(target.key, revision)) {
        mutationFailed = true
        setError(errorMessage(cause, "Could not cancel this wait."))
      }
    } finally {
      if (scope.isCurrent(target.key, revision)) setBusy(false)
    }
  }
  const cancelAll = async () => {
    if (busy() || rows().length === 0) return
    const target = active
    const revision = scope.capture()
    setBusy(true)
    setError("")
    mutationFailed = false
    try {
      await target.client.rpc(WaitsRpc).cancelAll({ sessionID: target.id })
      if (!scope.isCurrent(target.key, revision)) return
      await refresh(target)
    } catch (cause) {
      if (scope.isCurrent(target.key, revision)) {
        mutationFailed = true
        setError(errorMessage(cause, "Could not cancel waits."))
      }
    } finally {
      if (scope.isCurrent(target.key, revision)) setBusy(false)
    }
  }
  return (
    <section class="waits-panel" aria-label="Scheduled waits">
      <header class="waits-header">
        <div>
          <p class="waits-eyebrow">FOLLOW-UP QUEUE</p>
          <h2>
            Waits <span>{rows().length}</span>
          </h2>
        </div>
        <button
          type="button"
          class="waits-refresh"
          onClick={() => void refresh(active)}
          aria-label="Refresh waits"
          disabled={loading()}
        >
          ↻
        </button>
      </header>
      <form class="waits-form" onSubmit={schedule}>
        <label for="wait-duration">Send after</label>
        <input
          id="wait-duration"
          value={duration()}
          onInput={(event) => setDuration(event.currentTarget.value)}
          placeholder="e.g. 30m, 2hours"
          autocomplete="off"
          required
        />
        <label for="wait-prompt">Prompt</label>
        <textarea
          id="wait-prompt"
          value={prompt()}
          onInput={(event) => setPrompt(event.currentTarget.value)}
          placeholder="What should happen later?"
          rows={3}
          required
        />
        <button
          class="waits-create"
          type="submit"
          disabled={busy() || !duration().trim() || !prompt().trim()}
        >
          {busy() ? "Saving…" : "Schedule wait"}
          <span aria-hidden="true">↗</span>
        </button>
      </form>
      <div class="waits-list-heading">
        <span>UP NEXT</span>
        <Show when={rows().length > 0}>
          <button type="button" onClick={() => void cancelAll()} disabled={busy()}>
            Cancel all
          </button>
        </Show>
      </div>
      <Show when={error()}>
        <p class="waits-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={loading()}>
        <p class="waits-status" role="status">
          Loading scheduled waits…
        </p>
      </Show>
      <Show when={!loading() && rows().length === 0 && !error()}>
        <div class="waits-empty">
          <span aria-hidden="true">◷</span>
          <strong>Nothing waiting</strong>
          <p>Schedule a prompt above and it will appear here.</p>
        </div>
      </Show>
      <Show when={!loading() && rows().length > 0}>
        <ul class="waits-items">
          <For each={rows()}>
            {(row) => (
              <li>
                <div class="waits-item-top">
                  <span class="waits-countdown">{remaining(row.firesAt, now())}</span>
                  <button
                    type="button"
                    onClick={() => void cancel(row.id)}
                    disabled={busy()}
                    aria-label={`Cancel wait ${row.id}`}
                  >
                    Cancel
                  </button>
                </div>
                <p>{row.prompt}</p>
                <small>#{row.id}</small>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      "command.open": "Open Waits",
      "command.wait": "Schedule a wait",
      "command.list": "Open scheduled waits",
      "command.cancel": "Cancel a wait",
    },
  },
  setup(ctx) {
    const tab = {
      id: "main",
      get title() {
        return "Waits"
      },
      closable: "compact" as const,
      fallback: true,
    }
    ctx.add(
      Style,
      `.waits-panel{height:100%;overflow:auto;padding:22px 20px;color:var(--text-base);font:inherit}.waits-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.waits-eyebrow,.waits-list-heading>span{font-size:10px;letter-spacing:.13em;font-weight:700;color:var(--text-weak)}.waits-header h2{font-size:21px;letter-spacing:-.04em;margin:5px 0 0}.waits-header h2 span{font-size:12px;vertical-align:middle;color:var(--text-weak);margin-left:5px}.waits-refresh,.waits-list-heading button,.waits-item-top button{border:0;background:transparent;color:var(--text-weak);cursor:pointer}.waits-form{display:grid;gap:8px;padding:16px;border:1px solid var(--border-weak);border-radius:12px;background:var(--surface-base)}.waits-form label{font-size:12px;font-weight:600;color:var(--text-strong)}.waits-form input,.waits-form textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--border-weak);border-radius:7px;background:var(--surface-raised);color:var(--text-base);font:inherit;font-size:13px;outline:none}.waits-form input:focus,.waits-form textarea:focus{border-color:var(--border-focus)}.waits-form textarea{resize:vertical;min-height:76px}.waits-create{margin-top:4px;border:0;border-radius:7px;padding:10px 12px;background:var(--surface-invert);color:var(--text-invert);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:flex;justify-content:space-between}.waits-create:disabled{opacity:.5;cursor:not-allowed}.waits-list-heading{display:flex;align-items:center;justify-content:space-between;margin:25px 1px 8px}.waits-list-heading button,.waits-item-top button{font:inherit;font-size:11px}.waits-items{list-style:none;padding:0;margin:0}.waits-items li{padding:13px 1px;border-bottom:1px solid var(--border-weak)}.waits-item-top{display:flex;justify-content:space-between;align-items:center}.waits-countdown{font-size:12px;font-weight:700;color:var(--text-strong)}.waits-items p{font-size:13px;line-height:1.5;margin:8px 0;color:var(--text-base);overflow-wrap:anywhere}.waits-items small{font-size:10px;color:var(--text-weak)}.waits-empty{padding:32px 12px;text-align:center;color:var(--text-weak)}.waits-empty>span{display:block;font-size:25px;margin-bottom:12px}.waits-empty strong{font-size:13px;color:var(--text-strong)}.waits-empty p,.waits-status,.waits-error{font-size:12px;line-height:1.5;color:var(--text-weak)}.waits-error{color:var(--text-danger)}`,
    )
    ctx.add(
      Panel,
      (): GuiPanel => ({
        id: "main",
        region: "side",
        mobile: {
          get title() {
            return "Waits"
          },
          order: 45,
          kind: "menu",
          icon: "lock",
        },
        list: (input) => (input.open.includes("main") ? [tab] : []),
        render: (props) => <WaitsPanel {...props} />,
      }),
    )
    registerWaitCommands(ctx)
  },
})
