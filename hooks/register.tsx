import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionMeasureInput,
  SessionRateLimit,
  TurnCompleteInput,
} from 'claude-code'

import type { BandSettings, Cost, Entry, Ledger, Limit, Limits } from '../types'

// The gap between monitors, in `ch`.
const GAP = 4

// A hidden monitor shows again only once it fits HYSTERESIS columns narrower,
// so a width resting on a threshold cannot flip it on every redraw.
const HYSTERESIS = 3

// The cost monitors hidden first when the band is narrow.
const HIDE_FIRST = ['Active Time', 'Input Tokens']
let hidden = 0

// Bar lengths in `ch` and the bar height in pixels. The bars shrink to BAR_MIN
// first; past that, Context hides.
const BAR_MAX = 10
const BAR_MIN = 4
const BAR_H = 8
let hidesContext = false

type Cell = { label: string; value: string }

type Level = 'white' | 'yellow' | 'red'

type Row = { label: string; percent: number | null; detail: string }

const FILL = { white: '#f2f2f2', yellow: '#f5c542', red: '#f0524f' } as const

const cost = atom({ plugin: 'usage-bands', key: 'cost' } as const, null)
const limits = atom({ plugin: 'usage-bands', key: 'limits' } as const, null)
const settings = atom({ plugin: 'usage-bands', key: 'settings' } as const, null)

const EMPTY: Entry = { usd: 0, input: 0, output: 0, activeMs: 0 }

const DEFAULTS: BandSettings = {
  showCost: true,
  showLimits: true,
  hide: [],
  yellowAt: 60,
  redAt: 80,
}

// Fills the 5 HR and Weekly windows before the first response, whose headers carry them.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const WINDOWS = ['five_hour', 'seven_day'] as const
let accountLimits: Limit[] = []
let hasFetched = false

// The repository folder: the parent of the mod folder.
function repoOf($: EngineInterface): string {
  return $.plugin.root.replace(/[\\/][^\\/]+[\\/]?$/, '')
}

// One ledger in `<repo>/data` for every session of every project.
function ledgerPath($: EngineInterface): string {
  return repoOf($) + '/data/apiUsageLedger.json'
}

// Outside the mod folder, so an edit does not reload the mod.
function settingsPath($: EngineInterface): string {
  return repoOf($) + '/userConfig/usageBandsSettings.json'
}

// A field missing or of the wrong type takes its default.
function settingsOf(raw: unknown): BandSettings {
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
    Record<keyof BandSettings, unknown>
  >
  const { showCost, showLimits, hide, yellowAt, redAt } = given

  return {
    showCost: typeof showCost === 'boolean' ? showCost : DEFAULTS.showCost,
    showLimits: typeof showLimits === 'boolean' ? showLimits : DEFAULTS.showLimits,
    hide: Array.isArray(hide)
      ? hide.filter((label): label is string => typeof label === 'string')
      : DEFAULTS.hide,
    yellowAt: typeof yellowAt === 'number' ? yellowAt : DEFAULTS.yellowAt,
    redAt: typeof redAt === 'number' ? redAt : DEFAULTS.redAt,
  }
}

// A missing file is written with the defaults so every option is visible. A
// file that does not parse is left as is, so a typo never erases the user's edits.
async function readSettings($: EngineInterface): Promise<BandSettings> {
  const path = settingsPath($)

  if (!(await $.fs.exists(path))) {
    await $.fs.write(path, JSON.stringify(DEFAULTS, null, 2) + '\n')

    return DEFAULTS
  }

  try {
    return settingsOf(JSON.parse(await $.fs.read(path)))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    $.ui.log(`settings file unreadable, using defaults: ${reason}`, { to: 'debug' })

    return DEFAULTS
  }
}

async function readLedger($: EngineInterface): Promise<Ledger> {
  const path = ledgerPath($)

  if (!(await $.fs.exists(path))) return {}

  return JSON.parse(await $.fs.read(path)) as Ledger
}

// This session's cost is live; the ledger holds every other session's last cost.
function costOf(ledger: Ledger, id: string, usd: number | undefined): Cost {
  const entry = ledger[id] ?? EMPTY
  let totalUsd = usd ?? entry.usd

  for (const [other, { usd: spent }] of Object.entries(ledger)) {
    if (other !== id) totalUsd += spent
  }

  return {
    sessionUsd: usd ?? null,
    totalUsd,
    input: entry.input,
    output: entry.output,
    activeMs: entry.activeMs,
  }
}

function toLimits(
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  estimate?: number,
): Limits {
  const own: Limit[] = rateLimits.map(limit => ({
    kind: limit.kind,
    percentUsed: limit.percentUsed,
  }))

  for (const limit of accountLimits) {
    if (!own.some(mine => mine.kind === limit.kind)) own.push(limit)
  }

  if (context.percent === undefined && estimate !== undefined) {
    return {
      tokens: estimate,
      window: context.window,
      percent: (estimate / context.window) * 100,
      isEstimated: true,
      limits: own,
    }
  }

  return {
    tokens: context.tokens ?? null,
    window: context.window,
    percent: context.percent ?? null,
    isEstimated: false,
    limits: own,
  }
}

// Before the first response or after a compaction the window has no fill; count it locally.
async function limitsOf(
  $: EngineInterface,
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
): Promise<Limits> {
  if (context.percent !== undefined) return toLimits(context, rateLimits)

  const counted = await $.session.usage({ breakdown: 'summary' })

  return toLimits(context, rateLimits, counted.context.breakdown?.totalTokens)
}

async function fetchAccountLimits($: EngineInterface) {
  const auth = await $.session.authorize()

  // API keys and third-party providers have no subscription windows.
  if (auth?.kind !== 'bearer') return

  const response = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })

  if (!response.ok) {
    throw new Error(`usage-bands: GET ${USAGE_URL} answered ${response.status}`)
  }

  const body = JSON.parse(response.text) as Record<string, unknown>

  accountLimits = WINDOWS.flatMap(kind => {
    const window = body[kind] as { utilization?: unknown } | null | undefined

    if (typeof window?.utilization !== 'number') return []

    return [{ kind, percentUsed: window.utilization }]
  })
  await refresh($)
}

const lastWritten = { cost: '', limits: '', settings: '' }

// Whether `value` differs from what was last written under `key`.
function changed(
  key: keyof typeof lastWritten,
  value: Cost | Limits | BandSettings,
): boolean {
  const json = JSON.stringify(value)

  if (json === lastWritten[key]) return false
  lastWritten[key] = json

  return true
}

async function storeCost($: EngineInterface, snap: Cost) {
  if (!changed('cost', snap)) return
  await update($, cost, () => snap)
  $.ui.invalidate('ui.render')
}

async function storeLimits($: EngineInterface, snap: Limits) {
  if (!changed('limits', snap)) return
  await update($, limits, () => snap)
  $.ui.invalidate('ui.render')
}

async function storeSettings($: EngineInterface, chosen: BandSettings) {
  if (!changed('settings', chosen)) return
  await update($, settings, () => chosen)
  $.ui.invalidate('ui.render')
}

let queue: Promise<void> = Promise.resolve()

function serial(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)

  return run
}

// `measured` is what session.measure carries; without it both rows read the session.
function refresh(
  $: EngineInterface,
  measured?: Pick<SessionMeasureInput, 'context' | 'rateLimits'>,
) {
  return serial(async () => {
    const usage = await $.session.usage()
    const { context, rateLimits } = measured ?? usage
    const hasWindows = WINDOWS.every(kind =>
      rateLimits.some(limit => limit.kind === kind),
    )

    // Once per load, not awaited, so the band draws while the request runs.
    if (!hasWindows && !hasFetched) {
      hasFetched = true
      fetchAccountLimits($).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)

        $.ui.log(`account limits lookup failed: ${reason}`, { to: 'debug' })
      })
    }

    const id = await $.session.id()

    await storeSettings($, await readSettings($))
    await storeLimits($, await limitsOf($, context, rateLimits))
    await storeCost($, costOf(await readLedger($), id, usage.cost?.usd))
  })
}

// Subagent turns add tokens but not time: they run inside a main-loop turn.
// ponytail: no file lock; two sessions ending a turn at once can drop one write.
function record($: EngineInterface, e: TurnCompleteInput) {
  return serial(async () => {
    const id = await $.session.id()
    const usage = await $.session.usage()
    const ledger = await readLedger($)
    const prev = ledger[id] ?? EMPTY

    ledger[id] = {
      usd: usage.cost?.usd ?? prev.usd,
      input: prev.input + (e.usage?.input_tokens ?? 0),
      output: prev.output + (e.usage?.output_tokens ?? 0),
      activeMs: prev.activeMs + (e.agentId === undefined ? e.durationMs : 0),
    }
    await $.fs.write(ledgerPath($), JSON.stringify(ledger, null, 2) + '\n')
    await storeCost($, costOf(ledger, id, usage.cost?.usd))
  })
}

function usdOf(usd: number | null): string {
  return usd === null ? 'n/a' : '$' + usd.toFixed(2)
}

function tokensOf(count: number): string {
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M'
  if (count >= 1000) return Math.round(count / 1000) + 'k'
  return String(count)
}

function timeOf(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function levelOf(percent: number, chosen: BandSettings): Level {
  if (percent >= chosen.redAt) return 'red'
  if (percent >= chosen.yellowAt) return 'yellow'
  return 'white'
}

function clamp(percent: number): number {
  return Math.min(100, Math.max(0, percent))
}

// No viewBox, so the pill stretches to any bar length with round ends.
function pillOf(percent: number | null, chosen: BandSettings): string {
  const p = clamp(percent ?? 0)
  const level = levelOf(p, chosen)
  const radius = BAR_H / 2
  const fill =
    p === 0
      ? ''
      : `<rect class="f ${level}" height="${BAR_H}" rx="${radius}" fill="${FILL[level]}" style="width:max(${BAR_H}px,${p}%)"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAR_H}">` +
    '<style>@media (prefers-color-scheme: light){.f.white{fill:#2b2b2b}}</style>' +
    `<rect width="100%" height="${BAR_H}" rx="${radius}" fill="#808080" fill-opacity="0.35"/>` +
    fill +
    '</svg>'
  )
}

// ponytail: Desktop text is proportional, so widths are estimated per character
// at footnote size, with 1 ch spare; a misjudged width clips the last monitor
// rather than wrapping it.
function widthOf(text: string): number {
  return [...text].reduce(
    (sum, c) => sum + (/\d/.test(c) ? 1 : /[%MWmw]/.test(c) ? 1.5 : 0.8),
    0,
  )
}

function fits(cells: Cell[], columns: number): boolean {
  const text = cells.reduce(
    (sum, cell) => sum + widthOf(cell.label) + widthOf(cell.value) + 1,
    0,
  )

  return text + GAP * (cells.length - 1) <= columns - 1
}

function without(cells: Cell[], count: number): Cell[] {
  return cells.filter(cell => !HIDE_FIRST.slice(0, count).includes(cell.label))
}

// How many of HIDE_FIRST must go for `cells` to fit `columns`.
function hidesFor(cells: Cell[], columns: number): number {
  let count = 0

  while (count < HIDE_FIRST.length && !fits(without(cells, count), columns)) {
    count += 1
  }

  return count
}

function cellsOf(snap: Cost): Cell[] {
  return [
    { label: 'Session Cost', value: usdOf(snap.sessionUsd) },
    { label: 'Total Cost', value: usdOf(snap.totalUsd) },
    { label: 'Input Tokens', value: tokensOf(snap.input) },
    { label: 'Output Tokens', value: tokensOf(snap.output) },
    { label: 'Active Time', value: timeOf(snap.activeMs) },
  ]
}

// The bar length that fits `rows` into `columns`.
function barOf(rows: Row[], columns: number): number {
  const text = rows.reduce(
    (sum, row) => sum + widthOf(row.label) + widthOf(row.detail) + 2,
    0,
  )

  return (columns - 1 - text - GAP * (rows.length - 1)) / rows.length
}

function rowsOf(snap: Limits): Row[] {
  const five = snap.limits.find(limit => limit.kind === 'five_hour')
  const week = snap.limits.find(limit => limit.kind === 'seven_day')
  const window = tokensOf(snap.window)
  const about = snap.isEstimated ? '~' : ''
  const context =
    snap.percent === null
      ? `n/a / ${window}`
      : snap.tokens === null
        ? `${about}${Math.round(snap.percent)}%`
        : `${about}${Math.round(snap.percent)}% (${tokensOf(snap.tokens)} / ${window})`

  return [
    {
      label: '5 HR',
      percent: five?.percentUsed ?? null,
      detail: five ? `${Math.round(five.percentUsed)}%` : 'n/a',
    },
    {
      label: 'Weekly',
      percent: week?.percentUsed ?? null,
      detail: week ? `${Math.round(week.percentUsed)}%` : 'n/a',
    },
    { label: 'Context', percent: snap.percent, detail: context },
  ]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and do not fire session.start again.
  on(
    'classic.SessionStart',
    { source: ['clear', 'resume', 'fork'] },
    async ($, e, next) => {
      await refresh($)

      return next(e)
    },
  ).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await refresh($, e)

    return next(e)
  })

  // Picks up settings edits made since the last reply.
  on('prompt.submit', ($, e, next) => {
    void refresh($)

    return next(e)
  })

  // A main-loop tool call means a response just arrived; refresh mid-turn.
  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) void refresh($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    void refresh($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await record($, e)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const chosen = (await read($, settings)) ?? DEFAULTS
    const spent = chosen.showCost ? await read($, cost) : null
    const used =
      chosen.showLimits && e.surface === 'desktop' ? await read($, limits) : null
    const shown = (label: string) => !chosen.hide.includes(label)
    const listed = spent === null ? [] : cellsOf(spent).filter(cell => shown(cell.label))
    const all = used === null ? [] : rowsOf(used).filter(row => shown(row.label))
    const columns = e.props.bodyColumns

    if (listed.length > 0) {
      hidden = Math.max(
        hidesFor(listed, columns),
        Math.min(hidden, hidesFor(listed, columns - HYSTERESIS)),
      )
    }

    const cells = without(listed, hidden)

    if (all.length > 0) {
      hidesContext =
        barOf(all, columns) < BAR_MIN ||
        (hidesContext && barOf(all, columns - HYSTERESIS) < BAR_MIN)
    }

    const rows = hidesContext ? all.filter(row => row.label !== 'Context') : all

    if (cells.length === 0 && rows.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const bands = theirs ? [theirs] : []

    if (cells.length > 0) {
      // One body line high: a monitor that would wrap is clipped instead.
      bands.push(
        <Box
          flexDirection="row"
          flexWrap="wrap"
          alignItems="center"
          justifyContent="center"
          columnGap={GAP}
          width="100%"
          height={1}
          overflow="hidden"
        >
          {cells.map(cell => (
            <Box
              flexDirection="row"
              alignItems="center"
              flexShrink={0}
              columnGap={1}
              height={1}
            >
              <Text size="footnote" weight="semibold">
                {cell.label}
              </Text>
              <Text size="footnote" tabular dimColor>
                {cell.value}
              </Text>
            </Box>
          ))}
        </Box>,
      )
    }

    if (e.surface === 'desktop' && rows.length > 0) {
      const { Svg } = $.ui.resolve(e)

      // The outer Box centers and clips to one line. The inner row is flat so
      // only the bars shrink, all by the same amount, as the window is resized.
      bands.push(
        <Box
          flexDirection="row"
          alignItems="center"
          justifyContent="center"
          width="100%"
          height={1}
          overflow="hidden"
        >
          <Box
            flexDirection="row"
            alignItems="center"
            flexShrink={1}
            minWidth={0}
            columnGap={1}
          >
            {rows.flatMap((row, i) => [
              <Box flexShrink={0} marginLeft={i === 0 ? 0 : GAP - 1}>
                <Text size="footnote" weight="semibold">
                  {row.label}
                </Text>
              </Box>,
              // Desktop caps an Svg at its slot, so the widest width fills the bar's Box.
              <Box width={BAR_MAX} minWidth={BAR_MIN}>
                <Svg
                  source={pillOf(row.percent, chosen)}
                  alt={`${row.label} ${row.detail}`}
                  width={4096}
                  height={BAR_H}
                />
              </Box>,
              <Box flexShrink={0}>
                <Text size="footnote" tabular dimColor>
                  {row.detail}
                </Text>
              </Box>,
            ])}
          </Box>
        </Box>,
      )
    }

    return <Box flexDirection="column">{bands}</Box>
  })
}
