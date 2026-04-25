# pi-panels

Standalone status panels for [pi](https://pi.dev), extracted from [`alasano/house-of-pi`](https://github.com/alasano/house-of-pi) and adapted as a dedicated standalone project.

Three panels ship out of the box, each independently toggleable:

- **GIT** - worktree name, branch, upstream tracking (shown only when non-default), ahead/behind counts
- **INFO** - LLM context usage bar, active model and thinking level
- **PLAN** - current provider plan usage, with used vs remaining bars per quota window

Panels auto-size to their content, render side-by-side when terminal width allows, and fall back to a stacked layout on narrow terminals.

## Project origin

This repository began as the `packages/pi-panels` package inside [`alasano/house-of-pi`](https://github.com/alasano/house-of-pi).

This standalone repo is where the extracted panel project now lives.

## Commands

| Command                  | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `/status-panels`         | Open the settings overlay to toggle individual panels |
| `/status-panels on\|off` | Enable or disable all panels                          |

## Settings overlay

Running `/status-panels` with no arguments opens a centered overlay where you can enable or disable each panel individually using checkbox toggles. Typing any character dismisses the overlay and passes the keystroke to the editor.

## Preferences

Panel visibility preferences are persisted at `~/.pi/agent/state/extensions/status-panels/config.json` and restored on session start. Default behavior on first run is all panels enabled.

## Refresh behavior

- Git info refreshes every 5 seconds and immediately after each agent turn
- LLM context and model info update on turn end and model switch
- Plan usage updates on panel refresh ticks and model switches

## Supported providers

The PLAN panel supports the following providers:

| Provider | What is shown |
|----------|---------------|
| **Anthropic (Claude)** | 5-hour, 7-day, and extra usage windows with reset timers |
| **GitHub Copilot** | Monthly premium interactions percent used |
| **Google Gemini** | Pro and Flash model quotas |
| **Google Antigravity** | Per-model remaining fractions with reset timers |
| **OpenAI Codex** | Primary and additional rate-limit windows |
| **OpenCode Zen** | `Pay-as-you-go` (no public usage API) |
| **OpenCode Go** | Static plan info (`5h $12 · wk $30 · mo $60`) or live monthly usage bar |

### OpenCode Go live usage (optional)

To show a real monthly usage bar for OpenCode Go instead of static plan info, set these environment variables:

```bash
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie-value"
```

- `OPENCODE_GO_WORKSPACE_ID` — from the URL when you are on `https://opencode.ai/workspace/{id}/go`
- `OPENCODE_GO_AUTH_COOKIE` — the `auth` cookie value from that same page (check browser dev tools → Application → Cookies)

When both are set, pi-panels scrapes the dashboard page for `monthlyUsage` and renders a percent-used bar with a reset timer.

## Requirements

- Pi interactive mode (panels use the widget API which is unavailable in print/RPC mode)
- Provider auth for whichever plans you want shown (for example pi OAuth auth in `~/.pi/agent/auth.json`)

## Credit

Original concept and upstream package source: [`alasano/house-of-pi`](https://github.com/alasano/house-of-pi), specifically the original `pi-panels` package.
