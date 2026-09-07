# ==========================================================================
#  NolimitzBots - My Performance (step 1: history data layer)
#  Pulls the signed-in account's closed trades from Deriv profit_table,
#  stores them locally, and syncs incrementally after the first pull.
#
#  Registers its tab whether or not Digit Bots is installed.
#
#      powershell -ExecutionPolicy Bypass -File .\install-my-performance.ps1
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
if (-not (Test-Path 'src/pages/matches-pro/matches-pro.tsx')) { Fail 'Matches Pro not installed. Run the Phase 1 installer first.' }
Info "Repo: $root"

if (Test-Path 'src/pages/digit-bots/digit-bots.tsx') {
    Info 'Digit Bots detected - inserting My Performance after it.'
} else {
    Info 'Digit Bots not installed - inserting My Performance after Matches Pro.'
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:pending = @{}

function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

function Get-Text($relPath) {
    $full = Join-Path $root $relPath
    if (-not (Test-Path $full)) { Fail "missing file $relPath" }
    if (-not $script:pending.ContainsKey($relPath)) {
        $raw = [System.IO.File]::ReadAllText($full)
        $script:pending[$relPath] = @{ Crlf = $raw.Contains("`r`n"); Text = $raw.Replace("`r`n", "`n") }
    }
    return $script:pending[$relPath]
}

# Two candidate anchors: A for a repo with Digit Bots, B for one without.
# Applies whichever matches exactly once, so one installer fits either layout.
function Stage-PatchAny($relPath, $oldA, $newA, $oldB, $newB, $marker, $label) {
    $entry = Get-Text $relPath
    if ($marker -and $entry.Text.Contains($marker)) { Ok "$label already applied"; return }

    $oA = $oldA.Replace("`r`n", "`n")
    if (([regex]::Matches($entry.Text, [regex]::Escape($oA))).Count -eq 1) {
        $entry.Text = $entry.Text.Replace($oA, $newA.Replace("`r`n", "`n"))
        Ok "patched $label"
        return
    }

    $oB = $oldB.Replace("`r`n", "`n")
    if (([regex]::Matches($entry.Text, [regex]::Escape($oB))).Count -eq 1) {
        $entry.Text = $entry.Text.Replace($oB, $newB.Replace("`r`n", "`n"))
        Ok "patched $label"
        return
    }

    Fail "$label - no anchor matched in $relPath. Nothing changed."
}

function Commit-Patches {
    foreach ($rel in @($script:pending.Keys)) {
        $entry = $script:pending[$rel]
        $out = $entry.Text
        if ($entry.Crlf) { $out = $out.Replace("`n", "`r`n") }
        [System.IO.File]::WriteAllText((Join-Path $root $rel), $out, $utf8NoBom)
    }
}

$storeSrc = @'
// @ts-nocheck -- Deriv trade history store.
//
// Pulls the account's closed trades from profit_table, normalises them, and
// keeps them locally so the analysis can run instantly on later visits instead
// of re-downloading everything.
//
// Sync is incremental: after the first pull we only ask for trades newer than
// the newest one we already hold.
//
// Rows are stored as fixed-order arrays rather than objects. At a few thousand
// trades the key names would otherwise be most of the payload.

import { api_base } from '@/external/bot-skeleton';

const KEY = loginid => `nlb_history_v1_${loginid}`;
const PAGE = 500; // profit_table maximum per request
const MAX_PAGES = 12; // 6000 trades is plenty for personal analysis
const MAX_ROWS = 6000;
const PAGE_DELAY_MS = 350; // stay well clear of the API rate limit

const sleep = ms => new Promise(r => setTimeout(r, ms));

// [purchase_time, sell_time, symbol, contract_type, buy_price, sell_price, contract_id]
const IDX = { BUY_T: 0, SELL_T: 1, SYMBOL: 2, TYPE: 3, BUY: 4, SELL: 5, ID: 6 };

export const rowOf = r => ({
    buy_time: r[IDX.BUY_T],
    sell_time: r[IDX.SELL_T],
    symbol: r[IDX.SYMBOL],
    type: r[IDX.TYPE],
    buy: r[IDX.BUY],
    sell: r[IDX.SELL],
    id: r[IDX.ID],
    profit: Number((r[IDX.SELL] - r[IDX.BUY]).toFixed(4)),
    duration: r[IDX.SELL_T] && r[IDX.BUY_T] ? r[IDX.SELL_T] - r[IDX.BUY_T] : null,
});

// Shortcodes look like DIGITMATCH_R_100_9.3_... or CALL_R_50_19.53_...
// contract_type is present on newer responses; fall back to the shortcode.
const typeOf = tx => {
    if (tx.contract_type) return tx.contract_type;
    const code = tx.shortcode || '';
    const first = code.split('_')[0];
    return first || 'UNKNOWN';
};

const symbolOf = tx => {
    if (tx.underlying_symbol) return tx.underlying_symbol;
    if (tx.symbol) return tx.symbol;
    const parts = (tx.shortcode || '').split('_');
    // DIGITMATCH_R_100_... -> R_100 ; CALL_1HZ100V_... -> 1HZ100V
    if (parts.length >= 3 && parts[1] === 'R') return `${parts[1]}_${parts[2]}`;
    return parts[1] || 'UNKNOWN';
};

const normalise = tx => [
    Number(tx.purchase_time) || 0,
    Number(tx.sell_time) || 0,
    symbolOf(tx),
    typeOf(tx),
    Number(tx.buy_price) || 0,
    Number(tx.sell_price) || 0,
    String(tx.contract_id || tx.transaction_id || ''),
];

const empty = () => ({ rows: [], synced_at: null, newest: 0, truncated: false });

export const load = loginid => {
    try {
        const raw = window.localStorage.getItem(KEY(loginid));
        if (!raw) return empty();
        return { ...empty(), ...JSON.parse(raw) };
    } catch {
        return empty();
    }
};

const save = (loginid, state) => {
    try {
        window.localStorage.setItem(KEY(loginid), JSON.stringify(state));
        return true;
    } catch {
        return false; // quota - the data still works for this session
    }
};

export const clear = loginid => {
    try {
        window.localStorage.removeItem(KEY(loginid));
    } catch {
        /* noop */
    }
    return empty();
};

/**
 * Fetch trades from Deriv and merge them into the stored set.
 *
 * sync(loginid, { onProgress, full })
 *   full: ignore the incremental cursor and re-pull everything
 *
 * Returns the merged state. Throws with a readable message on API failure.
 */
export const sync = async (loginid, options = {}) => {
    const { onProgress, full = false } = options;
    const existing = full ? empty() : load(loginid);
    const seen = new Set(existing.rows.map(r => r[IDX.ID]));
    const collected = [];

    let offset = 0;
    let pages = 0;

    while (pages < MAX_PAGES) {
        const request = {
            profit_table: 1,
            description: 1,
            limit: PAGE,
            offset,
            sort: 'DESC',
        };
        // Incremental: only ask for trades bought after the newest one held.
        if (!full && existing.newest) request.date_from = existing.newest;

        const response = await api_base.api.send(request);
        const transactions = response?.profit_table?.transactions || [];
        if (!transactions.length) break;

        let fresh = 0;
        transactions.forEach(tx => {
            const row = normalise(tx);
            if (!row[IDX.ID] || seen.has(row[IDX.ID])) return;
            seen.add(row[IDX.ID]);
            collected.push(row);
            fresh += 1;
        });

        pages += 1;
        offset += transactions.length;
        onProgress?.({ pages, fetched: offset, added: collected.length });

        // A short page means we reached the end of the account's history.
        if (transactions.length < PAGE) break;
        // Every row on this page was already stored - nothing older to find.
        if (!fresh && !full) break;

        await sleep(PAGE_DELAY_MS);
    }

    const merged = [...collected, ...existing.rows].sort((a, b) => b[IDX.BUY_T] - a[IDX.BUY_T]);
    const truncated = merged.length > MAX_ROWS;
    const rows = truncated ? merged.slice(0, MAX_ROWS) : merged;

    const state = {
        rows,
        synced_at: Date.now(),
        newest: rows.length ? rows[0][IDX.BUY_T] : existing.newest,
        truncated: truncated || existing.truncated,
    };

    const stored = save(loginid, state);
    return { ...state, stored, added: collected.length };
};

/** Headline figures, enough to prove the pipeline before the analysis lands. */
export const overview = state => {
    const rows = state.rows || [];
    if (!rows.length) return { n: 0 };

    let profit = 0;
    let staked = 0;
    let wins = 0;
    const symbols = new Set();
    const types = new Set();

    rows.forEach(r => {
        const t = rowOf(r);
        profit += t.profit;
        staked += t.buy;
        if (t.profit > 0) wins += 1;
        symbols.add(t.symbol);
        types.add(t.type);
    });

    const oldest = rows[rows.length - 1][IDX.BUY_T];
    const newest = rows[0][IDX.BUY_T];

    return {
        n: rows.length,
        profit: Number(profit.toFixed(2)),
        staked: Number(staked.toFixed(2)),
        wins,
        losses: rows.length - wins,
        win_rate: rows.length ? wins / rows.length : 0,
        // What the account actually paid to trade, as a share of everything staked.
        cost_rate: staked ? -profit / staked : 0,
        symbols: [...symbols],
        types: [...types],
        oldest,
        newest,
        days: oldest && newest ? Math.max(1, Math.round((newest - oldest) / 86400)) : 1,
    };
};
'@

$pageSrc = @'
// @ts-nocheck -- My Performance (step 1: history sync).
//
// This step only proves the data layer: pull the account's closed trades from
// Deriv, store them, and show enough to confirm the numbers are real. The
// breakdowns by market, hour, stake and streak come next.
import React from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { clear, load, overview, rowOf, sync } from '@/components/shared/nlb/history-store';
import './my-performance.scss';

const money = (v, currency) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)} ${currency}`;
const dateOf = epoch => (epoch ? new Date(epoch * 1000).toLocaleString('en-GB') : '-');

const MyPerformance = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();

    const [state, setState] = React.useState(() => load(activeLoginid || 'none'));
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [error, setError] = React.useState('');

    const currency = React.useMemo(() => {
        const acc = (accountList || []).find(a => a.loginid === activeLoginid);
        return acc?.currency || 'USD';
    }, [accountList, activeLoginid]);

    React.useEffect(() => {
        setState(load(activeLoginid || 'none'));
        setError('');
        setProgress(null);
    }, [activeLoginid]);

    const run = async full => {
        if (!activeLoginid || busy) return;
        setBusy(true);
        setError('');
        setProgress({ pages: 0, fetched: 0, added: 0 });
        try {
            const next = await sync(activeLoginid, { full, onProgress: setProgress });
            setState(next);
            if (next.stored === false) {
                setError('Loaded, but browser storage is full so this will not persist. Try a full resync later.');
            }
        } catch (e) {
            setError(e?.message || 'Could not reach Deriv. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const stats = React.useMemo(() => overview(state), [state]);
    const recent = React.useMemo(() => (state.rows || []).slice(0, 20).map(rowOf), [state]);

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
                            Your own closed trades from Deriv, stored on this device.
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
                        Nothing loaded yet. Press Load my history - the first pull can take up to a minute on an active
                        account, then future syncs only fetch what is new.
                    </div>
                )}

                {stats.n > 0 && (
                    <>
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
                            Across {stats.n} trades you staked {stats.staked.toFixed(2)} {currency} and kept{' '}
                            {money(stats.profit, currency)}. That is{' '}
                            <strong>{(stats.cost_rate * 100).toFixed(2)}%</strong> of everything you staked, spanning{' '}
                            {stats.days} day{stats.days === 1 ? '' : 's'}, across {stats.symbols.length} market
                            {stats.symbols.length === 1 ? '' : 's'} and {stats.types.length} contract type
                            {stats.types.length === 1 ? '' : 's'}.
                        </div>

                        <div className='my-performance__meta'>
                            Oldest {dateOf(stats.oldest)} &middot; newest {dateOf(stats.newest)} &middot; last synced{' '}
                            {state.synced_at ? new Date(state.synced_at).toLocaleString('en-GB') : 'never'}
                            {state.truncated ? ' - older trades beyond the storage cap were dropped' : ''}
                        </div>

                        <div className='my-performance__section-title'>Most recent trades</div>
                        <div className='my-performance__table'>
                            <div className='my-performance__row head'>
                                <span>Bought</span>
                                <span>Market</span>
                                <span>Type</span>
                                <span>Stake</span>
                                <span>P/L</span>
                            </div>
                            {recent.map(t => (
                                <div key={t.id} className={`my-performance__row ${t.profit > 0 ? 'win' : 'loss'}`}>
                                    <span>{dateOf(t.buy_time)}</span>
                                    <span>{t.symbol}</span>
                                    <span>{t.type}</span>
                                    <span>{t.buy.toFixed(2)}</span>
                                    <span>{t.profit >= 0 ? '+' : ''}{t.profit.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                <div className='my-performance__note'>
                    This data stays on this device - it is read from your Deriv account and written to your browser,
                    not to any server. Deleting it here removes the local copy only; your Deriv records are untouched.
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

    &__row {
        display: grid;
        grid-template-columns: 1.8fr 1fr 1.2fr 0.8fr 0.8fr;
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

$A1AOld = @'
    DIGIT_BOTS: 7,
    CHART: 8,
    TUTORIAL: 9,
'@

$A1ANew = @'
    DIGIT_BOTS: 7,
    MY_PERFORMANCE: 8,
    CHART: 9,
    TUTORIAL: 10,
'@

$A1BOld = @'
    MATCHES_PRO: 6,
    CHART: 7,
    TUTORIAL: 8,
'@

$A1BNew = @'
    MATCHES_PRO: 6,
    MY_PERFORMANCE: 7,
    CHART: 8,
    TUTORIAL: 9,
'@

$A2AOld = @'
'id-digit-bots', 'id-charts', 'id-tutorials'];
'@

$A2ANew = @'
'id-digit-bots', 'id-my-performance', 'id-charts', 'id-tutorials'];
'@

$A2BOld = @'
'id-matches-pro', 'id-charts', 'id-tutorials'];
'@

$A2BNew = @'
'id-matches-pro', 'id-my-performance', 'id-charts', 'id-tutorials'];
'@

$B1AOld = @'
import DigitBots from '../digit-bots/digit-bots';
'@

$B1ANew = @'
import DigitBots from '../digit-bots/digit-bots';
import MyPerformance from '../my-performance/my-performance';
'@

$B1BOld = @'
import MatchesPro from '../matches-pro/matches-pro';
'@

$B1BNew = @'
import MatchesPro from '../matches-pro/matches-pro';
import MyPerformance from '../my-performance/my-performance';
'@

$B2AOld = @'
'digit_bots', 'chart', 'tutorial'];
'@

$B2ANew = @'
'digit_bots', 'my_performance', 'chart', 'tutorial'];
'@

$B2BOld = @'
'matches_pro', 'chart', 'tutorial'];
'@

$B2BNew = @'
'matches_pro', 'my_performance', 'chart', 'tutorial'];
'@

$B3AOld = @'
                                <DigitBots />
                            </div>
'@

$B3ANew = @'
                                <DigitBots />
                            </div>
                            <div
                                label={
                                    <>
                                        <LabelPairedChartMixedCaptionBoldIcon
                                            height='24px'
                                            width='24px'
                                            fill='var(--text-general)'
                                        />
                                        <Localize i18n_default_text='My Performance' />
                                    </>
                                }
                                id='id-my-performance'
                            >
                                <MyPerformance />
                            </div>
'@

$B3BOld = @'
                                <MatchesPro />
                            </div>
'@

$B3BNew = @'
                                <MatchesPro />
                            </div>
                            <div
                                label={
                                    <>
                                        <LabelPairedChartMixedCaptionBoldIcon
                                            height='24px'
                                            width='24px'
                                            fill='var(--text-general)'
                                        />
                                        <Localize i18n_default_text='My Performance' />
                                    </>
                                }
                                id='id-my-performance'
                            >
                                <MyPerformance />
                            </div>
'@

Info ''
Info '[1/4] Writing new files'
Write-File 'src/components/shared/nlb/history-store.ts'    $storeSrc
Write-File 'src/pages/my-performance/my-performance.tsx'   $pageSrc
Write-File 'src/pages/my-performance/my-performance.scss'  $stylesSrc

Info ''
Info '[2/4] Registering the tab'
Stage-PatchAny 'src/constants/bot-contents.ts' $A1AOld $A1ANew $A1BOld $A1BNew 'MY_PERFORMANCE:' 'DBOT_TABS index'
Stage-PatchAny 'src/constants/bot-contents.ts' $A2AOld $A2ANew $A2BOld $A2BNew "'id-my-performance'" 'TAB_IDS'
Stage-PatchAny 'src/pages/main/main.tsx' $B1AOld $B1ANew $B1BOld $B1BNew 'my-performance/my-performance' 'MyPerformance import'
Stage-PatchAny 'src/pages/main/main.tsx' $B2AOld $B2ANew $B2BOld $B2BNew "'my_performance'" 'tab hash route'
Stage-PatchAny 'src/pages/main/main.tsx' $B3AOld $B3ANew $B3BOld $B3BNew '<MyPerformance />' 'My Performance tab'
Commit-Patches
Ok 'all patches written'

$ErrorActionPreference = 'Continue'

Info ''
if ($SkipBuild) { Info '[3/4] Build skipped' } else {
    Info '[3/4] Running npm run build (a few minutes)'
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host ''; Fail 'Build failed. Nothing committed. Send me the first red error block.' }
    Ok 'build succeeded'
}

Info ''
Info '[4/4] Commit and push'
git add -A
git commit -m "My Performance: Deriv trade history data layer with incremental sync"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }
if ($NoPush) { Info 'Push skipped.' } else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}
Write-Host ''
Write-Host 'Done. My Performance is the new tab before Charts.' -ForegroundColor Yellow
