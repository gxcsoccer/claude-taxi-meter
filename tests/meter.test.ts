import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  bigDigits,
  costOf,
  face,
  milestoneAt,
  money,
  paybackAt,
  paybackText,
  priceOf,
  receipt,
  rollStep,
  shareCard,
  sparkline,
  toUnits,
} from '../hooks/meter'

describe('the arithmetic', () => {
  test('prices models by family', async () => {
    expect(priceOf('claude-opus-5-5[1m]')).toEqual({ input: 4, output: 20 })
    expect(priceOf('claude-fable-5-1')).toEqual({ input: 10, output: 50 })
    expect(priceOf('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 })
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 })
  })

  test('costs a response from its four counts', async () => {
    const usd = costOf('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    })
    // 4 + 2 + 0.4
    expect(Math.round(usd * 100) / 100).toBe(6.4)
  })

  test('rolls a big jump over a few ticks, a small one at once', async () => {
    expect(rollStep(0)).toBe(0)
    expect(rollStep(1)).toBe(1)
    expect(rollStep(30)).toBe(8)
    expect(toUnits(2.479, 'USD', 7.1)).toBe(247)
    expect(money(1754, 'CNY')).toBe('¥17.54')
    expect(milestoneAt(0.3)).toBe(0)
    expect(milestoneAt(5.01)).toBe(5)
  })

  test('draws the face', async () => {
    const hired = face(
      { phase: 'hired', units: 247, flash: 3, trip: 31, rate: 42, tool: null, isLit: true, budget: null },
      'zh',
      'USD',
    )
    expect(hired).toBe('🚖 载客●   $2.47 ▲0.03 · 本程 $0.31 · 🔥$0.42/分')
    const idle = face({ phase: 'idle', units: 247, flash: 0, trip: 31, rate: 0, tool: null, isLit: false, budget: null }, 'en', 'USD')
    expect(idle).toBe('🚕 FOR HIRE   $2.47 · last $0.31')
    const base = { phase: 'idle', flash: 0, trip: null, rate: 0, tool: null, isLit: true } as const
    expect(face({ ...base, units: 200, budget: 500 }, 'en', 'USD')).toContain('budget 40%')
    expect(face({ ...base, units: 420, budget: 500 }, 'en', 'USD')).toContain('⚠️ budget 84%')
    expect(face({ ...base, units: 520, budget: 500 }, 'en', 'USD')).toContain('🛑 OVER BUDGET')
  })

  test('draws big digits and a sparkline', async () => {
    const rows = bigDigits('$2.47')!
    expect(rows.length).toBe(3)
    expect(new Set(rows.map(r => r.length)).size).toBe(1)
    expect(bigDigits('$a')).toBe(null)
    expect(sparkline([0, 1, 2, 4])).toBe('▁▃▅█')
  })

  test('prints a receipt', async () => {
    const text = receipt({
      lang: 'zh',
      currency: 'USD',
      cnyRate: 7.1,
      ledger: 2.47,
      trips: [{ fare: 0.81, ms: 40000, at: 0, prompt: '帮我重构', model: 'claude-opus-5-5', jumps: 12 }],
      jumps: 40,
      startedAt: 0,
      now: 600000,
      lifetime: 183.2,
      model: 'claude-opus-5-5',
    })
    expect(text).toContain('实收金额  $2.47')
    expect(text).toContain('最贵')
    expect(text).toContain('帮我重构')
    expect(text).toContain('$183.20')
  })
})

/** The world beneath the plugin: a ledger we move by hand, and every status line it pins. */
function world(on: On, ledger: { usd: number }, statuses: string[], toasts: string[], hasStore = true) {
  if (hasStore) mock.store(on)
  on('ui.status', ($, e) => {
    statuses.push(e.text ?? '(hidden)')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: ledger.usd } },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.close', ($, e) => ({ value: undefined }))
}

const run = (args: string) =>
  ({ command: 'taxi', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never

const copied: string[] = []

const drum = (s: string) => Number(/[$¥]\s*(\d+\.\d\d)/.exec(s)?.[1] ?? NaN)

test('the meter ticks up while the model streams and lands on the ledger', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ledger = { usd: 1.2 }
  const statuses: string[] = []
  const toasts: string[] = []
  world(on, ledger, statuses, toasts)
  on('turn.step', async function* () {
    // 20k characters of answer: about 5k output tokens, $0.10 on Opus 5.5
    for (let i = 0; i < 10; i++) {
      yield { kind: 'text', index: 0, text: 'x'.repeat(2000) }
      await clock.sleep(200)
    }
    yield {
      kind: 'stop',
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2000,
        output_tokens: 5000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
      },
    }
    return {
      turnId: 't1',
      index: 0,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await clock.settle()
  expect(statuses.at(-1)).toContain('$1.20')
  expect(statuses.at(-1)).toContain('FOR HIRE')

  await $.turn.start({ text: 'refactor the parser please', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const reading = (async () => {
    for await (const _ of stream) void _
  })()
  for (let i = 0; i < 12; i++) await clock.advance(200)
  await reading

  const mid = statuses.filter(s => s.includes('HIRED') && !s.includes('FOR HIRE')).map(drum)
  expect(mid.length).toBeGreaterThan(3)
  // never backwards
  for (let i = 1; i < mid.length; i++) expect(mid[i]!).toBeGreaterThanOrEqual(mid[i - 1]!)

  // The ledger lands: 2000*4 + 5000*20 + 100000*0.4 = $0.148 more
  ledger.usd = 1.348
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [],
    cost: { usd: ledger.usd },
    changed: ['cost'],
  })
  await $.turn.complete({ answer: 'x', durationMs: 2400, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5000)

  const last = statuses.at(-1)!
  expect(last).toContain('FOR HIRE')
  expect(drum(last)).toBe(1.34)
  expect(last).toContain('last $0.14')
  // crossed no milestone between $1.20 and $1.34
  expect(toasts.filter(t => t.includes('Ka-ching'))).toEqual([])

  const out = await $.command.run(run(''))
  expect(out.text).toContain('TOTAL  $1.34')
  expect(out.text).toContain('refactor the parser')
  expect(out.text).toContain('claude-opus-5-5')
  // the lifetime odometer opens with the whole session, not just what the mod saw
  expect(out.text).toContain('$1.34 (all sessions)')

  const card = await $.ui.mount({
    plugin: 'taxi-meter',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'taxi', args: '', text: out.text!, isErrored: false } as never,
  })
  expect(await card.find({ type: 'Text', text: /^TOTAL/ })).toBeDefined()
  await card.unmount()
})

test('a reload does not count the session twice toward lifetime', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { seenBySession: { 'session-1': 2 }, lifetimeUsd: 10 })
  const ledger = { usd: 2.5 }
  world(on, ledger, [], [], false)

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await clock.advance(500)
  expect((await $.command.run(run(''))).text).toContain('$10.50 (all sessions)')
})

test('a milestone rings once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ledger = { usd: 0.9 }
  const statuses: string[] = []
  const toasts: string[] = []
  world(on, ledger, statuses, toasts)

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  ledger.usd = 1.05
  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 1.05 }, changed: ['cost'] })
  await clock.advance(3000)
  ledger.usd = 1.1
  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 1.1 }, changed: ['cost'] })
  await clock.advance(3000)

  expect(toasts.filter(t => t.includes('$1.00')).length).toBe(1)
  expect(drum(statuses.at(-1)!)).toBe(1.1)
})

test('a budget warns at 80% and 100%, and the meter can hide', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ledger = { usd: 0.3 }
  const statuses: string[] = []
  const toasts: string[] = []
  world(on, ledger, statuses, toasts)

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  expect((await $.command.run(run('budget 0.5'))).text).toContain('$0.50')
  await clock.advance(500)
  expect(statuses.at(-1)).toContain('budget 60%')

  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 0.42 }, changed: ['cost'] })
  await clock.advance(3000)
  expect(statuses.at(-1)).toContain('⚠️ budget 84%')
  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 0.55 }, changed: ['cost'] })
  await clock.advance(3000)
  expect(statuses.at(-1)).toContain('OVER BUDGET')
  expect(toasts.filter(t => t.includes('budget')).length).toBe(2)

  await $.command.run(run('hide'))
  expect(statuses.at(-1)).toBe('(hidden)')
  await $.command.run(run('show'))
  expect(statuses.at(-1)).toContain('FOR HIRE')
  expect((await $.command.run(run('what'))).text).toContain('/taxi budget 5')
})

test('the meter pane draws and its buttons work', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ledger = { usd: 2.47 }
  world(on, ledger, [], [])

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await $.command.run(run('meter'))
  await clock.advance(500)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'taxi-meter',
      surface,
      component: 'Pane',
      requestId: 'taxi-meter',
      props: { title: 'Meter', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /FOR HIRE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no budget/ })).toBeDefined()
    await ui.press({ key: 'budget' })
    expect(await ui.find({ type: 'Text', text: /49% \/ \$5\.00/ })).toBeDefined()
    await ui.press({ key: 'nobudget' })
    expect(await ui.find({ type: 'Text', text: /no budget/ })).toBeDefined()
    await ui.unmount()
  }
})

test('payback reads as a percentage, then a multiple', async () => {
  expect(paybackText(0.47, 'en')).toBe('47%')
  expect(paybackText(3.27, 'en')).toBe('3.2×')
  expect(paybackText(3.27, 'zh')).toBe('3.2 倍')
  expect(paybackText(12.9, 'en')).toBe('12×')
  expect(paybackAt(0.9)).toBe(0)
  expect(paybackAt(3.4)).toBe(3)
  const base = { phase: 'idle', units: 100, flash: 0, trip: null, rate: 0, tool: null, isLit: true, budget: null } as const
  expect(face({ ...base, payback: 3.27 }, 'en', 'USD')).toContain('💎 3.2× plan')
  expect(face({ ...base, payback: 0.5 }, 'zh', 'USD')).toContain('💎 回本 50%')
})

test('the share card brags, and links back', async () => {
  const text = shareCard({
    lang: 'en',
    currency: 'USD',
    cnyRate: 7.1,
    ledger: 7.74,
    trips: [{ fare: 1.55, ms: 1000, at: 0, prompt: 'make it go viral', model: 'm', jumps: 9 }],
    jumps: 123,
    startedAt: 0,
    now: 34 * 60000,
    lifetime: 100,
    model: 'm',
    monthUsd: 640,
    planUsd: 200,
  })
  expect(text).toContain('$7.74')
  expect(text).toContain('3.2× paid back')
  expect(text).toContain('make it go viral')
  expect(text).toContain('github.com/gxcsoccer/claude-taxi-meter')
})

test('a plan shows payback in the status line and rings at 1×', { options: { planUsd: 10 } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 6) })
  mock.store(on, { seenBySession: {}, lifetimeUsd: 0, monthUsd: { '2026-10': 9 } })
  const ledger = { usd: 0 }
  const statuses: string[] = []
  const toasts: string[] = []
  world(on, ledger, statuses, toasts, false)

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await clock.advance(500)
  expect(statuses.at(-1)).toContain('💎 90% plan')

  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 1.5 }, changed: ['cost'] })
  await clock.advance(3000)
  expect(statuses.at(-1)).toContain('💎 1.0× plan')
  expect(toasts.filter(t => t.includes('Paid back')).length).toBe(1)

  copied.length = 0
  const out = await $.command.run(run('share'))
  expect(out.text).toContain('copied to your clipboard')
  expect(copied[0]).toContain('1.0× paid back')
})

test('the demo plays every beat, then leaves no trace', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ledger = { usd: 7.74 }
  const statuses: string[] = []
  const toasts: string[] = []
  world(on, ledger, statuses, toasts)

  await $.session.start({ cwd: '/tmp', source: 'startup' } as never)
  await clock.advance(500)
  expect((await $.command.run(run('demo'))).text).toContain('Demo ride started')
  expect((await $.command.run(run('demo'))).text).toContain('already running')

  for (let i = 0; i < 160; i++) await clock.advance(100)

  expect(statuses.some(s => s.includes('HIRED●') || s.includes('HIRED○'))).toBe(true)
  expect(statuses.some(s => s.includes('WAITING') && s.includes('Bash'))).toBe(true)
  // $7.74 rolls past $10: one ka-ching, and the ride's receipt toast
  expect(toasts.filter(t => t.includes('Ka-ching') && t.includes('$10.00')).length).toBe(1)
  expect(toasts.some(t => t.includes('That ride'))).toBe(true)
  expect(Math.max(...statuses.map(drum))).toBeGreaterThanOrEqual(10)

  // and then it is as if it never happened
  expect(drum(statuses.at(-1)!)).toBe(7.74)
  expect(statuses.at(-1)).not.toContain('last')
  const receiptText = (await $.command.run(run(''))).text!
  expect(receiptText).toContain('Rides     0 · 0 jumps')
  expect(receiptText).toContain('TOTAL  $7.74')

  // the real crossing of $10 still rings later
  toasts.length = 0
  await $.session.measure({ context: { window: 1 }, rateLimits: [], cost: { usd: 10.2 }, changed: ['cost'] })
  await clock.advance(3000)
  expect(toasts.filter(t => t.includes('$10.00')).length).toBe(1)
})
