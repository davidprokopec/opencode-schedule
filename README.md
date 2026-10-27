# opencode-waits

[![CI](https://github.com/davidprokopec/opencode-waits/actions/workflows/ci.yml/badge.svg)](https://github.com/davidprokopec/opencode-waits/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-waits)](https://www.npmjs.com/package/opencode-waits)
[![license](https://img.shields.io/npm/l/opencode-waits)](LICENSE)

Defer a prompt in [OpenCode V2](https://opencode.ai/v2/docs/). Say what you want
and when you want it, and OpenCode sends it to itself later.

```
/wait 1hour implement this
/wait 60s run the test suite again
/wait 2h30m check whether the deploy settled
```

`/wait` returns straight away. Nothing runs, no context is held open, and no
tokens are burned while the timer is pending. When the delay elapses the plugin
submits the prompt text into the same session as an ordinary user prompt, and
OpenCode acts on it exactly as if you had typed it yourself.

Now that OpenCode V2 is official, this plugin is published as `opencode-waits`
again. It was published as `opencode2-waits` during the V2 preview; new
releases use `opencode-waits`. To migrate, replace `opencode2-waits` (or
`opencode2-waits@beta`) with `opencode-waits` in both `opencode.json(c)` and
`cli.json`.
Existing pending waits remain compatible and continue using the original data
directory. The source lives in the
[`davidprokopec/opencode-waits`](https://github.com/davidprokopec/opencode-waits)
repository.

## Install

The plugin has two halves and needs an entry in **two** config files. The TUI
half provides model-free command handlers; the server half exposes the commands
to every client and owns the timers so a wait still fires once the TUI is closed.

```jsonc
// opencode.json(c) — the server half
{
  "plugins": ["opencode-waits"],
}
```

```jsonc
// cli.json — the TUI half, which provides /wait
// The package name only: the TUI resolves its ./tui entrypoint itself, and a
// /tui suffix would be read as part of the npm spec and fail to install.
{
  "plugins": ["opencode-waits"],
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-waits",
      "options": {
        "delivery": "queue",
      },
    },
  ],
}
```

| Option     | Values              | Default | Behaviour                                                                             |
| ---------- | ------------------- | ------- | ------------------------------------------------------------------------------------- |
| `delivery` | `"queue"`, `"steer"` | `queue` | `queue` waits for any turn in progress to finish. `steer` injects into the running turn. |

### Compatibility

This release is built and verified against the released
`@opencode/plugin@2.2.0` API and OpenCode `2.2.0` (OpenTUI `0.7.0`, Effect `4.0.1`).

Releases are published to npm `latest`, so the plain package name installs
the current stable version.

## Commands

The TUI sidebar shows pending waits in an expanded Waits section. Click its
header to collapse or expand it; click a wait to open its actions.

| Command                 | Effect                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `/wait <duration> <prompt>` | Schedule `<prompt>` for delivery after `<duration>`.   |
| `/wait-list`            | Show the waits still pending in this session.               |
| `/wait-cancel <id>`     | Cancel one wait, e.g. `/wait-cancel w1`.                    |
| `/wait-cancel all`      | Cancel every wait pending in this session.                  |

Waits are per session. `/wait-list` and `/wait-cancel` never see or touch waits
belonging to another session.

## Durations

`<duration>` is the first whitespace-separated argument; everything after it is
the prompt.

| Form            | Meaning              |
| --------------- | -------------------- |
| `500ms`         | milliseconds         |
| `60s`, `90 sec` | seconds              |
| `5m`, `5min`    | minutes              |
| `1h`, `1hour`   | hours                |
| `3d`, `3 days`  | days                 |
| `1w`            | weeks                |
| `2h30m`         | compound             |
| `1.5h`          | fractional           |
| `60`            | bare number, seconds |

`m` is minutes and `ms` is milliseconds. A bare number is only accepted on its
own, so `1h30` is rejected as ambiguous rather than guessed at. The maximum is
30 days.

## Waits survive restarts

Each pending wait is a JSON file under
`$XDG_DATA_HOME/opencode-waits/waits/` (the legacy-compatible directory, with one file per
wait, so the two halves never clobber each other's records). On startup the
server half arms everything it finds, and fires anything already overdue
immediately.

Rate limits at fire time are OpenCode's job, not the plugin's: submitting the
prompt succeeds even while limited, and OpenCode retries the model call itself
with backoff, honouring retry-after. Even if that fails, the prompt stays in
the session as an ordinary message. The plugin only re-arms — after 5m, 15m and
45m — when the prompt cannot be *submitted* at all, such as when the session is
busy with a conflicting operation. If the target session no longer exists, the
wait is dropped.

## How it works, and why it is split in two

A slash command defined by a *server* plugin is only a prompt template. Running
one submits a prompt and schedules model execution — so it fails exactly when
you are rate limited and most want to defer work.

A **TUI** slash command does not. The prompt matches `/wait …` and calls the
plugin before any model dispatch, so scheduling costs no model call at all. That
is why the trigger lives in the TUI half.

Timers cannot live there, though: they would die when you close the TUI. So the
TUI half only records the wait to disk, and the **server** half — running in the
background service — owns the timers and delivers the prompt.

The server half always exposes `wait_schedule`, `wait_list` and `wait_cancel` as
tools and registers `/wait`, `/wait-list` and `/wait-cancel` as server-side
commands. This makes them discoverable in clients that do not load the TUI
half, such as the **web and desktop apps**. There the command makes the agent
call the tool, so it costs one model turn. In the TUI the
plugin's own model-free commands intercept first, so scheduling still costs no
model call there.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run check   # typecheck + lint + test
```

To run it against a local checkout, add a local plugin directory with an
`index.ts` that re-exports the checkout's server entrypoint:

```ts
export { default } from "/absolute/path/to/opencode-waits/src/index.ts"
```

Then configure that local plugin directory:

```jsonc
{
  "plugins": ["/absolute/path/to/local-plugin"],
}
```

OpenCode does not install dependencies for local plugin paths, so `bun install`
in this directory first.

## License

MIT
