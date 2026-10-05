// The meter's arithmetic and words: no `$`, so the tests can call it bare.

import type { ModelUsage } from 'claude-code'

import type { Trip } from '../types'

export type Lang = 'zh' | 'en'
export type Currency = 'USD' | 'CNY'
export type Phase = 'idle' | 'hired' | 'waiting'

/** USD per million tokens, [input, output], first match wins. */
const PRICES: readonly [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5|opus-5\.5/, 4, 20],
  [/opus-4-(0|1)\b|opus-4-1|opus-4-2025|opus-3/, 15, 75],
  [/opus/, 5, 25],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/haiku-4/, 1, 5],
  [/haiku-3-5/, 0.8, 4],
  [/haiku/, 0.25, 1.25],
]

export function priceOf(model: string): { input: number; output: number } {
  const id = model.toLowerCase()
  for (const [re, input, output] of PRICES) {
    if (re.test(id)) return { input, output }
  }
  return { input: 5, output: 25 }
}

/** What one response cost at list price; the session ledger corrects it. */
export function costOf(model: string, u: ModelUsage): number {
  const p = priceOf(model)
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.input * 0.1 +
      u.cache_creation_input_tokens * p.input * 1.25) /
    1e6
  )
}

/** Output still streaming: about four characters a token. */
export function streamingCost(model: string, chars: number, quietTokens: number): number {
  return ((chars / 4 + quietTokens) * priceOf(model).output) / 1e6
}

/** USD to the display currency's smallest unit (cents or fen): one meter jump. */
export function toUnits(usd: number, currency: Currency, cnyRate: number): number {
  const factor = currency === 'CNY' ? cnyRate : 1
  return Math.floor(usd * factor * 100 + 1e-6)
}

export function money(units: number, currency: Currency): string {
  const sign = currency === 'CNY' ? '¥' : '$'
  return `${sign}${(units / 100).toFixed(2)}`
}

export function moneyUsd(usd: number, currency: Currency, cnyRate: number): string {
  return money(toUnits(usd, currency, cnyRate), currency)
}

/** How many units the meter rolls this tick: a big jump rolls over a few ticks. */
export function rollStep(gap: number): number {
  if (gap <= 0) return 0
  return Math.max(1, Math.ceil(gap / 4))
}

export const MILESTONES = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]

/** The highest milestone at or under `usd`, 0 when none. */
export function milestoneAt(usd: number): number {
  let hit = 0
  for (const m of MILESTONES) if (usd + 1e-9 >= m) hit = m
  return hit
}

const WORDS = {
  zh: {
    idle: '空车',
    hired: '载客',
    waiting: '等候',
    trip: '本程',
    lastTrip: '上一程',
    perMin: '/分',
    budget: '预算',
    over: '超预算',
  },
  en: {
    idle: 'FOR HIRE',
    hired: 'HIRED',
    waiting: 'WAITING',
    trip: 'trip',
    lastTrip: 'last',
    perMin: '/min',
    budget: 'budget',
    over: 'OVER BUDGET',
  },
} as const

export type Face = {
  phase: Phase
  /** Units on the drum now. */
  units: number
  /** Units the last burst of jumps added, shown for a moment. */
  flash: number
  /** This ride's fare so far, or the last ride's when idle, in units. */
  trip: number | null
  /** Units per minute over the last minute, while hired. */
  rate: number
  /** The tool the meter is waiting on. */
  tool: string | null
  /** The hired light: on, off, on... */
  isLit: boolean
  /** The fare limit in units, or null for none. */
  budget: number | null
  /** This month's API value over the subscription's price, or null off a plan. */
  payback?: number | null
}

/** "47%" under 1×, "3.2×" from there. */
export function paybackText(x: number, lang: Lang): string {
  if (x < 1) return `${Math.floor(x * 100)}%`
  const n = x >= 10 ? Math.floor(x).toString() : (Math.floor(x * 10) / 10).toFixed(1)
  return lang === 'zh' ? `${n} 倍` : `${n}×`
}

export const PAYBACK_MILESTONES = [1, 2, 3, 5, 10, 20, 50, 100]

/** The highest payback milestone reached, 0 when none. */
export function paybackAt(x: number): number {
  let hit = 0
  for (const m of PAYBACK_MILESTONES) if (x + 1e-9 >= m) hit = m
  return hit
}

export function paybackToast(level: number, plan: string, lang: Lang): string {
  if (level === 1) {
    return lang === 'zh'
      ? `🎉 回本了！这个月的用量已经抵得上 ${plan} 的订阅费`
      : `🎉 Paid back! This month's usage is now worth your ${plan} plan`
  }
  return lang === 'zh'
    ? `💎 回本 ${level} 倍：这个月白赚了 ${level - 1} 份订阅费`
    : `💎 ${level}× paid back: this month's usage is worth ${level} of your ${plan} plans`
}

/** How much of the budget the drum shows, in percent; null with no budget. */
export function budgetPct(f: Pick<Face, 'units' | 'budget'>): number | null {
  return f.budget === null || f.budget <= 0 ? null : Math.floor((f.units / f.budget) * 100)
}

/** The status line: one row, steady width for the drum. */
export function face(f: Face, lang: Lang, currency: Currency): string {
  const w = WORDS[lang]
  const label =
    f.phase === 'idle'
      ? `🚕 ${w.idle}`
      : f.phase === 'waiting'
        ? `🚕 ${w.waiting}⏳`
        : `🚖 ${w.hired}${f.isLit ? '●' : '○'}`
  const drum = money(f.units, currency).padStart(7, ' ')
  const parts = [`${label} ${drum}`]
  if (f.flash > 0) parts[0] += ` ▲${(f.flash / 100).toFixed(2)}`
  if (f.trip !== null && f.trip > 0) {
    parts.push(`${f.phase === 'idle' ? w.lastTrip : w.trip} ${money(f.trip, currency)}`)
  }
  if (f.phase === 'hired' && f.rate >= 1) {
    parts.push(`🔥${money(Math.round(f.rate), currency)}${w.perMin}`)
  }
  if (f.phase === 'waiting' && f.tool) parts.push(f.tool)
  const pct = budgetPct(f)
  if (pct !== null) {
    parts.push(pct >= 100 ? `🛑 ${w.over}` : `${pct >= 80 ? '⚠️ ' : ''}${w.budget} ${pct}%`)
  }
  if (f.payback !== undefined && f.payback !== null) {
    parts.push(`💎 ${lang === 'zh' ? '回本 ' : ''}${paybackText(f.payback, lang)}${lang === 'zh' ? '' : ' plan'}`)
  }

  return parts.join(' · ')
}

export function milestoneToast(m: number, lang: Lang, currency: Currency, cnyRate: number): string {
  const fare = moneyUsd(m, currency, cnyRate)
  const lattes = (m / 5).toFixed(1)
  return lang === 'zh'
    ? `💸 叮！车费突破 ${fare}，够买 ${lattes} 杯拿铁了`
    : `💸 Ka-ching! The fare just passed ${fare}: ${lattes} lattes`
}

export function bigTripToast(t: Trip, lang: Lang, currency: Currency, cnyRate: number): string {
  const fare = moneyUsd(t.fare, currency, cnyRate)
  const secs = Math.round(t.ms / 1000)
  return lang === 'zh'
    ? `🧾 这一程 ${fare} · ${secs}s · 跳表 ${t.jumps} 次`
    : `🧾 That ride: ${fare} · ${secs}s · ${t.jumps} jumps`
}

/** What the money would have bought on the street instead. */
export function streetValue(usd: number, lang: Lang, cnyRate: number): string {
  if (lang === 'zh') {
    // 北京出租车：起步 13 元含 3 公里，之后 2.3 元/公里
    const cny = usd * cnyRate
    const km = cny <= 13 ? (cny / 13) * 3 : 3 + (cny - 13) / 2.3
    return `≈ ${(usd / 5).toFixed(1)} 杯拿铁 · ≈ 北京打车 ${km.toFixed(1)} 公里`
  }
  // NYC yellow cab: $3 to get in, $3.50 a mile
  const miles = usd <= 3 ? 0 : (usd - 3) / 3.5
  return `≈ ${(usd / 5).toFixed(1)} lattes · ≈ ${miles.toFixed(1)} miles in a NYC cab`
}

export type ReceiptInput = {
  lang: Lang
  currency: Currency
  cnyRate: number
  ledger: number
  trips: readonly Trip[]
  jumps: number
  startedAt: number
  now: number
  lifetime: number
  model: string
  /** API value this month, and the plan's monthly price (0 off a plan). */
  monthUsd?: number
  planUsd?: number
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** The receipt `/taxi` prints. */
export function receipt(r: ReceiptInput): string {
  const $ = (usd: number) => moneyUsd(usd, r.currency, r.cnyRate)
  const top = r.trips.reduce<Trip | null>((a, t) => (a === null || t.fare > a.fare ? t : a), null)
  const avg = r.trips.length ? r.trips.reduce((sum, t) => sum + t.fare, 0) / r.trips.length : 0
  const zh = r.lang === 'zh'
  const rows: [string, string][] = zh
    ? [
        ['车型', r.model || '—'],
        ['上车', `${clock(r.startedAt)}  已行驶 ${minutes(r.now - r.startedAt)}`],
        ['里程', `${r.trips.length} 程 · 跳表 ${r.jumps} 次`],
        ['均价', `${$(avg)} / 程`],
        ['最贵', top ? `${$(top.fare)}「${top.prompt}」` : '—'],
        ['累计', `${$(r.lifetime)}（所有会话）`],
        ...((r.planUsd ?? 0) > 0
          ? [['本月', `${$(r.monthUsd ?? 0)} / 订阅 ${$(r.planUsd!)} → 回本 ${paybackText((r.monthUsd ?? 0) / r.planUsd!, 'zh')}`] as [string, string]]
          : []),
      ]
    : [
        ['Car', r.model || '—'],
        ['Hailed', `${clock(r.startedAt)}  riding ${minutes(r.now - r.startedAt)}`],
        ['Rides', `${r.trips.length} · ${r.jumps} jumps`],
        ['Average', `${$(avg)} / ride`],
        ['Priciest', top ? `${$(top.fare)} "${top.prompt}"` : '—'],
        ['Lifetime', `${$(r.lifetime)} (all sessions)`],
        ...((r.planUsd ?? 0) > 0
          ? [['Month', `${$(r.monthUsd ?? 0)} on a ${$(r.planUsd!)} plan → ${paybackText((r.monthUsd ?? 0) / r.planUsd!, 'en')} paid back`] as [string, string]]
          : []),
      ]
  const rule = '─'.repeat(34)
  const lines = [
    zh ? '🧾  CLAUDE 出租车 · 乘车凭证' : '🧾  CLAUDE TAXI · RECEIPT',
    rule,
    ...rows.map(([k, v]) => `${k.padEnd(zh ? 4 : 9, zh ? '　' : ' ')} ${v}`),
    rule,
    `${zh ? '实收金额' : 'TOTAL'}  ${$(r.ledger)}`,
    streetValue(r.ledger, r.lang, r.cnyRate),
  ]
  const recent = r.trips.slice(-5)
  if (recent.length > 0) {
    lines.push(rule, zh ? '最近几程' : 'Last rides')
    for (const t of recent) {
      lines.push(`  ${clock(t.at)}  ${$(t.fare).padStart(8)}  ${t.prompt}`)
    }
  }
  lines.push(rule, zh ? '谢谢乘坐，请带好随身物品 🙏' : 'Thanks for riding. Mind your belongings 🙏')

  return lines.join('\n')
}

// Seven-segment glyphs, three rows each, for the pane's drum.
const SEGMENTS: Record<string, readonly [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['  ╻', '  ┃', '  ╹'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '▪'],
  '$': ['┏╋╸', '┗╋┓', '╺╋┛'],
  '¥': ['╲ ╱', '━┳━', '╺╋╸'],
}

/** A fare in seven-segment digits: three rows, or none when a glyph is missing. */
export function bigDigits(text: string): string[] | null {
  const rows = ['', '', '']
  for (const ch of text) {
    const g = SEGMENTS[ch]
    if (!g) return null
    for (let i = 0; i < 3; i++) rows[i] += (rows[i] ? ' ' : '') + g[i]
  }
  return rows
}

const BARS = '▁▂▃▄▅▆▇█'

/** Spend per bucket as a one-line chart; an empty bucket is the lowest bar. */
export function sparkline(values: readonly number[]): string {
  const top = Math.max(...values, 0)
  return values
    .map(v => (top <= 0 || v <= 0 ? BARS[0] : BARS[Math.min(7, Math.ceil((v / top) * 7))]))
    .join('')
}

/** The ledger's history cut into `count` buckets of `bucketMs`, ending at `now`: spend in each. */
export function spendBuckets(
  history: readonly (readonly [number, number])[],
  now: number,
  count: number,
  bucketMs: number,
): number[] {
  const at = (t: number) => {
    let usd = 0
    for (const [time, value] of history) if (time <= t) usd = value
    return usd
  }
  const out: number[] = []
  for (let i = count - 1; i >= 0; i--) {
    const end = now - i * bucketMs
    out.push(Math.max(0, at(end) - at(end - bucketMs)))
  }
  return out
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const PANE_WORDS = {
  zh: {
    title: '🚕 计价器',
    brand: 'CLAUDE 出租车',
    ride: '本程',
    last: '上一程',
    time: '用时',
    rate: '速度',
    budget: '预算',
    noBudget: '未设预算',
    spend: '近 30 分钟',
    payback: '本月回本',
    recent: '最近几程',
    none: '还没有乘客',
    receipt: '小票',
    currency: '换币种',
    addBudget: '预算 +$5',
    clearBudget: '清除预算',
    hide: '隐藏状态栏',
    show: '显示状态栏',
    close: '关闭',
  },
  en: {
    title: '🚕 Meter',
    brand: 'CLAUDE TAXI',
    ride: 'ride',
    last: 'last ride',
    time: 'time',
    rate: 'rate',
    budget: 'budget',
    noBudget: 'no budget',
    spend: 'last 30 min',
    payback: 'plan paid back',
    recent: 'Recent rides',
    none: 'No rides yet',
    receipt: 'Receipt',
    currency: 'USD⇄CNY',
    addBudget: 'Budget +$5',
    clearBudget: 'No budget',
    hide: 'Hide status',
    show: 'Show status',
    close: 'Close',
  },
} as const

export function budgetToast(pct: number, budget: string, lang: Lang): string {
  if (pct >= 100) {
    return lang === 'zh'
      ? `🛑 已超出预算 ${budget}。/taxi budget 可以加钱，或者该下车了`
      : `🛑 Over your ${budget} budget. /taxi budget to top up, or time to get out`
  }
  return lang === 'zh'
    ? `⚠️ 预算 ${budget} 已用 ${pct}%`
    : `⚠️ ${pct}% of your ${budget} budget is gone`
}

export type ShareInput = ReceiptInput

export const REPO_URL = 'github.com/gxcsoccer/claude-taxi-meter'

/** A few lines to paste anywhere: the brag (or the confession). */
export function shareCard(r: ShareInput): string {
  const $ = (usd: number) => moneyUsd(usd, r.currency, r.cnyRate)
  const top = r.trips.reduce<Trip | null>((a, t) => (a === null || t.fare > a.fare ? t : a), null)
  const zh = r.lang === 'zh'
  const plan = r.planUsd ?? 0
  const lines = zh
    ? [
        '🚕 Claude 出租车 · 今日行程',
        `⏱ ${minutes(r.now - r.startedAt)} · ${r.trips.length} 程 · 跳表 ${r.jumps} 次`,
        `💸 车费 ${$(r.ledger)}（${streetValue(r.ledger, 'zh', r.cnyRate)}）`,
      ]
    : [
        '🚕 Claude Taxi · today\'s ride',
        `⏱ ${minutes(r.now - r.startedAt)} · ${r.trips.length} rides · ${r.jumps} jumps`,
        `💸 Fare ${$(r.ledger)} (${streetValue(r.ledger, 'en', r.cnyRate)})`,
      ]
  if (plan > 0) {
    const x = paybackText((r.monthUsd ?? 0) / plan, r.lang)
    lines.push(zh ? `💎 本月订阅已回本 ${x}` : `💎 This month's plan: ${x} paid back`)
  }
  if (top) lines.push(zh ? `🧾 最贵一程 ${$(top.fare)}「${top.prompt}」` : `🧾 Priciest ride ${$(top.fare)} "${top.prompt}"`)
  lines.push(REPO_URL)
  return lines.join('\n')
}

export function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
