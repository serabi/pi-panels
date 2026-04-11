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

## Requirements

- Pi interactive mode (panels use the widget API which is unavailable in print/RPC mode)
- Provider auth for whichever plans you want shown (for example pi OAuth auth in `~/.pi/agent/auth.json`)

## Credit

Original concept and upstream package source: [`alasano/house-of-pi`](https://github.com/alasano/house-of-pi), specifically the original `pi-panels` package.
