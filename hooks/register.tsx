import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Live, Trip } from '../types'
import {
  PANE_WORDS,
  bigDigits,
  bigTripToast,
  budgetPct,
  budgetToast,
  costOf,
  duration,
  face,
  MILESTONES,
  milestoneAt,
  milestoneToast,
  monthKey,
  paybackAt,
  paybackText,
  paybackToast,
  shareCard,
  money,
  moneyUsd,
  receipt,
  rollStep,
  sparkline,
  spendBuckets,
  streamingCost,
  toUnits,
} from './meter'
import type { Currency, Lang, Phase } from './meter'

const trips = atom({ plugin: 'taxi-meter', key: 'trips' } as const, [])
const milestone = atom({ plugin: 'taxi-meter', key: 'milestone' } as const, 0)
const jumpCount = atom({ plugin: 'taxi-meter', key: 'jumps' } as const, 0)
const budget = atom({ plugin: 'taxi-meter', key: 'budgetUsd' } as const, -1)
const budgetWarned = atom({ plugin: 'taxi-meter', key: 'budgetWarned' } as const, 0)
const isHidden = atom({ plugin: 'taxi-meter', key: 'isHidden' } as const, false)
const isPaneOpen = atom({ plugin: 'taxi-meter', key: 'isPaneOpen' } as const, false)
const history = atom({ plugin: 'taxi-meter', key: 'history' } as const, [])
const live = atom({ plugin: 'taxi-meter', key: 'live' } as const, {
  phase: 'idle',
  units: 0,
  flash: 0,
  trip: null,
  rate: 0,
  tool: null,
  isLit: true,
  rideMs: 0,
} as Live)

const PANE = 'taxi-meter'

/** How often the drum turns, ms. */
const TICK = 120
/** Thinking streams nothing we can count, so bill it by time like a cab in traffic: tokens a second. */
const QUIET_TPS = 40
/** Quiet this long and the meter starts charging for time. */
const QUIET_AFTER = 400
/** How long the ▲ of a jump stays lit. */
const FLASH_MS = 1500
/** Jumps closer together than this read as one burst under the ▲. */
const BURST_MS = 400

type Step = {
  model: string
  chars: number
  quietTokens: number
  lastChunkAt: number
  /** What the response cost, once its stop arrived; until then the stream is estimated. */
  final: number | null
}

type Ride = { startUsd: number; startedAt: number; prompt: string; jumps: number }

/** A pretend ride for recording: drives the drum on its own clock, bills nothing, records nothing. */
type Demo = {
  startedAt: number
  /** The fare the drum stood at when it began, USD. */
  startUsd: number
  /** What the whole ride adds, USD. */
  total: number
  /** What it has added so far, USD. */
  added: number
  phase: Phase
  tool: string | null
  jumps: number
  /** The milestone it rang, so it rings once. */
  rung: number
  /** The last ride's fare before it, put back when it ends. */
  lastTrip: number | null
  timer: Timer | null
}

/** The demo's script, ms from its start. */
const DEMO = { stream1: 800, tool: 5000, stream2: 6800, end: 10000, done: 14000 }

const cfg = {
  lang: 'en' as Lang,
  currency: 'USD' as Currency,
  cnyRate: 7.1,
  hasSound: true,
  bigTripUsd: 0.5,
  budgetUsd: 0,
  /** The subscription's monthly price, USD; 0 off a plan. */
  planUsd: 0,
}

// The ledger is the truth (what /cost says); steps are what is still on its way to it.
const m = {
  ledger: 0,
  steps: new Map<string, Step>(),
  /** Units on the drum; -1 until the first reading. */
  shown: -1,
  settledSince: 0,
  flash: 0,
  flashUntil: 0,
  lastJumpAt: 0,
  now: 0,
  ticker: null as Timer | null,
  isTicking: false,
  lastFace: '',
  lastLive: '',
  isLit: true,
  tools: 0,
  tool: null as string | null,
  ride: null as Ride | null,
  lastTrip: null as number | null,
  model: '',
  samples: [] as [number, number][],
  demo: null as Demo | null,
  // Session values the tick reads synchronously, kept in step with their atoms.
  budgetUsd: 0,
  /** API value this calendar month, across sessions, as last credited. */
  monthUsd: 0,
  isHidden: false,
  isPaneOpen: false,
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 24 ? `${one.slice(0, 23)}…` : one || '…'
}

const units = (usd: number) => toUnits(usd, cfg.currency, cfg.cnyRate)
const factor = () => (cfg.currency === 'CNY' ? cfg.cnyRate : 1)

function target(): number {
  let usd = m.ledger + (m.demo?.added ?? 0)
  for (const s of m.steps.values()) usd += s.final ?? streamingCost(s.model, s.chars, s.quietTokens)
  return usd
}

function phase(): Phase {
  if (m.demo) return m.demo.phase
  const isStreaming = [...m.steps.values()].some(s => s.final === null)
  if (isStreaming) return 'hired'
  if (m.tools > 0) return 'waiting'
  return m.ride !== null || m.steps.size > 0 ? 'hired' : 'idle'
}

function snapshot(): Live {
  const first = m.samples[0]
  const last = m.samples[m.samples.length - 1]
  const rate =
    first && last && m.now - first[0] >= 5000 ? ((last[1] - first[1]) / (m.now - first[0])) * 60000 : 0
  return {
    phase: phase(),
    units: Math.max(0, m.shown),
    flash: m.now < m.flashUntil ? m.flash : 0,
    trip:
      m.demo && m.demo.phase !== 'idle'
        ? Math.max(0, m.shown - units(m.demo.startUsd))
        : m.ride !== null
          ? Math.max(0, m.shown - units(m.ride.startUsd))
          : m.lastTrip,
    rate,
    tool: m.demo ? m.demo.tool : m.tool,
    isLit: m.isLit,
    rideMs:
      m.demo && m.demo.phase !== 'idle'
        ? Math.max(0, m.now - m.demo.startedAt)
        : m.ride !== null
          ? Math.max(0, m.now - m.ride.startedAt)
          : 0,
  }
}

/** This month's API value over the plan's price, the drum's unsettled part included; null off a plan. */
function payback(): number | null {
  if (cfg.planUsd <= 0) return null
  const unsettled = Math.max(0, m.shown / 100 / factor() - m.ledger)
  return (m.monthUsd + unsettled) / cfg.planUsd
}

async function draw($: EngineInterface): Promise<void> {
  const now = snapshot()
  const text = face(
    { ...now, budget: m.budgetUsd > 0 ? units(m.budgetUsd) : null, payback: payback() },
    cfg.lang,
    cfg.currency,
  )
  const shownText = m.isHidden ? '' : text
  if (shownText !== m.lastFace) {
    m.lastFace = shownText
    $.ui.status(m.isHidden ? undefined : text)
  }
  if (m.isPaneOpen) {
    // The pane shows the ride clock too, so it redraws once a second even when the drum rests.
    const key = `${text}|${Math.floor(now.rideMs / 1000)}`
    if (key !== m.lastLive) {
      m.lastLive = key
      await update($, live, () => now)
    }
  }
}

/** Rings once the drum itself rolls past a milestone, and warns as the budget runs out. */
async function ring($: EngineInterface): Promise<void> {
  const usd = m.shown / 100 / factor()
  if (m.demo) {
    // The demo rings like the real thing and writes nothing down.
    const passed = milestoneAt(usd)
    if (passed > m.demo.rung) {
      m.demo.rung = passed
      $.ui.toast(milestoneToast(passed, cfg.lang, cfg.currency, cfg.cnyRate), { timeoutMs: 5000 })
      if (cfg.hasSound) await $.audio.play({ asset: 'sounds/kaching.wav' }).catch(() => undefined)
    }
    return
  }
  const passed = milestoneAt(usd)
  if (passed > (await read($, milestone))) {
    await update($, milestone, () => passed)
    $.ui.toast(milestoneToast(passed, cfg.lang, cfg.currency, cfg.cnyRate), { timeoutMs: 5000 })
    if (cfg.hasSound) await $.audio.play({ asset: 'sounds/kaching.wav' }).catch(() => undefined)
  }

  const x = payback()
  if (x !== null) {
    // Once per level per month, across sessions.
    const month = monthKey(await $.clock.now())
    const held = ((await $.store.get('paybackRung')) ?? {}) as { month?: string; level?: number }
    const level = paybackAt(x)
    if (level > (held.month === month ? (held.level ?? 0) : 0)) {
      await $.store.set('paybackRung', { month, level })
      $.ui.toast(paybackToast(level, moneyUsd(cfg.planUsd, cfg.currency, cfg.cnyRate), cfg.lang), { timeoutMs: 8000 })
      if (cfg.hasSound) await $.audio.play({ asset: 'sounds/kaching.wav' }).catch(() => undefined)
    }
  }

  const pct = budgetPct({ units: m.shown, budget: m.budgetUsd > 0 ? units(m.budgetUsd) : null })
  if (pct === null) return
  const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0
  if (level > (await read($, budgetWarned))) {
    await update($, budgetWarned, () => level)
    const limit = moneyUsd(m.budgetUsd, cfg.currency, cfg.cnyRate)
    $.ui.toast(budgetToast(Math.min(pct, 100), limit, cfg.lang), { timeoutMs: 8000 })
    if (cfg.hasSound && level === 100) await $.audio.play({ asset: 'sounds/kaching.wav' }).catch(() => undefined)
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (m.isTicking) return
  m.isTicking = true
  try {
    const at = await $.clock.now()
    const dt = m.now === 0 ? 0 : at - m.now
    m.now = at
    m.isLit = Math.floor(at / 480) % 2 === 0

    for (const s of m.steps.values()) {
      if (s.final === null && at - s.lastChunkAt > QUIET_AFTER) s.quietTokens += (QUIET_TPS * dt) / 1000
    }

    const goal = units(target())
    if (m.shown < 0) m.shown = goal
    const step = rollStep(goal - m.shown)
    if (step > 0) {
      m.shown += step
      m.flash = (at - m.lastJumpAt <= BURST_MS ? m.flash : 0) + step
      m.lastJumpAt = at
      m.flashUntil = at + FLASH_MS
      if (m.demo) m.demo.jumps += 1
      else {
        if (m.ride) m.ride.jumps += 1
        await update($, jumpCount, n => n + 1)
      }
      await ring($)
    }

    const last = m.samples[m.samples.length - 1]
    if (!last || at - last[0] >= 1000) {
      m.samples.push([at, m.shown])
      while (m.samples.length > 0 && at - m.samples[0]![0] > 60000) m.samples.shift()
    }

    // An estimate that ran ahead of the ledger: once nothing is moving, own up to it.
    const isQuiet = phase() === 'idle' && m.steps.size === 0
    if (isQuiet && goal < m.shown) {
      if (m.settledSince === 0) m.settledSince = at
      if (at - m.settledSince > 2000) m.shown = goal
    } else {
      m.settledSince = 0
    }

    await draw($)

    if (isQuiet && goal === m.shown && at >= m.flashUntil) {
      m.ticker?.cancel()
      m.ticker = null
      m.samples.length = 0
    }
  } finally {
    m.isTicking = false
  }
}

/** Keeps the drum turning until the cab is idle and the drum caught up. */
async function run($: EngineInterface): Promise<void> {
  if (m.ticker === null) m.ticker = $.clock.every(TICK, () => void tick($))
  await tick($)
}

/** Takes the session's ledger, and drops the responses it now covers. */
async function settle($: EngineInterface, usd: number): Promise<void> {
  if (usd + 1e-9 < m.ledger) {
    // A fresh session under us: the meter starts over.
    m.shown = units(usd)
    m.ride = null
    m.lastTrip = null
  }
  m.ledger = usd
  for (const [key, s] of m.steps) if (s.final !== null) m.steps.delete(key)

  await credit($, usd)
  const at = await $.clock.now()
  await update($, history, list =>
    list[list.length - 1]?.[1] === usd ? list : [...list, [at, usd] as [number, number]].slice(-500),
  )
  await run($)
}

/**
 * Adds what this session spent since last seen to the lifetime odometer. Kept per
 * session id in the store, so a reload, a resume or a second process never counts twice.
 */
async function credit($: EngineInterface, usd: number): Promise<void> {
  const sid = await $.session.id()
  const raw = await $.store.get('seenBySession')
  const seen = { ...((raw ?? {}) as Record<string, number>) }
  const before = seen[sid] ?? 0
  let lifetime = Number((await $.store.get('lifetimeUsd')) ?? 0)
  if (raw === undefined) {
    // 0.1.0 counted only from when the mod loaded: open the book with this session's whole fare.
    lifetime = Math.max(lifetime, usd)
  } else if (usd > before) {
    lifetime += usd - before
  } else {
    return
  }
  // Newest last, so the oldest sessions fall off the end.
  delete seen[sid]
  seen[sid] = usd
  await $.store.set('seenBySession', Object.fromEntries(Object.entries(seen).slice(-200)))
  const grown = lifetime - Number((await $.store.get('lifetimeUsd')) ?? 0)
  await $.store.set('lifetimeUsd', lifetime)

  // The month's book: a store from before months were kept opens it with the whole lifetime.
  const month = monthKey(await $.clock.now())
  const months = (await $.store.get('monthUsd')) as Record<string, number> | undefined
  const book = months === undefined ? { [month]: lifetime } : { ...months, [month]: (months[month] ?? 0) + grown }
  await $.store.set('monthUsd', Object.fromEntries(Object.entries(book).slice(-24)))
  m.monthUsd = book[month] ?? 0
}

async function loadMonth($: EngineInterface): Promise<void> {
  const months = (await $.store.get('monthUsd')) as Record<string, number> | undefined
  // Before months were kept, everything counted so far stands for this month.
  m.monthUsd =
    months === undefined
      ? Number((await $.store.get('lifetimeUsd')) ?? 0)
      : (months[monthKey(await $.clock.now())] ?? 0)
}

/** The text `/taxi share` copies, from the same figures as the receipt. */
async function figures($: EngineInterface) {
  await resync($)
  const usage = await $.session.usage()
  return {
    lang: cfg.lang,
    currency: cfg.currency,
    cnyRate: cfg.cnyRate,
    ledger: usage.cost?.usd ?? m.ledger,
    trips: await read($, trips),
    jumps: await read($, jumpCount),
    startedAt: usage.startedAt,
    now: await $.clock.now(),
    lifetime: Number((await $.store.get('lifetimeUsd')) ?? 0),
    model: m.model || (await read($, trips)).at(-1)?.model || '',
    monthUsd: m.monthUsd,
    planUsd: cfg.planUsd,
  }
}

async function resync($: EngineInterface): Promise<void> {
  const { cost } = await $.session.usage()
  if (cost) await settle($, cost.usd)
}

async function setBudget($: EngineInterface, usd: number): Promise<void> {
  m.budgetUsd = Math.max(0, usd)
  await update($, budget, () => m.budgetUsd)
  // A new limit warns afresh from where the fare stands now.
  const pct = budgetPct({ units: m.shown, budget: m.budgetUsd > 0 ? units(m.budgetUsd) : null }) ?? 0
  await update($, budgetWarned, () => (pct >= 100 ? 100 : pct >= 80 ? 80 : 0))
  await run($)
}

async function setHidden($: EngineInterface, hidden: boolean): Promise<void> {
  m.isHidden = hidden
  await update($, isHidden, () => hidden)
  await run($)
}

async function openPane($: EngineInterface): Promise<void> {
  m.isPaneOpen = true
  m.lastLive = ''
  await update($, isPaneOpen, () => true)
  await $.ui.open({ id: PANE, title: PANE_WORDS[cfg.lang].title, rows: 16 })
  await run($)
  await draw($)
}

async function printReceipt($: EngineInterface): Promise<string> {
  return receipt(await figures($))
}

/** Starts a pretend ride that crosses the next milestone, so a recording catches every beat. */
async function startDemo($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const fare = target()
  const next = MILESTONES.find(x => x > fare + 0.05)
  // Ring a milestone near the end when one is in reach; otherwise a plain ride.
  const total = next !== undefined && next - fare <= 6 ? next - fare + 0.37 : 2.48
  m.demo = {
    startedAt: now,
    startUsd: fare,
    total,
    added: 0,
    phase: 'hired',
    tool: null,
    jumps: 0,
    rung: milestoneAt(fare),
    lastTrip: m.lastTrip,
    timer: null,
  }
  m.demo.timer = $.clock.every(100, () => void demoStep($))
  await run($)
}

/** Moves the demo along its script: stream, wait on a tool, stream, arrive, then put everything back. */
async function demoStep($: EngineInterface): Promise<void> {
  const d = m.demo
  if (!d) return
  const t = (await $.clock.now()) - d.startedAt
  const ease = (from: number, to: number, a: number, b: number) =>
    from + (to - from) * Math.min(1, Math.max(0, (t - a) / (b - a)))

  if (t < DEMO.stream1) {
    d.phase = 'hired'
  } else if (t < DEMO.tool) {
    d.phase = 'hired'
    d.added = ease(0, d.total * 0.45, DEMO.stream1, DEMO.tool)
  } else if (t < DEMO.stream2) {
    d.phase = 'waiting'
    d.tool = 'Bash'
  } else if (t < DEMO.end) {
    d.phase = 'hired'
    d.tool = null
    d.added = ease(d.total * 0.45, d.total, DEMO.stream2, DEMO.end)
  } else if (d.phase !== 'idle') {
    d.phase = 'idle'
    d.added = d.total
    m.lastTrip = units(d.total)
    const ride: Trip = {
      fare: d.total,
      ms: DEMO.end,
      at: d.startedAt + DEMO.end,
      prompt: 'demo',
      model: m.model,
      jumps: d.jumps,
    }
    $.ui.toast(bigTripToast(ride, cfg.lang, cfg.currency, cfg.cnyRate), { timeoutMs: 5000 })
  } else if (t >= DEMO.done) {
    // Back to the real meter, as if the demo never ran.
    d.timer?.cancel()
    m.demo = null
    m.lastTrip = d.lastTrip
    m.shown = units(target())
    m.samples.length = 0
  }
  await run($)
}

const HELP = {
  en: [
    '/taxi                print the receipt',
    '/taxi meter          open the live meter pane',
    '/taxi budget 5       warn at 80% and 100% of $5 this session (off to clear)',
    '/taxi usd | cny      switch currency',
    '/taxi en | zh        switch language',
    '/taxi hide | show    hide or show the status line meter',
    '/taxi plan 200       your subscription price a month: shows how many times over it pays back (off to clear)',
    '/taxi share          copy a ride summary to paste anywhere',
    '/taxi demo           a pretend 10-second ride for recording a GIF: nothing is billed or recorded',
  ],
  zh: [
    '/taxi                打印小票',
    '/taxi meter          打开实时计价器面板',
    '/taxi budget 5       本次会话预算 $5，用到 80% 和 100% 时提醒（off 清除）',
    '/taxi usd | cny      切换币种',
    '/taxi en | zh        切换语言',
    '/taxi hide | show    隐藏或显示状态栏计价器',
    '/taxi plan 200       填写每月订阅价，显示本月回本了几倍（off 清除）',
    '/taxi share          复制一段行程总结，方便分享',
    '/taxi demo           模拟一段 10 秒的行程，方便录 GIF：不计费、不记录',
  ],
} as const

export const register: Register = (on, options) => {
  cfg.lang = options.language === 'zh' ? 'zh' : 'en'
  cfg.currency = options.currency === 'CNY' ? 'CNY' : 'USD'
  cfg.cnyRate = typeof options.cnyRate === 'number' && options.cnyRate > 0 ? options.cnyRate : 7.1
  cfg.hasSound = options.sound !== false
  cfg.bigTripUsd = typeof options.bigTripUsd === 'number' ? options.bigTripUsd : 0.5
  cfg.budgetUsd = typeof options.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : 0
  cfg.planUsd = typeof options.planUsd === 'number' && options.planUsd > 0 ? options.planUsd : 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'taxi',
      description:
        cfg.lang === 'zh' ? '计价器：小票、实时面板、预算、币种' : 'Taxi meter: receipt, live pane, budget, currency',
      argumentHint: 'meter | demo | share | plan <usd|off> | budget <usd|off> | usd | cny | en | zh | hide | show',
      immediate: true,
    })
    const { cost } = await $.session.usage()
    m.ledger = cost?.usd ?? 0
    m.shown = units(m.ledger)
    // Milestones already behind us (a reload, a resume) do not ring again.
    const passed = milestoneAt(m.ledger)
    if (passed > (await read($, milestone))) await update($, milestone, () => passed)
    await loadMonth($)
    await credit($, m.ledger)
    m.model = await $.session.model()

    // A session budget set with /taxi outlives a reload; the configured one is the default.
    const held = await read($, budget)
    if (held < 0) await setBudget($, cfg.budgetUsd)
    else m.budgetUsd = held
    m.isHidden = await read($, isHidden)
    m.isPaneOpen = await read($, isPaneOpen)
    await run($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, trips, () => [])
      await update($, jumpCount, () => 0)
      await update($, milestone, () => 0)
      await update($, history, () => [])
      await update($, budgetWarned, () => 0)
      m.ledger = 0
      m.shown = 0
      m.ride = null
      m.lastTrip = null
      m.steps.clear()
      await run($)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost && e.changed.includes('cost')) await settle($, e.cost.usd)
    // Rate-limit windows only come with a subscription: say once, ever, what /taxi plan does.
    const isSubscribed = e.rateLimits.some(r => r.kind === 'five_hour' || r.kind === 'seven_day')
    if (isSubscribed && cfg.planUsd <= 0 && (await $.store.get('planHinted')) !== true) {
      await $.store.set('planHinted', true)
      $.ui.toast(
        cfg.lang === 'zh'
          ? '💎 检测到你在用订阅：/taxi plan 200（填你的月费）就能看到本月回本了几倍'
          : "💎 You're on a subscription: /taxi plan 200 (your monthly price) shows how many times over it pays back",
        { timeoutMs: 10000 },
      )
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    m.ride = { startUsd: target(), startedAt: await $.clock.now(), prompt: clip(e.text), jumps: 0 }
    await run($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const key = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const step: Step = { model: e.model, chars: 0, quietTokens: 0, lastChunkAt: await $.clock.now(), final: null }
    m.steps.set(key, step)
    if (e.agentId === undefined || m.model === '') m.model = e.model
    await run($)

    try {
      for await (const chunk of next(e)) {
        if ((chunk.kind === 'text' || chunk.kind === 'thinking') && chunk.text.length > 0) {
          step.chars += chunk.text.length
          step.lastChunkAt = m.now
        } else if (chunk.kind === 'input') {
          step.chars += chunk.json.length
          step.lastChunkAt = m.now
        } else if (chunk.kind === 'stop') {
          step.final = chunk.usage ? costOf(chunk.usage.model, chunk.usage) : 0
        }
        yield chunk
      }
    } finally {
      // Interrupted before the stop: what was spent is the ledger's to say.
      if (step.final === null) step.final = 0
      // The ledger may have counted this response before its stop reached us.
      $.clock.after(600, () => void resync($))
    }
  })

  on('tool.call', async ($, e, next) => {
    m.tools += 1
    m.tool = e.tool
    await run($)
    try {
      return await next(e)
    } finally {
      m.tools -= 1
      if (m.tools === 0) m.tool = null
      await run($)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || m.ride === null) return next(e)

    await resync($)
    const done = m.ride
    m.ride = null
    const at = await $.clock.now()
    const trip: Trip = {
      fare: Math.max(0, target() - done.startUsd),
      ms: at - done.startedAt,
      at,
      prompt: done.prompt,
      model: e.usage?.model ?? m.model,
      jumps: done.jumps,
    }
    m.lastTrip = units(trip.fare)
    await update($, trips, list => [...list, trip].slice(-200))
    if (trip.fare >= cfg.bigTripUsd) {
      $.ui.toast(bigTripToast(trip, cfg.lang, cfg.currency, cfg.cnyRate), { timeoutMs: 6000 })
    }
    await run($)

    return next(e)
  })

  on('command.run', { command: 'taxi' }, async ($, e) => {
    const [word = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const zh = cfg.lang === 'zh'

    switch (word) {
      case '':
      case 'receipt':
        return { text: await printReceipt($) }
      case 'meter':
      case 'pane':
        await openPane($)
        return { text: zh ? '🚕 计价器面板已打开' : '🚕 Meter pane opened' }
      case 'budget': {
        if (arg === '') {
          const now = m.budgetUsd > 0 ? moneyUsd(m.budgetUsd, cfg.currency, cfg.cnyRate) : null
          return { text: now ? (zh ? `本次预算 ${now}` : `Budget this session: ${now}`) : zh ? '未设预算' : 'No budget set' }
        }
        if (arg === 'off' || arg === '0') {
          await setBudget($, 0)
          return { text: zh ? '预算已清除' : 'Budget cleared' }
        }
        const usd = Number(arg.replace(/^[$¥]/, '')) / (arg.startsWith('¥') ? cfg.cnyRate : 1)
        if (!Number.isFinite(usd) || usd <= 0) {
          return { text: zh ? '用法：/taxi budget 5（美元）或 /taxi budget off' : 'Usage: /taxi budget 5 (USD) or /taxi budget off' }
        }
        await setBudget($, usd)
        const limit = moneyUsd(usd, cfg.currency, cfg.cnyRate)
        return { text: zh ? `预算设为 ${limit}，用到 80% 和 100% 时提醒` : `Budget set to ${limit}: you'll be warned at 80% and 100%` }
      }
      case 'usd':
      case 'cny':
        await $.config.set({ key: 'taxi-meter.currency', value: word.toUpperCase() })
        return { text: zh ? `币种已切换为 ${word.toUpperCase()}` : `Currency switched to ${word.toUpperCase()}` }
      case 'en':
      case 'zh':
        await $.config.set({ key: 'taxi-meter.language', value: word })
        return { text: word === 'zh' ? '计价器已切换为中文' : 'Meter switched to English' }
      case 'plan': {
        if (arg === '') {
          return {
            text:
              cfg.planUsd > 0
                ? zh
                  ? `订阅 ${moneyUsd(cfg.planUsd, cfg.currency, cfg.cnyRate)}/月，本月回本 ${paybackText(m.monthUsd / cfg.planUsd, 'zh')}`
                  : `Plan ${moneyUsd(cfg.planUsd, cfg.currency, cfg.cnyRate)}/month, ${paybackText(m.monthUsd / cfg.planUsd, 'en')} paid back this month`
                : zh
                  ? '未设置订阅。用法：/taxi plan 200（每月美元）'
                  : 'No plan set. Usage: /taxi plan 200 (USD a month)',
          }
        }
        const usd = arg === 'off' ? 0 : Number(arg.replace(/^\$/, ''))
        if (!Number.isFinite(usd) || usd < 0) {
          return { text: zh ? '用法：/taxi plan 200 或 /taxi plan off' : 'Usage: /taxi plan 200 or /taxi plan off' }
        }
        await $.config.set({ key: 'taxi-meter.planUsd', value: usd })
        if (usd === 0) return { text: zh ? '已关闭回本模式' : 'Payback mode off' }
        const x = paybackText(m.monthUsd / usd, cfg.lang)
        return {
          text: zh
            ? `订阅设为 $${usd}/月：本月的用量已回本 ${x}`
            : `Plan set to $${usd}/month: this month's usage has paid back ${x}`,
        }
      }
      case 'share': {
        const text = shareCard(await figures($))
        const copied = await $.ui.copy({ text })
        const note = copied.isCopied
          ? zh ? '（已复制到剪贴板）' : '(copied to your clipboard)'
          : zh ? '（没能复制，请手动选中上面的文字）' : "(couldn't copy: select the text above)"
        return { text: `${text}\n\n${note}` }
      }
      case 'demo': {
        if (m.demo) return { text: zh ? '演示已经在跑了' : 'A demo ride is already running' }
        if (phase() !== 'idle') {
          return { text: zh ? '计价器正在载客，等 Claude 这轮结束后再演示' : 'The meter is busy: run the demo once Claude finishes this turn' }
        }
        await startDemo($)
        return {
          text: zh
            ? '🎬 演示行程开始：约 14 秒，不计费、不记录，结束后计价器恢复原样'
            : '🎬 Demo ride started: about 14 seconds, nothing billed or recorded, and the meter goes back to normal after',
        }
      }
      case 'hide':
        await setHidden($, true)
        return { text: zh ? '状态栏计价器已隐藏（/taxi show 恢复）' : 'Status line meter hidden (/taxi show to bring it back)' }
      case 'show':
        await setHidden($, false)
        return { text: zh ? '状态栏计价器已显示' : 'Status line meter shown' }
      default:
        return { text: HELP[cfg.lang].join('\n') }
    }
  })

  // The receipt as a card: the plain text stays what the model reads.
  on('ui.render', { component: 'CommandOutput', props: { command: 'taxi' } }, async ($, e, next) => {
    if (e.props.isErrored || !e.props.text.startsWith('🧾')) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const lines = e.props.text.split('\n')

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#f5c518" paddingX={1} alignSelf="flex-start">
        {lines.map((line, i) =>
          i === 0 ? (
            <Text bold color="#f5c518">
              {line}
            </Text>
          ) : line.startsWith('─') ? (
            <Text dimColor>{line}</Text>
          ) : /^(TOTAL|实收金额)/.test(line) ? (
            <Text bold>{line}</Text>
          ) : line.startsWith('≈') || i === lines.length - 1 ? (
            <Text dimColor italic>
              {line}
            </Text>
          ) : (
            <Text>{line}</Text>
          ),
        )}
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    m.isPaneOpen = false
    if (e.origin.kind !== 'unload') await update($, isPaneOpen, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = PANE_WORDS[cfg.lang]
    const now = await read($, live)
    const limit = await read($, budget)
    const hidden = await read($, isHidden)
    const rides = await read($, trips)
    const points = await read($, history)
    const cols = Math.max(20, e.props.bodyColumns)

    const fare = money(now.units, cfg.currency)
    const digits = bigDigits(fare)
    const isBig = digits !== null && digits[0]!.length <= cols
    const pct = budgetPct({ units: now.units, budget: limit > 0 ? units(limit) : null })
    const lamp =
      now.phase === 'idle'
        ? { text: cfg.lang === 'zh' ? '空车' : 'FOR HIRE', color: 'green' }
        : now.phase === 'waiting'
          ? { text: cfg.lang === 'zh' ? '等候 ⏳' : 'WAITING ⏳', color: 'yellow' }
          : { text: `${cfg.lang === 'zh' ? '载客' : 'HIRED'} ${now.isLit ? '●' : '○'}`, color: 'red' }
    const drumColor = pct !== null && pct >= 100 ? 'red' : '#f5c518'

    const barWidth = Math.max(8, Math.min(30, cols - 24))
    const filled = pct === null ? 0 : Math.min(barWidth, Math.round((pct / 100) * barWidth))
    const spend = spendBuckets(points, await $.clock.now(), Math.max(10, Math.min(30, cols - 16)), 60000)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={lamp.color}>
            {lamp.text}
          </Text>
          <Text dimColor>{w.brand}</Text>
        </Box>
        {isBig ? (
          <Box flexDirection="column" marginY={1}>
            {digits.map(row => (
              <Text color={drumColor} bold>
                {row}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={drumColor} bold>
            {fare}
          </Text>
        )}
        <Text>
          {now.trip !== null && now.trip > 0
            ? `${now.phase === 'idle' ? w.last : w.ride} ${money(now.trip, cfg.currency)}`
            : ' '}
          {now.flash > 0 ? `  ▲${(now.flash / 100).toFixed(2)}` : ''}
        </Text>
        {now.phase !== 'idle' && (
          <Text dimColor>
            {w.time} {duration(now.rideMs)}
            {now.rate >= 1 ? `  ·  ${w.rate} ${money(Math.round(now.rate), cfg.currency)}/min` : ''}
            {now.tool ? `  ·  ${now.tool}` : ''}
          </Text>
        )}
        <Text>
          {pct === null ? (
            <Text dimColor>{w.noBudget}</Text>
          ) : (
            <Text color={pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : 'green'}>
              {w.budget} {'█'.repeat(filled)}
              {'░'.repeat(barWidth - filled)} {pct}% / {moneyUsd(limit, cfg.currency, cfg.cnyRate)}
            </Text>
          )}
        </Text>
        {cfg.planUsd > 0 && (
          <Text>
            <Text dimColor>{w.payback} </Text>
            <Text color="cyan" bold>
              💎 {paybackText(payback() ?? 0, cfg.lang)}
            </Text>
            <Text dimColor>
              {'  '}
              {moneyUsd(m.monthUsd, cfg.currency, cfg.cnyRate)} / {moneyUsd(cfg.planUsd, cfg.currency, cfg.cnyRate)}
            </Text>
          </Text>
        )}
        <Text>
          <Text dimColor>{w.spend} </Text>
          <Text color="#f5c518">{sparkline(spend)}</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{w.recent}</Text>
          {rides.length === 0 && <Text dimColor>{w.none}</Text>}
          {rides
            .slice(-4)
            .reverse()
            .map(t => (
              <Text wrap="truncate-end">
                {moneyUsd(t.fare, cfg.currency, cfg.cnyRate).padStart(8)} {t.prompt}
              </Text>
            ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} gap={1}>
          <Button key="receipt" hotkey="r" label={w.receipt} onPress={() => $.command.run({ command: 'taxi' })} />
          <Button
            key="currency"
            hotkey="c"
            label={w.currency}
            onPress={() =>
              $.config.set({ key: 'taxi-meter.currency', value: cfg.currency === 'USD' ? 'CNY' : 'USD' })
            }
          />
          <Button key="budget" hotkey="b" label={w.addBudget} onPress={() => setBudget($, Math.max(0, limit) + 5)} />
          {limit > 0 && <Button key="nobudget" hotkey="n" label={w.clearBudget} onPress={() => setBudget($, 0)} />}
          <Button key="hide" hotkey="h" label={hidden ? w.show : w.hide} onPress={() => setHidden($, !hidden)} />
          <Button key="close" role="dismiss" label={w.close} onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
