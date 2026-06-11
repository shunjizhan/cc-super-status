# CLAUDE.md — cc-super-status

Guidance for working in this repo. User-facing docs are in `README.md`; this file is the engineering contract.

## What this is

A Claude Code `statusLine` command. Claude Code pipes a JSON blob on stdin every ~5s (and on events); whatever this prints to stdout becomes the user's status line:

```
🤖 Opus 4.8-1m (ultracode) | 🔥 $13.18/hr | ⭐️ {50}300t/s | 💰 $13.5 / $31 / $330 | ⚡ 2h 35m, 75% left ▰▰▰▰▰▰▰▱▱▱
```

It is wired in via `~/.claude/settings.json` → `statusLine.command` (currently `/opt/homebrew/bin/bun run <repo>/statusline.ts`). It **replaced** an older bash script (`~/.claude/ccusage-statusline.sh`, now deleted).

## Runtime & commands

- **Bun only** (committed). `bun run` executes TypeScript directly — there is **no build step**. Don't add one.
- `bun test` — unit + e2e suite. `bun install` — pulls `@types/bun` (type-checking only; tests run without it).
- Edits to `.ts` are live on the next status-line tick; no compile.

## Architecture — pure core, impure shell

Keep the pure/impure split. Pure modules have unit tests; impure I/O is thin and exercised by the e2e + live diffs.

| File | Purity | Responsibility |
| --- | --- | --- |
| `src/types.ts` | — | **The contract. Read first.** All shared types live here. |
| `src/rate.ts` | pure | `computeRate(entries, now, windowMs)` → `{cur, all}`. |
| `src/format.ts` | pure | model / speed / bar / truecolor / quota string rendering. |
| `src/ccusage.ts` | mixed | `parseCcusage` (pure) + `getCcusageLine` (spawns the CLI). |
| `src/transcripts.ts` | mixed | `extractEntries`/`isCurrentSessionPath` (pure) + disk I/O. |
| `src/buildStatusline.ts` | pure | orchestrator — composes the final line from injected inputs. |
| `statusline.ts` | impure | entry point: read stdin, gather I/O, call `buildStatusline`, print. |

`buildStatusline` takes everything (stdin input, ccusage line, entries, `now`, config) as arguments, so the whole render is deterministic and e2e-testable. **Keep it that way** — don't reach for `Date.now()`/`process.env`/`fs` inside the pure modules.

## Non-negotiable invariants

- **Never throw, never print a stack trace.** stdout is the user's status line. `statusline.ts` wraps everything in try/catch and degrades to the raw ccusage line or `''`. Per-segment failures drop only that segment (model + ⭐️ always render; 🔥/💰 drop together if ccusage is unavailable; ⚡ renders from stdin `rate_limits` independently of ccusage, and drops only when both sources are absent).
- **⚡ session remaining prefers first-party data.** Claude Code ≥2.1.132 passes `rate_limits.five_hour.{used_percentage, resets_at}` on stdin (Pro/Max only; `resets_at` is epoch **seconds**) — the same numbers `/usage` shows. When present (both fields), ⚡ renders from it; the ccusage `$`-block + `CCSS_QUOTA` estimate is only the fallback. Don't re-derive session % from costs when the official number is available.
- **Token rate semantics** (don't change without asking — they were deliberately chosen, see the git history / the deep discussion that produced this repo):
  - tokens per message are **charge-weighted by default** (`effectiveRate: true`, env `CCSS_EFFECTIVE`): `input ×1 + output ×5 + cache_creation ×2 (all treated as 1-hour) + cache_read ×0.1` — Anthropic's per-component price ratios vs base input, so the ⭐️ rate tracks cost-equivalent tokens (and can be fractional). With `CCSS_EFFECTIVE=0` every weight is 1 (raw throughput, rendered with 🌟 not ⭐️): `input + output + cache_creation + cache_read`, the same four components ccusage sums for its *total tokens*, so the raw rate agrees with ccusage. `CCSS_CACHE=0` (config `includeCache: false`) drops the two cache terms in either mode. All of this — weights + cache include/exclude — is decided once at parse time in `tokenCount`/`parseTranscriptText`, baked into `TokenEntry.tok`; `rate.ts` never sees the split.
  - **dedup by `message.id`** (transcripts log each message 2–3× — counting all rows over-reports ~3×, which is the bug `ccstatusline`'s speed widget has). Duplicate rows carry identical usage, so max-`tok` dedup is correct regardless of weighting or cache inclusion.
  - window = last `CCSS_WINDOW` seconds (**÷ windowSec**, a true sliding average — not ÷ active-processing-time).
  - window ends at `max(now, latestTs)` so the rate **decays to 0 after the window of idle**.
  - `cur` = current session (its transcript + `<session_id>/subagents/`); `all` = every recent session. `all ≥ cur` always.
  - format collapses `{cur}all` → `all` when `cur === all`.
- **ccusage is wrapped, not reimplemented.** It has no JS library API — we shell to `ccusage statusline` and parse its string. Don't try to recompute cost/pricing ourselves.
- **Performance matters** (runs every 5s, per open session). Keep it O(active sessions): mtime-filter transcripts and tail-by-bytes; never read all of `~/.claude/projects` (hundreds of files) or whole multi-MB transcripts.

## Conventions

- Modern TS: arrow functions, optional chaining, nullish coalescing, `import type`. Avoid `any`.
- No defensive code for impossible inputs (e.g. negative token counts) — but **do** guard real user-facing paths (e.g. `CCSS_WINDOW=0` is guarded in both `rate.ts` and the config parse).
- Add a test for any new pure behavior; prefer TDD. Keep the e2e fixtures deterministic (fixed `NOW` constant, no wall-clock).
- Surgical changes — match surrounding style.

## Gotchas

- **ccusage's offline pricing goes stale at every model launch.** `ccusage statusline` defaults to `--offline`, pricing from a snapshot bundled with the *installed* version. A pre-launch install silently prices a new model's tokens at $0 (this happened at the Fable 5 launch with ccusage 20.0.6: 🔥/💰 under-reported ~4×). When cost segments look implausibly low after a model release, `bun install -g ccusage@latest` before debugging this repo. Don't switch to `--no-offline` — it re-fetches the ~3MB LiteLLM DB on every uncached tick (+2.3s, measured).
- `find`/`tail`/`Date.now` are fine in **this repo's** code; they were only banned in the workflow *script* that generated it.
- The deterministic e2e uses a hardcoded `NOW` epoch and fixture timestamps relative to it. If you change the window math, update the documented arithmetic in `test/e2e.test.ts`.
- The user has an interactive shell alias `ccusage='bunx ccusage daily -b'` — irrelevant here (the status line is non-interactive and we resolve the binary explicitly), but don't be confused by it.
