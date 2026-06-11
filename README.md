# cc-super-status

A souped-up [Claude Code](https://docs.anthropic.com/en/docs/claude-code) status line: model + effort, burn rate, **cross-session** token throughput, cost breakdown, and a colored quota bar — all on one line.

```
🤖 Opus 4.8-1m (ultracode) | 🔥 $13.18/hr | ⭐️ {50}300t/s | 💰 $13.5 / $31 / $330 | ⚡ 2h 35m, 75% left ▰▰▰▰▰▰▰▱▱▱
```

Runs on [Bun](https://bun.sh) (no build step — `bun run` executes the TypeScript directly).

## The segments

Segments are joined by ` | ` in this fixed order. The two **ccusage-derived** segments (🔥 / 💰) are omitted together if `ccusage` isn't available or its output can't be parsed, so the 🤖 and ⭐️ segments always render. ⚡ prefers Claude Code's own rate-limit data from stdin (independent of ccusage) and only falls back to the ccusage estimate when that data is absent.

| Segment | Meaning | Source |
| --- | --- | --- |
| 🤖 `Opus 4.8-1m (ultracode)` | Model + reasoning effort. `(1M context)` collapses to `-1m`; effort `xhigh` renders as `ultracode`, other levels pass through, absent effort is omitted. | stdin JSON (`model`, `effort`) |
| 🔥 `$13.18/hr` | Current dollar **burn rate**, verbatim from ccusage. | `ccusage statusline` |
| ⭐️ `{50}300t/s` | **Token throughput** over the sliding window, charge-weighted by default (⭐️; raw mode shows 🌟 — see below). `{cur}all` — `cur` = current session (this transcript + its subagents), `all` = every recent session. Collapses to a single `Nt/s` when `cur === all`. | transcripts on disk |
| 💰 `$13.5 / $31 / $330` | Cost: **session / block / today** (session to 1 decimal, block and today rounded). | `ccusage statusline` |
| ⚡ `2h 35m, 75% left ▰▰▰▰▰▰▰▱▱▱` | **Session remaining.** Time until the current 5-hour rate-limit window resets, then `% left` with a colored bar. Color: red `< 20%`, amber `< 50%`, green otherwise. Uses Claude Code's first-party `rate_limits.five_hour` (`used_percentage` + `resets_at`, passed on stdin for Pro/Max subscribers since CC 2.1.132) — the official numbers, same as `/usage`. Falls back to the old ccusage `$`-quota estimate (`(CCSS_QUOTA − block) / CCSS_QUOTA`) when that data is absent (e.g. API-key billing). | stdin JSON `rate_limits`, else `ccusage statusline` + `CCSS_QUOTA` |

### How the ⭐️ token rate works

`cc-super-status` scans `~/.claude/projects` for transcripts modified recently, reads the tail of each, and extracts one token event per assistant message. Events are:

- **deduped** by `message.id` (handles transcripts that repeat a row),
- **windowed** to the last `CCSS_WINDOW` seconds, and
- divided by the window length and rounded to a per-second rate.

**Effective (charge-weighted) rate — the default (⭐️).** Raw token counts are misleading because cache-read tokens dominate real usage (the cached context is re-read every turn) yet cost only a tenth of a base input token. So by default each component is weighted by its [Anthropic price ratio](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing) relative to base **input (1×)**:

| Component | Weight |
| --- | --- |
| `input_tokens` | 1× |
| `output_tokens` | 5× |
| `cache_creation_input_tokens` | 2× (all treated as 1-hour writes) |
| `cache_read_input_tokens` | 0.1× |

The result is a **cost-equivalent** throughput — "input-token-equivalents per second" — that tracks how fast you're actually burning money rather than raw token volume.

**Raw rate (🌟).** Set `CCSS_EFFECTIVE=0` to weight every component at 1× instead: `input + output + cache_creation + cache_read`. This matches how [ccusage](https://github.com/ryoppippi/ccusage) defines *total tokens*, so the throughput agrees with ccusage's totals. Raw mode renders with **🌟** so you can tell the two modes apart at a glance.

In either mode, `CCSS_CACHE=0` drops the two cache terms entirely (counting only `input + output`, weighted per the active mode).

`cur` counts only the active session — its main transcript plus any subagent transcripts under `<session_id>/subagents/` — while `all` counts every session in the window. This is what lets you see total throughput across parallel Claude Code sessions.

## Data sources

- **stdin JSON** — Claude Code pipes a JSON blob to the status line command on every render (`model`, `effort`, `session_id`, `transcript_path`, `cwd`, `rate_limits`). Drives the 🤖 segment and (when `rate_limits` is present) the ⚡ segment.
- **`ccusage statusline`** — the [ccusage](https://github.com/ryoppippi/ccusage) CLI. Resolved fastest-first: a `ccusage` on `PATH`, else bun's global bin (`~/.bun/bin/ccusage`, where `bun install -g ccusage` lands even when that dir isn't on `PATH`), else `bunx ccusage`. Drives 🔥 / 💰 (and the ⚡ fallback). Capped at a 3s timeout; any failure simply drops those segments.
- **Transcripts on disk** — JSONL files under `~/.claude/projects`. Drives the ⭐️ segment.

> **Keep ccusage updated when a new model ships.** `ccusage statusline` runs in offline mode by default, pricing tokens from a snapshot **bundled with the installed version**. A ccusage installed before a model's launch (e.g. ccusage 20.0.6 vs Claude Fable 5) silently prices that model's tokens at **$0**, so 🔥 and 💰 (and the ⚡ fallback) under-report. Fix: `bun install -g ccusage@latest`.

Each source fails independently: if ccusage times out or transcripts can't be read, the rest of the line still renders. The process **never throws** — on a total failure it emits the raw ccusage line if it has one, otherwise an empty string.

## Environment overrides

| Variable | Default | Meaning |
| --- | --- | --- |
| `CCSS_QUOTA` | `125` | Dollar quota per 5-hour block, used for the ⚡ `% left` bar **only in the ccusage fallback path** (ignored when Claude Code passes the five-hour rate-limit window on stdin). |
| `CCSS_WINDOW` | `120` | Token-rate sliding window, in seconds. |
| `CCSS_EFFECTIVE` | `true` | Charge-weight the token rate (output ×5, cache write ×2, cache read ×0.1, input ×1) so it tracks cost-equivalent tokens, shown with ⭐️. Set to `0`/`false`/`no`/`off` for raw 1×-per-token throughput, shown with 🌟. |
| `CCSS_CACHE` | `true` | Include cache tokens (creation + read) in the rate. Set to `0`/`false`/`no`/`off` to count only input + output. With `CCSS_EFFECTIVE=0` and `CCSS_CACHE=1` the raw rate matches ccusage's total-token definition. |

Other constants (bar width `10` cells, transcript mtime lookback `CCSS_WINDOW + 60s`, `1 MiB` tail read per transcript, projects dir `$HOME/.claude/projects`) are fixed in `statusline.ts`.

## Wiring it into Claude Code

Add to your `settings.json` (e.g. `~/.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun run /Users/sybuu/Projects/cc-super-status/statusline.ts"
  }
}
```

Use bun's absolute path (e.g. `/opt/homebrew/bin/bun run …`) if the status line runs in an environment where `bun` isn't on `PATH`.

Optionally set the env overrides inline for that command, e.g.:

```json
{
  "statusLine": {
    "type": "command",
    "command": "CCSS_QUOTA=200 CCSS_WINDOW=180 bun run /Users/sybuu/Projects/cc-super-status/statusline.ts"
  }
}
```

## Development

```sh
bun install   # pulls @types/bun
bun test      # runs the unit + deterministic e2e suite
```

### Layout

- `src/types.ts` — the shared contract (read this first).
- `src/rate.ts` — `computeRate`: pure dedup → window → per-second rate.
- `src/format.ts` — pure rendering helpers (model, speed, bar, truecolor, quota).
- `src/ccusage.ts` — runs `ccusage statusline` and parses its line.
- `src/transcripts.ts` — `gatherEntries`: reads transcripts off disk into token events.
- `src/buildStatusline.ts` — pure orchestrator composing the final line.
- `statusline.ts` — the impure entry point Claude Code runs.
- `test/` — unit tests per module plus a fixture-driven `e2e.test.ts`.
