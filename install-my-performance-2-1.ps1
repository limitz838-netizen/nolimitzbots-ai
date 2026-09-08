# ==========================================================================
#  NolimitzBots - My Performance 2.1
#   * headline suppressed below 200 trades, with a provisional notice instead
#   * balance projection reads in days / weeks / months, not sessions
#   * table rows renamed to fix a CSS collision with the distribution rows
#
#      powershell -ExecutionPolicy Bypass -File .\install-my-performance-2-1.ps1
#
#  Flags:  -SkipBuild   -NoPush
# ==========================================================================
param([switch]$SkipBuild, [switch]$NoPush)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "  FAILED: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Info($msg) { Write-Host $msg -ForegroundColor Cyan }

try { $root = (git rev-parse --show-toplevel).Trim() } catch { Fail 'Not inside a git repository.' }
Set-Location $root
if (-not (Test-Path 'src/components/shared/nlb/history-analytics.ts')) { Fail 'Step 2 not installed. Run install-my-performance-2 first.' }
Info "Repo: $root"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

$analyticsSrc = @'
// @ts-nocheck -- Analysis over the stored trade history.
//
// Nothing here predicts anything. Every number is a description of what the
// account already did, cut in ways Deriv's own reports do not offer.
//
// The two that matter most:
//   * cost per hour - what trading at this pace actually costs, which turns an
//     abstract loss into a rate the user can compare against their income
//   * behaviour after losses - almost every losing account raises its stake
//     after a losing run, and almost nobody knows they do it

import { rowOf } from './history-store';

const SESSION_GAP_S = 30 * 60; // a half-hour gap starts a new session

const summariseGroup = trades => {
    let profit = 0;
    let staked = 0;
    let wins = 0;
    trades.forEach(t => {
        profit += t.profit;
        staked += t.buy;
        if (t.profit > 0) wins += 1;
    });
    return {
        n: trades.length,
        profit: Number(profit.toFixed(2)),
        staked: Number(staked.toFixed(2)),
        wins,
        win_rate: trades.length ? wins / trades.length : 0,
        avg_stake: trades.length ? staked / trades.length : 0,
        cost_rate: staked ? -profit / staked : 0,
    };
};

export const decode = state => (state.rows || []).map(rowOf).sort((a, b) => a.buy_time - b.buy_time);

const groupBy = (trades, keyFn) => {
    const buckets = new Map();
    trades.forEach(t => {
        const k = keyFn(t);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(t);
    });
    return [...buckets.entries()]
        .map(([key, rows]) => ({ key, ...summariseGroup(rows) }))
        .sort((a, b) => b.n - a.n);
};

export const byMarket = trades => groupBy(trades, t => t.symbol);
export const byType = trades => groupBy(trades, t => t.type);
export const byWeekday = trades =>
    groupBy(trades, t => new Date(t.buy_time * 1000).getDay()).sort((a, b) => a.key - b.key);
export const byHour = trades =>
    groupBy(trades, t => new Date(t.buy_time * 1000).getHours()).sort((a, b) => a.key - b.key);

export const byStake = trades =>
    groupBy(trades, t => {
        const s = t.buy;
        if (s < 1) return 'under 1';
        if (s < 2) return '1 to 2';
        if (s < 5) return '2 to 5';
        if (s < 10) return '5 to 10';
        if (s < 25) return '10 to 25';
        return '25 and up';
    });

/** Split the trade list into sessions separated by a gap of inactivity. */
export const sessions = trades => {
    const out = [];
    let current = null;
    trades.forEach(t => {
        if (!current || t.buy_time - current.end > SESSION_GAP_S) {
            current = { start: t.buy_time, end: t.buy_time, trades: [t] };
            out.push(current);
        } else {
            current.end = t.buy_time;
            current.trades.push(t);
        }
    });
    return out.map(s => ({
        start: s.start,
        end: s.end,
        // A single-trade session still consumed real time; floor it at a minute.
        seconds: Math.max(60, s.end - s.start),
        ...summariseGroup(s.trades),
    }));
};

/**
 * What this account's trading costs per hour of actual screen time, and how
 * long a given balance survives at that rate.
 */
export const pace = (trades, balance) => {
    const list = sessions(trades);
    const seconds = list.reduce((sum, s) => sum + s.seconds, 0);
    const hours = seconds / 3600;
    const totals = summariseGroup(trades);

    // Calendar days the history spans, so screen time can be expressed as a
    // daily habit rather than an abstract block of hours.
    const span_days = trades.length
        ? Math.max(1, (trades[trades.length - 1].buy_time - trades[0].buy_time) / 86400)
        : 1;
    const hours_per_day = hours / span_days;

    const trades_per_hour = hours ? trades.length / hours : 0;
    const cost_per_hour = hours ? -totals.profit / hours : 0;
    const hours_left = cost_per_hour > 0 && balance > 0 ? balance / cost_per_hour : null;
    const days_left = hours_left !== null && hours_per_day > 0 ? hours_left / hours_per_day : null;

    return {
        sessions: list.length,
        hours: Number(hours.toFixed(2)),
        span_days: Number(span_days.toFixed(1)),
        hours_per_day: Number(hours_per_day.toFixed(2)),
        trades_per_hour: Number(trades_per_hour.toFixed(1)),
        cost_per_hour: Number(cost_per_hour.toFixed(2)),
        cost_per_day: Number((cost_per_hour * hours_per_day).toFixed(2)),
        hours_left: hours_left === null ? null : Number(hours_left.toFixed(1)),
        days_left: days_left === null ? null : Number(days_left.toFixed(1)),
        avg_session_minutes: list.length ? Math.round(seconds / list.length / 60) : 0,
        longest_session_minutes: list.length ? Math.round(Math.max(...list.map(s => s.seconds)) / 60) : 0,
    };
};

/** Turn a day count into something a person reads without doing arithmetic. */
export const humanDuration = days => {
    if (days === null || !Number.isFinite(days)) return null;
    if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
    if (days < 14) return `${Math.round(days)} days`;
    if (days < 70) return `${Math.round(days / 7)} weeks`;
    if (days < 730) return `${Math.round(days / 30)} months`;
    return `${(days / 365).toFixed(1)} years`;
};

/**
 * Group every trade by how many losses came immediately before it. The stake
 * column is the point: if it climbs with the loss count, the account is
 * chasing, and that is a behaviour the user can change today.
 */
export const afterLosses = trades => {
    const buckets = { 0: [], 1: [], 2: [], '3+': [] };
    let run = 0;
    trades.forEach(t => {
        const key = run === 0 ? 0 : run === 1 ? 1 : run === 2 ? 2 : '3+';
        buckets[key].push(t);
        run = t.profit > 0 ? 0 : run + 1;
    });

    const base = summariseGroup(buckets[0]);
    return Object.entries(buckets).map(([key, rows]) => {
        const s = summariseGroup(rows);
        return {
            key,
            ...s,
            // How much bigger the stake is than after a win, as a multiple.
            stake_ratio: base.avg_stake && s.avg_stake ? s.avg_stake / base.avg_stake : 1,
        };
    });
};

/** The single sentence worth putting at the top of the page. */
export const MIN_FOR_HEADLINE = 200;

export const headline = (trades, paceStats) => {
    if (trades.length < MIN_FOR_HEADLINE) return '';
    const chase = afterLosses(trades).find(b => b.key === '3+');
    const totals = summariseGroup(trades);

    const parts = [];
    if (paceStats.cost_per_hour > 0) {
        parts.push(`Trading at this pace costs about ${paceStats.cost_per_hour.toFixed(2)} an hour.`);
    } else if (totals.profit > 0) {
        parts.push(`You are up ${totals.profit.toFixed(2)} over this history, which is unusual - check it is not one large win carrying everything.`);
    }
    if (chase && chase.n >= 20 && chase.stake_ratio > 1.25) {
        parts.push(
            `After three or more losses in a row your average stake is ${chase.stake_ratio.toFixed(1)}x bigger than after a win, across ${chase.n} trades.`
        );
    }
    return parts.join(' ');
};
'@

$pageSrc = @'
// @ts-nocheck -- My Performance (step 2: analysis).
//
// Everything on this page describes trades that already happened. There is no
// prediction and no recommendation dressed up as one.
import React from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { clear, load, overview, rowOf, sync } from '@/components/shared/nlb/history-store';
import {
    afterLosses,
    byHour,
    byMarket,
    byStake,
    byType,
    byWeekday,
    decode,
    headline,
    humanDuration,
    MIN_FOR_HEADLINE,
    pace,
} from '@/components/shared/nlb/history-analytics';
import './my-performance.scss';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = [
    { key: 'market', label: 'Market' },
    { key: 'type', label: 'Contract' },
    { key: 'stake', label: 'Stake size' },
    { key: 'hour', label: 'Hour of day' },
    { key: 'weekday', label: 'Day of week' },
];

const money = (v, currency) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)} ${currency}`;
const dateOf = epoch => (epoch ? new Date(epoch * 1000).toLocaleString('en-GB') : '-');

const MyPerformance = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();

    const [state, setState] = React.useState(() => load(activeLoginid || 'none'));
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [error, setError] = React.useState('');
    const [view, setView] = React.useState('market');
    const [balance, setBalance] = React.useState(0);

    const account = React.useMemo(
        () => (accountList || []).find(a => a.loginid === activeLoginid),
        [accountList, activeLoginid]
    );
    const currency = account?.currency || 'USD';

    React.useEffect(() => {
        setState(load(activeLoginid || 'none'));
        setError('');
        setProgress(null);
    }, [activeLoginid]);

    React.useEffect(() => {
        const b = Number(account?.balance);
        if (b > 0) setBalance(b);
    }, [account]);

    const run = async full => {
        if (!activeLoginid || busy) return;
        setBusy(true);
        setError('');
        setProgress({ pages: 0, fetched: 0, added: 0 });
        try {
            const next = await sync(activeLoginid, { full, onProgress: setProgress });
            setState(next);
            if (next.stored === false) {
                setError('Loaded, but browser storage is full so this will not persist.');
            }
        } catch (e) {
            setError(e?.message || 'Could not reach Deriv. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const stats = React.useMemo(() => overview(state), [state]);
    const trades = React.useMemo(() => decode(state), [state]);
    const paceStats = React.useMemo(() => pace(trades, Number(balance) || 0), [trades, balance]);
    const chase = React.useMemo(() => afterLosses(trades), [trades]);
    const lede = React.useMemo(() => headline(trades, paceStats), [trades, paceStats]);
    const recent = React.useMemo(() => (state.rows || []).slice(0, 15).map(rowOf), [state]);

    const groups = React.useMemo(() => {
        if (!trades.length) return [];
        if (view === 'market') return byMarket(trades);
        if (view === 'type') return byType(trades);
        if (view === 'stake') return byStake(trades);
        if (view === 'hour') return byHour(trades).map(g => ({ ...g, key: `${String(g.key).padStart(2, '0')}:00` }));
        return byWeekday(trades).map(g => ({ ...g, key: DAY_NAMES[g.key] }));
    }, [trades, view]);

    const worst = Math.max(1, ...groups.map(g => Math.abs(g.profit)));
    const provisional = trades.length < MIN_FOR_HEADLINE;

    if (!isAuthorized) {
        return (
            <div className='my-performance'>
                <div className='my-performance__panel'>
                    <div className='my-performance__title'>MY PERFORMANCE</div>
                    <div className='my-performance__note'>Sign in to your Deriv account to load your trade history.</div>
                </div>
            </div>
        );
    }

    return (
        <div className='my-performance'>
            <div className='my-performance__panel'>
                <div className='my-performance__head'>
                    <div>
                        <div className='my-performance__title'>MY PERFORMANCE</div>
                        <div className='my-performance__subtitle'>
                            Your own closed trades from Deriv, analysed on this device.
                        </div>
                    </div>
                    <div className='my-performance__account'>{activeLoginid}</div>
                </div>

                {error && <div className='my-performance__warn'>{error}</div>}

                <div className='my-performance__actions'>
                    <button type='button' className='my-performance__primary' disabled={busy} onClick={() => run(false)}>
                        {busy ? 'Loading...' : state.synced_at ? 'Sync new trades' : 'Load my history'}
                    </button>
                    <button type='button' className='my-performance__link' disabled={busy} onClick={() => run(true)}>
                        Full resync
                    </button>
                    <button
                        type='button'
                        className='my-performance__link'
                        disabled={busy}
                        onClick={() => setState(clear(activeLoginid))}
                    >
                        Delete stored data
                    </button>
                </div>

                {busy && progress && (
                    <div className='my-performance__progress'>
                        Page {progress.pages}, {progress.fetched} trades scanned, {progress.added} new
                    </div>
                )}

                {stats.n === 0 && !busy && (
                    <div className='my-performance__note'>
                        Nothing loaded yet. Press Load my history - the first pull can take up to a minute, then future
                        syncs only fetch what is new.
                    </div>
                )}

                {stats.n > 0 && (
                    <>
                        {lede && <div className='my-performance__lede'>{lede}</div>}
                        {provisional && (
                            <div className='my-performance__building'>
                                {trades.length} of {MIN_FOR_HEADLINE} trades. The rates below are computed from what
                                is here, but a short history swings wildly - especially if your stake changes after
                                losses, where one sequence can dominate the whole sample. Treat them as provisional
                                until this fills up.
                            </div>
                        )}

                        <div className='my-performance__readout'>
                            <div className='my-performance__stat'>
                                <span>Trades</span>
                                <strong>{stats.n}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Win rate</span>
                                <strong>{(stats.win_rate * 100).toFixed(1)}%</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Total staked</span>
                                <strong>
                                    {stats.staked.toFixed(2)} {currency}
                                </strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Net profit / loss</span>
                                <strong className={stats.profit >= 0 ? 'pos' : 'neg'}>
                                    {money(stats.profit, currency)}
                                </strong>
                            </div>
                        </div>

                        <div className='my-performance__headline'>
                            You staked {stats.staked.toFixed(2)} {currency} across {stats.n} trades and kept{' '}
                            {money(stats.profit, currency)}. That is{' '}
                            <strong>{(stats.cost_rate * 100).toFixed(2)}%</strong> of everything you staked, over{' '}
                            {stats.days} day{stats.days === 1 ? '' : 's'}.
                        </div>

                        <div className='my-performance__meta'>
                            Oldest {dateOf(stats.oldest)} &middot; newest {dateOf(stats.newest)} &middot; synced{' '}
                            {state.synced_at ? new Date(state.synced_at).toLocaleString('en-GB') : 'never'}
                            {state.truncated ? ' - older trades beyond the storage cap were dropped' : ''}
                        </div>

                        {/* ------------------------------- pace ------------------------------- */}
                        <div className='my-performance__section-title'>
                            What your pace costs
                            {provisional && <span className='my-performance__flag'>provisional</span>}
                        </div>
                        <div className='my-performance__readout'>
                            <div className='my-performance__stat'>
                                <span>Cost per hour</span>
                                <strong className={paceStats.cost_per_hour > 0 ? 'neg' : 'pos'}>
                                    {paceStats.cost_per_hour.toFixed(2)} {currency}
                                </strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Trades per hour</span>
                                <strong>{paceStats.trades_per_hour}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Sessions</span>
                                <strong>{paceStats.sessions}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Avg session</span>
                                <strong>{paceStats.avg_session_minutes} min</strong>
                            </div>
                        </div>

                        <div className='my-performance__balance'>
                            <label className='my-performance__field'>
                                <span>Balance to project from</span>
                                <input
                                    type='number'
                                    min='0'
                                    step='1'
                                    value={balance}
                                    onChange={e => setBalance(Number(e.target.value) || 0)}
                                />
                            </label>
                            <div className='my-performance__projection'>
                                {paceStats.hours_left === null ? (
                                    <>Enter a balance to see how long it lasts at this rate.</>
                                ) : (
                                    <>
                                        You trade about {paceStats.hours_per_day.toFixed(1)} hours a day, which costs{' '}
                                        {paceStats.cost_per_day.toFixed(2)} {currency} a day. At that rate a balance of{' '}
                                        {Number(balance).toFixed(2)} lasts roughly{' '}
                                        <strong>{humanDuration(paceStats.days_left)}</strong>. Trading half as fast
                                        roughly doubles it.
                                    </>
                                )}
                            </div>
                        </div>

                        {/* --------------------------- after losses --------------------------- */}
                        <div className='my-performance__section-title'>What you do after losses</div>
                        <div className='my-performance__table'>
                            <div className='my-performance__trow head five'>
                                <span>Losses before</span>
                                <span>Trades</span>
                                <span>Avg stake</span>
                                <span>Win rate</span>
                                <span>P/L</span>
                            </div>
                            {chase.map(b => (
                                <div key={b.key} className={`my-performance__trow five ${b.profit >= 0 ? 'win' : 'loss'}`}>
                                    <span>{b.key}</span>
                                    <span>{b.n}</span>
                                    <span>
                                        {b.avg_stake.toFixed(2)}
                                        {b.stake_ratio > 1.1 ? ` (${b.stake_ratio.toFixed(1)}x)` : ''}
                                    </span>
                                    <span>{(b.win_rate * 100).toFixed(1)}%</span>
                                    <span>
                                        {b.profit >= 0 ? '+' : ''}
                                        {b.profit.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className='my-performance__note-inline'>
                            Win rate should be roughly the same across every row - the market has no memory of your
                            losing run. If the stake column climbs, that is you, and it is the one thing on this page
                            you can change today.
                        </div>

                        {/* ---------------------------- breakdowns ---------------------------- */}
                        <div className='my-performance__section-title'>Breakdown</div>
                        <div className='my-performance__tabs'>
                            {VIEWS.map(v => (
                                <button
                                    key={v.key}
                                    type='button'
                                    className={`my-performance__tab ${view === v.key ? 'on' : ''}`}
                                    onClick={() => setView(v.key)}
                                >
                                    {v.label}
                                </button>
                            ))}
                        </div>
                        <div className='my-performance__bars'>
                            {groups.map(g => (
                                <div key={g.key} className='my-performance__bar-row'>
                                    <span className='my-performance__bar-label'>{g.key}</span>
                                    <span className='my-performance__bar-track'>
                                        <span
                                            className={g.profit >= 0 ? 'pos' : 'neg'}
                                            style={{ width: `${(Math.abs(g.profit) / worst) * 100}%` }}
                                        />
                                    </span>
                                    <span className='my-performance__bar-value'>
                                        <strong className={g.profit >= 0 ? 'pos' : 'neg'}>
                                            {g.profit >= 0 ? '+' : ''}
                                            {g.profit.toFixed(2)}
                                        </strong>
                                        <em>
                                            {g.n} trades, {(g.win_rate * 100).toFixed(0)}% win
                                        </em>
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* ------------------------------ recent ------------------------------ */}
                        <div className='my-performance__section-title'>Most recent trades</div>
                        <div className='my-performance__table'>
                            <div className='my-performance__trow head'>
                                <span>Bought</span>
                                <span>Market</span>
                                <span>Type</span>
                                <span>Stake</span>
                                <span>P/L</span>
                            </div>
                            {recent.map(t => (
                                <div key={t.id} className={`my-performance__trow ${t.profit > 0 ? 'win' : 'loss'}`}>
                                    <span>{dateOf(t.buy_time)}</span>
                                    <span>{t.symbol}</span>
                                    <span>{t.type}</span>
                                    <span>{t.buy.toFixed(2)}</span>
                                    <span>
                                        {t.profit >= 0 ? '+' : ''}
                                        {t.profit.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                <div className='my-performance__note'>
                    This data stays on this device - read from your Deriv account, written to your browser, never to a
                    server. Deleting it here removes the local copy only.
                </div>
            </div>
        </div>
    );
};

export default MyPerformance;
'@

$stylesSrc = @'
.my-performance {
    height: var(--tab-content-height);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 1.6rem 1.6rem 14rem;
    background: radial-gradient(1200px 500px at 85% -10%, rgba(212, 175, 55, 0.12), transparent 60%),
        linear-gradient(180deg, #0a0e17 0%, #0c1120 55%, #0a0e17 100%);

    &__panel {
        max-width: 640px;
        margin: 0 auto;
        padding: 1.8rem;
        border-radius: 1.6rem;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(212, 175, 55, 0.28);
    }

    &__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
    }

    &__title {
        color: #e8cf7a;
        font-size: 2rem;
        font-weight: 800;
        letter-spacing: 0.04em;
    }

    &__subtitle {
        color: #9aa1b0;
        font-size: 1.2rem;
        margin: 0.4rem 0 1.4rem;
    }

    &__status {
        flex-shrink: 0;
        font-size: 1.1rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 0.5rem 0.9rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;

        &--live {
            color: #34d399;
            border-color: rgba(52, 211, 153, 0.4);
        }

        &--reconnecting,
        &--connecting {
            color: #fbbf24;
            border-color: rgba(245, 158, 11, 0.4);
        }

        &--disconnected {
            color: #f87171;
            border-color: rgba(248, 113, 113, 0.4);
        }
    }

    &__dot {
        width: 0.8rem;
        height: 0.8rem;
        border-radius: 50%;
        background: currentColor;
    }

    &__warn {
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.4);
        color: #fbbf24;
        border-radius: 1rem;
        padding: 1rem;
        font-size: 1.2rem;
        margin-bottom: 1.2rem;
    }

    &__controls {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 1.4rem;
    }

    &__field {
        flex: 1 1 200px;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;

        span {
            color: #9aa1b0;
            font-size: 1.1rem;
        }

        select,
        input {
            background: rgba(10, 14, 23, 0.9);
            border: 1px solid rgba(212, 175, 55, 0.3);
            color: #e8eaf0;
            border-radius: 0.8rem;
            padding: 0.9rem 1rem;
            font-size: 1.3rem;
        }
    }

    &__readout {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.8rem;
        margin-bottom: 1.6rem;

        @media (max-width: 600px) {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    &__stat {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 1rem;
        padding: 0.9rem;
        text-align: center;

        span {
            display: block;
            color: #9aa1b0;
            font-size: 1rem;
            margin-bottom: 0.3rem;
        }

        strong {
            color: #e8eaf0;
            font-size: 1.6rem;
            font-weight: 700;
        }
    }

    &__digit {
        color: #e8cf7a !important;
        font-size: 2.4rem !important;
    }

    &__section-title {
        color: #e8cf7a;
        font-size: 1.2rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        margin: 1.6rem 0 0.8rem;
    }

    &__dist {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    &__row {
        display: flex;
        align-items: center;
        gap: 0.8rem;
    }

    &__row-digit {
        width: 1.6rem;
        color: #e8eaf0;
        font-size: 1.3rem;
        font-weight: 700;
        text-align: center;
    }

    &__bar {
        flex: 1;
        height: 1.2rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 999px;
        overflow: hidden;

        span {
            display: block;
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(212, 175, 55, 0.5), #e8cf7a);
            transition: width 0.25s ease;
        }
    }

    &__row-pct {
        width: 4.6rem;
        text-align: right;
        color: #cbd5e1;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__recent {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    &__chip {
        min-width: 2.4rem;
        text-align: center;
        padding: 0.4rem 0.5rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #e8eaf0;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__muted {
        color: #6b7280;
        font-size: 1.2rem;
    }

    &__diag {
        margin-top: 1.6rem;
        padding: 0.8rem 1rem;
        border-radius: 0.8rem;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #7c8698;
        font-family: monospace;
        font-size: 1rem;
        line-height: 1.5;
        word-break: break-word;
    }

    &__signal {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1.2rem;
        padding: 1.4rem;
        border-radius: 1.2rem;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.1);

        &--strong { border-color: rgba(52, 211, 153, 0.55); }
        &--medium { border-color: rgba(212, 175, 55, 0.55); }
        &--weak { border-color: rgba(245, 158, 11, 0.45); }
        &--no-signal { border-color: rgba(148, 163, 184, 0.3); }
    }

    &__signal-main {
        display: flex;
        align-items: center;
        gap: 1.2rem;
    }

    &__signal-digit {
        width: 6rem;
        height: 6rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 1.2rem;
        background: rgba(212, 175, 55, 0.12);
        border: 1px solid rgba(212, 175, 55, 0.35);
        color: #e8cf7a;
        font-size: 3.2rem;
        font-weight: 800;
    }

    &__signal-quality {
        color: #e8eaf0;
        font-size: 1.6rem;
        font-weight: 800;
        letter-spacing: 0.05em;
    }

    &__signal-sub {
        color: #9aa1b0;
        font-size: 1.1rem;
        margin-top: 0.3rem;
    }

    &__signal-nums {
        display: flex;
        gap: 1.6rem;

        span {
            display: block;
            color: #9aa1b0;
            font-size: 1rem;
        }

        strong {
            color: #e8eaf0;
            font-size: 1.5rem;
        }
    }

    &__link {
        margin-top: 0.8rem;
        background: none;
        border: none;
        color: #e8cf7a;
        font-size: 1.2rem;
        text-decoration: underline;
        cursor: pointer;
        padding: 0;
    }

    &__why {
        margin-top: 0.8rem;
        padding: 1.2rem;
        border-radius: 1rem;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #cbd5e1;
        font-size: 1.2rem;
        line-height: 1.55;

        table { width: 100%; margin: 1rem 0; border-collapse: collapse; }
        td { padding: 0.35rem 0; font-size: 1.15rem; }
        td.pos { color: #34d399; text-align: right; font-variant-numeric: tabular-nums; }
        td.neg { color: #f87171; text-align: right; font-variant-numeric: tabular-nums; }
        td.note { color: #6b7280; text-align: right; font-size: 1rem; padding-left: 1rem; }
    }

    &__why-foot {
        color: #7c8698;
        font-size: 1.05rem;
    }

    &__reset {
        float: right;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #cbd5e1;
        border-radius: 0.6rem;
        padding: 0.3rem 0.9rem;
        font-size: 1rem;
        cursor: pointer;
        text-transform: none;
        letter-spacing: 0;
    }

    &__verdict {
        padding: 0.9rem 1.1rem;
        border-radius: 0.9rem;
        background: rgba(148, 163, 184, 0.1);
        border: 1px solid rgba(148, 163, 184, 0.25);
        color: #cbd5e1;
        font-size: 1.2rem;
        line-height: 1.5;
    }

    &__mini {
        margin-top: 0.7rem;
        color: #9aa1b0;
        font-size: 1.1rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
    }

    &__tag {
        padding: 0.2rem 0.7rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    &__feed {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-family: monospace;
        font-size: 1.1rem;
    }

    &__feed-row {
        display: grid;
        grid-template-columns: auto auto auto 1fr auto;
        gap: 0.8rem;
        padding: 0.45rem 0.8rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.03);
        color: #9aa1b0;

        &.hit { color: #34d399; background: rgba(52, 211, 153, 0.08); }
        &.miss { color: #8b93a3; }
    }

    &__row-digit.is-predicted {
        color: #e8cf7a;
    }

    &__locks {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-bottom: 1.2rem;
    }

    &__lock {
        padding: 0.4rem 0.9rem;
        border-radius: 999px;
        font-size: 1.1rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);

        &.ok { color: #34d399; border-color: rgba(52, 211, 153, 0.4); }
        &.bad { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
    }

    &__limits {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.9rem;
        margin-bottom: 1.4rem;

        @media (max-width: 600px) {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    &__field--wide {
        margin-bottom: 1.2rem;
        max-width: 34rem;
    }

    &__trade-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1.4rem;
    }

    &__auto {
        flex: 0 0 auto;
        padding: 1rem 1.8rem;
        border-radius: 1rem;
        border: 1px solid rgba(212, 175, 55, 0.5);
        background: linear-gradient(180deg, rgba(212, 175, 55, 0.25), rgba(212, 175, 55, 0.12));
        color: #e8cf7a;
        font-size: 1.3rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        cursor: pointer;

        &.on {
            border-color: rgba(248, 113, 113, 0.6);
            background: linear-gradient(180deg, rgba(248, 113, 113, 0.25), rgba(248, 113, 113, 0.12));
            color: #fca5a5;
        }

        &:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
    }

    &__gate {
        flex: 1 1 200px;
        color: #9aa1b0;
        font-size: 1.15rem;
        line-height: 1.45;

        &.ok { color: #34d399; }
    }

    &__trades {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-family: monospace;
        font-size: 1.1rem;
        margin-top: 1rem;
    }

    &__trade-row {
        display: grid;
        grid-template-columns: 1.4fr 0.6fr 1fr 1fr 1fr;
        gap: 0.6rem;
        padding: 0.45rem 0.8rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.03);
        color: #9aa1b0;

        &.head { color: #6b7280; background: none; }
        &.win { color: #34d399; background: rgba(52, 211, 153, 0.08); }
        &.loss { color: #8b93a3; }

        span:not(:first-child) { text-align: right; }
    }

    &__stat strong.pos { color: #34d399; }
    &__stat strong.neg { color: #f87171; }

    &__grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.9rem;
        margin-bottom: 1.4rem;

        @media (max-width: 600px) {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    &__rule-line {
        font-family: monospace;
        font-size: 1.15rem;
        color: #cbd5e1;
        padding: 0.8rem 1rem;
        border-radius: 0.8rem;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.08);
    }

    &__account {
        flex-shrink: 0;
        font-family: monospace;
        font-size: 1.2rem;
        color: #e8cf7a;
        padding: 0.4rem 0.9rem;
        border-radius: 999px;
        border: 1px solid rgba(212, 175, 55, 0.35);
        background: rgba(212, 175, 55, 0.1);
    }

    &__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 1rem;
        margin: 1.4rem 0;
    }

    &__primary {
        padding: 1rem 1.8rem;
        border-radius: 1rem;
        border: 1px solid rgba(212, 175, 55, 0.5);
        background: linear-gradient(180deg, rgba(212, 175, 55, 0.25), rgba(212, 175, 55, 0.12));
        color: #e8cf7a;
        font-size: 1.3rem;
        font-weight: 800;
        cursor: pointer;

        &:disabled { opacity: 0.4; cursor: not-allowed; }
    }

    &__progress {
        font-family: monospace;
        font-size: 1.15rem;
        color: #9aa1b0;
        margin-bottom: 1.2rem;
    }

    &__headline {
        padding: 1.1rem 1.2rem;
        border-radius: 1rem;
        background: rgba(148, 163, 184, 0.1);
        border: 1px solid rgba(148, 163, 184, 0.25);
        color: #cbd5e1;
        font-size: 1.25rem;
        line-height: 1.55;

        strong { color: #e8cf7a; }
    }

    &__meta {
        margin-top: 0.7rem;
        color: #7c8698;
        font-size: 1.05rem;
    }

    &__table {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-family: monospace;
        font-size: 1.1rem;
    }

    &__trow {
        display: grid;
        grid-template-columns: 1.8fr 1fr 1.2fr 0.9fr 0.9fr;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.8rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.03);
        color: #9aa1b0;
        line-height: 1.4;

        &.head { color: #6b7280; background: none; }
        &.win { color: #34d399; background: rgba(52, 211, 153, 0.08); }
        &.loss { color: #8b93a3; }

        span {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        span:not(:first-child) { text-align: right; }

        &.five {
            grid-template-columns: 1.3fr 0.7fr 1.3fr 1fr 1fr;
        }
    }

    &__lede {
        padding: 1.2rem 1.3rem;
        border-radius: 1.1rem;
        background: rgba(212, 175, 55, 0.1);
        border: 1px solid rgba(212, 175, 55, 0.35);
        color: #e8cf7a;
        font-size: 1.4rem;
        line-height: 1.5;
        margin-bottom: 1.4rem;
    }

    &__balance {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 1.2rem;
        margin-top: 1rem;
    }

    &__projection {
        flex: 1 1 260px;
        color: #cbd5e1;
        font-size: 1.2rem;
        line-height: 1.55;

        strong { color: #e8cf7a; }
    }

    &__note-inline {
        margin-top: 0.8rem;
        color: #9aa1b0;
        font-size: 1.15rem;
        line-height: 1.5;
    }

    &__tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-bottom: 1rem;
    }

    &__tab {
        padding: 0.5rem 1.1rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: #9aa1b0;
        font-size: 1.15rem;
        cursor: pointer;

        &.on {
            color: #e8cf7a;
            border-color: rgba(212, 175, 55, 0.5);
            background: rgba(212, 175, 55, 0.12);
        }
    }

    &__bars {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    &__bar-row {
        display: grid;
        grid-template-columns: 8rem 1fr 11rem;
        align-items: center;
        gap: 0.8rem;

        @media (max-width: 600px) {
            grid-template-columns: 6rem 1fr 9rem;
        }
    }

    &__bar-label {
        color: #cbd5e1;
        font-size: 1.15rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &__bar-track {
        height: 1.4rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 999px;
        overflow: hidden;

        span {
            display: block;
            height: 100%;
            border-radius: 999px;
            transition: width 0.25s ease;

            &.pos { background: linear-gradient(90deg, rgba(52, 211, 153, 0.5), #34d399); }
            &.neg { background: linear-gradient(90deg, rgba(248, 113, 113, 0.45), #f87171); }
        }
    }

    &__bar-value {
        text-align: right;
        font-variant-numeric: tabular-nums;

        strong {
            display: block;
            font-size: 1.2rem;

            &.pos { color: #34d399; }
            &.neg { color: #f87171; }
        }

        em {
            display: block;
            font-style: normal;
            color: #6b7280;
            font-size: 1rem;
        }
    }

    &__building {
        padding: 1rem 1.2rem;
        border-radius: 1rem;
        background: rgba(245, 158, 11, 0.1);
        border: 1px solid rgba(245, 158, 11, 0.3);
        color: #fbbf24;
        font-size: 1.2rem;
        line-height: 1.55;
        margin-bottom: 1.4rem;
    }

    &__flag {
        margin-left: 0.8rem;
        padding: 0.15rem 0.7rem;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.15);
        border: 1px solid rgba(245, 158, 11, 0.35);
        color: #fbbf24;
        font-size: 0.95rem;
        text-transform: none;
        letter-spacing: 0;
        font-weight: 600;
    }

    &__note {
        margin-top: 1.8rem;
        padding: 1rem;
        border-radius: 1rem;
        background: rgba(148, 163, 184, 0.08);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: #9aa1b0;
        font-size: 1.1rem;
        line-height: 1.5;
    }
}
'@

Info ''
Info '[1/3] Writing files'
Write-File 'src/components/shared/nlb/history-analytics.ts' $analyticsSrc
Write-File 'src/pages/my-performance/my-performance.tsx'    $pageSrc
Write-File 'src/pages/my-performance/my-performance.scss'   $stylesSrc

$ErrorActionPreference = 'Continue'

Info ''
if ($SkipBuild) { Info '[2/3] Build skipped' } else {
    Info '[2/3] Running npm run build (a few minutes)'
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host ''; Fail 'Build failed. Nothing committed.' }
    Ok 'build succeeded'
}

Info ''
Info '[3/3] Commit and push'
git add -A
git commit -m "My Performance 2.1: sample-size gating, readable projections, table CSS fix"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }
if ($NoPush) { Info 'Push skipped.' } else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}
Write-Host ''
Write-Host 'Done. Hard refresh once Vercel is green.' -ForegroundColor Yellow
