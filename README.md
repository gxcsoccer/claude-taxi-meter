# 🚕 Claude Taxi Meter

A Claude Code mod that puts a taxi meter in your status line. The fare ticks up live as tokens burn.

```
🚕 FOR HIRE   $1.20                                  ← idle
🚖 HIRED●   $1.27 ▲0.03 · trip $0.07 · 🔥$0.42/min   ← model streaming
🚕 WAITING⏳   $1.31 · trip $0.11 · Bash              ← waiting on a tool
🚕 FOR HIRE   $1.34 · last $0.14                     ← ride over
```

- **Live ticking.** Streamed text and tool arguments are billed at about 4 characters per token at the model's output price. Silent thinking is billed by time, like a cab stuck in traffic. When each response ends, its real usage is priced and added.
- **Honest total.** The meter always settles on the session's real ledger, the same number `/cost` shows.
- **Rolling drum.** Big jumps, such as input billed at the end of a response, roll up one cent at a time. The ▲ shows the jump, and the hired light blinks.
- **Ka-ching.** At $0.5, $1, $2, $5, $10 and so on, a toast appears and a cash-register sound plays.
- **Big-ride receipts.** Any turn that costs more than $0.50 pops up a receipt toast.
- **Payback mode for subscribers.** On a Pro or Max plan, per-token cost doesn't hurt, so the meter flips the story: `/taxi plan 200` and the status line shows `💎 3.2× plan`, how many times over this month's usage pays back your subscription, with a 🎉 at 1×, 2×, 3×, 5×, 10×…
- **`/taxi share`** copies a short ride summary to your clipboard, ready to paste anywhere.
- **`/taxi`** prints a full receipt: rides, jumps, average fare, priciest ride, lifetime total across sessions, and what that money would buy in lattes and NYC cab miles (Beijing taxi km in `zh`).

## Commands

| | |
| --- | --- |
| `/taxi` | print the receipt |
| `/taxi meter` | open the live meter pane: big LED digits, ride time, burn rate, budget bar, 30-minute spend sparkline, recent rides, and buttons (`r` receipt, `c` USD⇄CNY, `b` budget +$5, `n` no budget, `h` hide/show status) |
| `/taxi share` | copy a ride summary (fare, rides, payback, priciest prompt) to the clipboard |
| `/taxi plan 200` | your subscription's monthly price in USD; shows payback (`off` clears it) |
| `/taxi budget 5` | set this session's fare limit; the status line shows `budget 49%` and warns at 80% and 100% (`off` clears it) |
| `/taxi usd` / `cny` | switch currency |
| `/taxi en` / `zh` | switch language |
| `/taxi hide` / `show` | hide or show the status line meter |

`/taxi` runs immediately, even mid-turn, so you can check the fare while Claude is still working.

## Install

In Claude Code:

```
/plugin marketplace add gxcsoccer/claude-taxi-meter
/plugin install taxi-meter@claude-taxi-meter
```

or from a shell:

```sh
claude plugin marketplace add gxcsoccer/claude-taxi-meter
claude plugin install taxi-meter@claude-taxi-meter
```

The meter appears in the status line from the next session (or after `/reload-plugins`). It is built on Claude Code's function-hooks plugin API (early access), so it needs a recent Claude Code; it was built on 2.1.289.

To update later: `claude plugin marketplace update claude-taxi-meter && claude plugin update taxi-meter@claude-taxi-meter`.

## Run it from a checkout

```sh
claude --plugin-dir /path/to/claude-taxi-meter
```

## Options (`/config`, or `pluginConfigs["taxi-meter"].options` in settings.json)

| option | default | |
| --- | --- | --- |
| `language` | `en` | `en` (FOR HIRE/HIRED/WAITING) or `zh` (空车/载客/等候) |
| `currency` | `USD` | `USD` or `CNY` |
| `cnyRate` | `7.1` | CNY per USD |
| `sound` | `true` | ka-ching at milestones (macOS `afplay`) |
| `bigTripUsd` | `0.5` | toast a receipt for turns at least this expensive |
| `budgetUsd` | `0` | default fare limit per session (0 = none) |
| `planUsd` | `0` | subscription price per month; turns on payback mode (0 = API billing) |

## Test

```sh
claude plugin validate . && claude plugin test .
```
