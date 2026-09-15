# ==========================================================================
#  NolimitzBots - HOTFIX 2: Matches Pro crash
#
#  Real cause, found by rendering the page headlessly:
#      ReferenceError: plainRead is not defined
#  The plain-language read was added to the JSX but its definition never
#  landed, because the anchor I patched against did not exist in the file.
#
#  Also adds a page error boundary, so any future fault in one tab shows a
#  message in that tab instead of taking the whole app down.
#
#      powershell -ExecutionPolicy Bypass -File .\fix-matches-crash-2.ps1
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
if (-not (Test-Path 'src/pages/matches-pro/matches-pro.tsx')) { Fail 'Matches Pro not installed.' }
Info "Repo: $root"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

$boundarySrc = @'
// @ts-nocheck -- Page-level error boundary.
//
// Without this, a single thrown error inside one tab unmounts the whole
// application and the user sees "Sorry for the interruption" with no way back
// except a reload. With it, the broken tab shows what went wrong and every
// other tab keeps working.
import React from 'react';

class PageBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // Keep it in the console for anyone debugging a live report.
        // eslint-disable-next-line no-console
        console.error(`[${this.props.name || 'page'}] crashed`, error, info);
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        return (
            <div className='page-boundary'>
                <div className='page-boundary__card'>
                    <div className='page-boundary__title'>{this.props.name || 'This page'} hit an error</div>
                    <div className='page-boundary__msg'>{error?.message || String(error)}</div>
                    <button
                        type='button'
                        className='page-boundary__btn'
                        onClick={() => this.setState({ error: null })}
                    >
                        Try again
                    </button>
                    <div className='page-boundary__hint'>
                        The rest of the app is unaffected - the other tabs still work.
                    </div>
                </div>
            </div>
        );
    }
}

export default PageBoundary;
'@

$boundaryCss = @'
.page-boundary {
    height: var(--tab-content-height);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: linear-gradient(180deg, #0a0e17 0%, #0c1120 55%, #0a0e17 100%);

    &__card {
        max-width: 46rem;
        padding: 2rem;
        border-radius: 1.4rem;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(248, 113, 113, 0.4);
        text-align: center;
    }

    &__title {
        color: #f87171;
        font-size: 1.8rem;
        font-weight: 800;
        margin-bottom: 1rem;
    }

    &__msg {
        color: #cbd5e1;
        font-family: monospace;
        font-size: 1.2rem;
        line-height: 1.55;
        word-break: break-word;
        margin-bottom: 1.6rem;
    }

    &__btn {
        padding: 0.9rem 2rem;
        border-radius: 1rem;
        border: 1px solid rgba(212, 175, 55, 0.5);
        background: rgba(212, 175, 55, 0.15);
        color: #e8cf7a;
        font-size: 1.3rem;
        font-weight: 700;
        cursor: pointer;
    }

    &__hint {
        margin-top: 1.2rem;
        color: #7c8698;
        font-size: 1.1rem;
    }
}
'@

$pageSrc = @'
// @ts-nocheck -- Matches Pro (Phase 3: demo-only DIGITMATCH execution).
//
// Trading is off by default. Two hard locks sit in risk-guard.evaluate(), not
// in this file's UI: a real login id is refused outright, and a market cannot
// auto-trade until its backtest holds MIN_EVIDENCE graded predictions.
import React from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { isDemoAccount } from '@/utils/account-helpers';
import { subscribeTicks, TICK_STATUS, getDiagnostics } from '@/components/shared/nlb/tick-stream';
import { predict, Z_CRITICAL } from '@/components/shared/nlb/matches-engine';
import { record, read, reset, summarise } from '@/components/shared/nlb/backtest-store';
import {
    read as readAnalyse,
    record as recordAnalyse,
    reset as resetAnalyse,
    summarise as summariseAnalyse,
} from '@/components/shared/nlb/analyse-store';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { startProposals } from '@/components/shared/nlb/proposal-stream';
import {
    DEFAULT_LIMITS,
    MIN_EVIDENCE,
    QUALITY_FLOORS,
    evaluate,
    loadDay,
    loadLimits,
    recordTrade,
    resetDay,
    saveLimits,
} from '@/components/shared/nlb/risk-guard';
import PageBoundary from '@/components/shared/nlb/page-boundary';
import './matches-pro.scss';

const DEFAULT_SYMBOLS = [
    { code: 'R_100', label: 'Volatility 100 Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ10V', label: 'Volatility 10 (1s) Index' },
];

const WINDOW_CHOICES = [50, 100, 250, 500, 1000];
const HISTORY = 1000;

const STATUS_TEXT = {
    [TICK_STATUS.LIVE]: 'LIVE',
    [TICK_STATUS.CONNECTING]: 'CONNECTING',
    [TICK_STATUS.RECONNECTING]: 'RECONNECTING',
    [TICK_STATUS.DISCONNECTED]: 'DISCONNECTED',
};

const WINDOW_SECONDS = [5, 10, 20, 30];

const MAIN_FIELDS = [
    { key: 'stake', label: 'Stake', step: 0.05, min: 0.35 },
    { key: 'daily_loss_limit', label: 'Stop after losing', step: 0.5, min: 0.5 },
];

const ADVANCED_FIELDS = [
    { key: 'max_trades', label: 'Max trades / day', step: 1, min: 1 },
    { key: 'max_consecutive_losses', label: 'Max losses in a row', step: 1, min: 1 },
    { key: 'daily_profit_target', label: 'Daily profit target', step: 0.5, min: 0.5 },
    { key: 'cooldown_ticks', label: 'Cooldown (ticks)', step: 1, min: 0 },
];

// Roughly how often each floor fired across 200k simulated ticks. Shown so the
// choice is made with its trade frequency visible.
const FLOOR_RATE = {
    STRONG: 'fires on about 0.4% of ticks - often nothing for hours',
    MEDIUM: 'fires on about 0.5% of ticks - a few times an hour at most',
    WEAK: 'fires on about 8% of ticks - roughly every 20 seconds',
    ANY: 'every tick qualifies - the engine is bypassed entirely',
};

const pct = v => `${(v * 100).toFixed(2)}%`;
const clockOf = ts => new Date(ts).toLocaleTimeString('en-GB');

const MatchesPro = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();
    const { run_panel } = useStore();

    const [symbol, setSymbol] = React.useState('R_100');
    const [symbols, setSymbols] = React.useState(DEFAULT_SYMBOLS);
    const [status, setStatus] = React.useState(TICK_STATUS.CONNECTING);
    const [quote, setQuote] = React.useState(null);
    const [decimals, setDecimals] = React.useState(null);
    const [digits, setDigits] = React.useState([]);
    const [window_size, setWindowSize] = React.useState(100);
    const [payout, setPayout] = React.useState(9.3);
    const [error, setError] = React.useState('');
    const [diag, setDiag] = React.useState(null);
    const [prediction, setPrediction] = React.useState(null);
    const [stats, setStats] = React.useState(null);
    const [feed, setFeed] = React.useState([]);
    const [show_why, setShowWhy] = React.useState(false);
    const [show_advanced, setShowAdvanced] = React.useState(false);
    const [live_pricing, setLivePricing] = React.useState(false);

    const [analysis, setAnalysis] = React.useState(null);
    const [remaining, setRemaining] = React.useState(0);
    const [window_seconds, setWindowSeconds] = React.useState(10);
    const [analyse_stats, setAnalyseStats] = React.useState(null);

    const [auto, setAuto] = React.useState(false);
    const [limits, setLimits] = React.useState(DEFAULT_LIMITS);
    const [day, setDay] = React.useState(() => loadDay('R_100'));
    const [gate, setGate] = React.useState({ allowed: false, reason: 'Auto trade is off' });

    const digits_ref = React.useRef([]);
    const pending_ref = React.useRef(null);
    const payout_ref = React.useRef(payout);
    const auto_ref = React.useRef(auto);
    const limits_ref = React.useRef(limits);
    const symbol_ref = React.useRef(symbol);
    const open_ref = React.useRef(new Set());
    const cooldown_ref = React.useRef(0);
    const firing_ref = React.useRef(false);
    const trackers_ref = React.useRef([]);
    const analysis_ref = React.useRef(null);
    const proposals_ref = React.useRef(null);

    payout_ref.current = payout;
    auto_ref.current = auto;
    limits_ref.current = limits;
    symbol_ref.current = symbol;

    const currency = React.useMemo(() => {
        const acc = (accountList || []).find(a => a.loginid === activeLoginid);
        return acc?.currency || 'USD';
    }, [accountList, activeLoginid]);

    const is_demo = isDemoAccount(activeLoginid || '');

    React.useEffect(() => {
        setLimits(loadLimits());
    }, []);

    const refreshStats = React.useCallback(sym => {
        const state = read(sym);
        setStats({ state, summary: summarise(state) });
        return state;
    }, []);

    const refreshDay = React.useCallback(sym => {
        const d = loadDay(sym);
        setDay(d);
        return d;
    }, []);

    // ------------------------------------------------------------- execution
    const fireTrade = React.useCallback(
        async (sym, digit) => {
            if (firing_ref.current) return;
            firing_ref.current = true;
            try {
                const stake = Number(limits_ref.current.stake);

                // Fast path: a subscribed proposal for this digit is already
                // priced, so the buy goes out immediately.
                let live = null;
                try {
                    live = proposals_ref.current?.get?.(digit) || null;
                } catch {
                    live = null;
                }

                if (!live) {
                    const proposal = await api_base.api.send({
                        proposal: 1,
                        amount: stake,
                        basis: 'stake',
                        contract_type: 'DIGITMATCH',
                        currency,
                        duration: 1,
                        duration_unit: 't',
                        underlying_symbol: sym,
                        barrier: String(digit),
                    });
                    if (!proposal?.proposal?.id) throw new Error('No proposal returned');
                    live = {
                        id: proposal.proposal.id,
                        ask: Number(proposal.proposal.ask_price),
                        payout: Number(proposal.proposal.payout),
                    };
                }

                const id = live.id;
                const ask = live.ask;
                const win_payout = live.payout;
                if (ask > 0 && win_payout > 0) setPayout(Number((win_payout / ask).toFixed(3)));

                const bought = await api_base.api.send({ buy: id, price: ask });
                const contract_id = bought?.buy?.contract_id;
                if (!contract_id) throw new Error('Buy did not return a contract');

                open_ref.current.add(contract_id);
                cooldown_ref.current = Number(limits_ref.current.cooldown_ticks) || 0;

                const tracker = trackContracts([contract_id], {
                    onDone: ({ profits }) => {
                        const profit = Number(Object.values(profits)[0] ?? 0);
                        open_ref.current.delete(contract_id);
                        recordTrade(sym, {
                            t: Date.now(),
                            contract_id,
                            symbol: sym,
                            predicted: digit,
                            stake,
                            payout: win_payout,
                            profit,
                        });
                        refreshDay(sym);
                    },
                });
                trackers_ref.current.push(tracker);
            } catch (e) {
                setError(describeError(e));
                cooldown_ref.current = Math.max(cooldown_ref.current, 5);
            } finally {
                firing_ref.current = false;
            }
        },
        [currency, refreshDay]
    );

    // ------------------------------------------------------------- per tick
    const step = React.useCallback(
        (sym, actual_digit, ts) => {
            if (cooldown_ref.current > 0) cooldown_ref.current -= 1;

            const pending = pending_ref.current;
            if (pending && pending.predicted !== null && pending.symbol === sym) {
                record(sym, {
                    t: ts,
                    predicted: pending.predicted,
                    actual: actual_digit,
                    quality: pending.quality,
                    score: pending.score,
                });
                setFeed(prev =>
                    [
                        {
                            t: ts,
                            predicted: pending.predicted,
                            actual: actual_digit,
                            hit: pending.predicted === actual_digit,
                            quality: pending.quality,
                        },
                        ...prev,
                    ].slice(0, 12)
                );
            }

            // A live analysis window scores itself against the ticks that
            // arrive inside it.
            const open = analysis_ref.current;
            if (open && !open.done && open.symbol === sym && Date.now() < open.ends) {
                open.ticks.push(actual_digit);
                if (actual_digit === open.digit) open.hits += 1;
                setAnalysis({ ...open });
            }

            const next = predict(digits_ref.current, { payout: payout_ref.current });
            setPrediction(next);
            pending_ref.current = {
                symbol: sym,
                predicted: next.predictedDigit,
                quality: next.signalQuality,
                score: next.score,
            };

            const state = refreshStats(sym);
            const current_day = loadDay(sym);
            setDay(current_day);

            const decision = evaluate({
                limits: limits_ref.current,
                day: current_day,
                quality: next.signalQuality,
                is_authorized: isAuthorized,
                loginid: activeLoginid,
                open_count: open_ref.current.size,
                cooldown_remaining: cooldown_ref.current,
                evidence: state.total,
                auto_on: auto_ref.current,
            });
            setGate(decision);

            if (decision.allowed && next.predictedDigit !== null) {
                fireTrade(sym, next.predictedDigit);
            }
        },
        [refreshStats, isAuthorized, activeLoginid, fireTrade]
    );

    React.useEffect(() => {
        digits_ref.current = [];
        pending_ref.current = null;
        open_ref.current = new Set();
        cooldown_ref.current = 0;
        setDigits([]);
        setQuote(null);
        setError('');
        setFeed([]);
        setPrediction(null);
        refreshStats(symbol);
        refreshDay(symbol);

        const unsubscribe = subscribeTicks({
            symbol,
            count: HISTORY,
            onStatus: setStatus,
            onError: message => setError(message),
            onSymbols: list => {
                if (!list?.length) return;
                const known = Object.fromEntries(DEFAULT_SYMBOLS.map(s => [s.code, s.label]));
                setSymbols(
                    list.map(s => ({
                        code: s.code,
                        label: s.label && s.label !== s.code ? s.label : known[s.code] || s.code,
                    }))
                );
            },
            onHistory: ({ digits: d, quote: q, decimals: dec }) => {
                digits_ref.current = [...d];
                setDigits(d);
                setQuote(q);
                setDecimals(dec);
                const seeded = predict(digits_ref.current, { payout: payout_ref.current });
                setPrediction(seeded);
                pending_ref.current = {
                    symbol,
                    predicted: seeded.predictedDigit,
                    quality: seeded.signalQuality,
                    score: seeded.score,
                };
            },
            onTick: ({ digit, quote: q, decimals: dec }) => {
                setDecimals(dec);
                setQuote(q);
                digits_ref.current = [...digits_ref.current, digit].slice(-HISTORY);
                setDigits(digits_ref.current);
                step(symbol, digit, Date.now());
            },
        });

        return () => {
            unsubscribe();
            trackers_ref.current.forEach(t => {
                try {
                    t.cancel();
                } catch {
                    /* noop */
                }
            });
            trackers_ref.current = [];
        };
    }, [symbol, step, refreshStats, refreshDay]);

    // Switching market stops auto trading. Limits are per day, per market.
    React.useEffect(() => {
        setAuto(false);
    }, [symbol]);

    React.useEffect(() => {
        const id = setInterval(() => setDiag(getDiagnostics()), 1000);
        return () => clearInterval(id);
    }, []);

    // Pre-priced proposals for all ten digits. Gives instant buys and a real
    // payout multiplier instead of a typed-in one.
    React.useEffect(() => {
        proposals_ref.current?.stop?.();
        proposals_ref.current = null;
        setLivePricing(false);

        if (!isAuthorized || !activeLoginid) return undefined;
        const stake = Number(limits.stake);
        if (!(stake > 0)) return undefined;

        let handle = null;
        try {
            handle = startProposals({
                symbol,
                currency,
                amount: stake,
                onUpdate: ({ multiplier }) => {
                    if (!multiplier || !Number.isFinite(multiplier)) return;
                    setLivePricing(true);
                    setPayout(prev => (Math.abs(prev - multiplier) > 0.005 ? Number(multiplier.toFixed(3)) : prev));
                },
                onError: e => setError(describeError(e)),
            });
            proposals_ref.current = handle;
        } catch (e) {
            // Live pricing is an optimisation. If it cannot start, trading
            // still works through the ordinary proposal-then-buy path.
            setError(describeError(e));
        }

        return () => {
            try {
                handle?.stop();
            } catch {
                /* noop */
            }
            proposals_ref.current = null;
            setLivePricing(false);
        };
    }, [symbol, currency, limits.stake, isAuthorized, activeLoginid]);

    const refreshAnalyseStats = React.useCallback(sym => {
        const state = readAnalyse(sym);
        setAnalyseStats({ state, summary: summariseAnalyse(state) });
    }, []);

    React.useEffect(() => {
        refreshAnalyseStats(symbol);
        analysis_ref.current = null;
        setAnalysis(null);
        setRemaining(0);
    }, [symbol, refreshAnalyseStats]);

    const startAnalysis = () => {
        const next = predict(digits_ref.current, { payout: payout_ref.current });
        if (next.predictedDigit === null) return;
        const open = {
            symbol,
            digit: next.predictedDigit,
            quality: next.signalQuality,
            probability: next.probabilityEstimate,
            breakeven: next.breakeven,
            score: next.score,
            started: Date.now(),
            ends: Date.now() + window_seconds * 1000,
            ticks: [],
            hits: 0,
            done: false,
        };
        analysis_ref.current = open;
        setAnalysis({ ...open });
        setRemaining(window_seconds);
    };

    // Countdown, and settle the window once it expires.
    React.useEffect(() => {
        if (!analysis || analysis.done) return undefined;
        const id = setInterval(() => {
            const open = analysis_ref.current;
            if (!open || open.done) return;
            const left = Math.max(0, Math.ceil((open.ends - Date.now()) / 1000));
            setRemaining(left);
            if (left === 0) {
                open.done = true;
                recordAnalyse(open.symbol, {
                    t: open.started,
                    digit: open.digit,
                    ticks: open.ticks.length,
                    hits: open.hits,
                });
                setAnalysis({ ...open });
                refreshAnalyseStats(open.symbol);
            }
        }, 250);
        return () => clearInterval(id);
    }, [analysis, refreshAnalyseStats]);

    // Arming auto trade opens the run panel drawer, so Summary, Transactions
    // and Journal are on screen as contracts settle. Disarming closes it.
    React.useEffect(() => {
        try {
            run_panel?.setIsRunning?.(auto);
        } catch {
            /* run panel unavailable - trading still works */
        }
        return () => {
            if (auto) {
                try {
                    run_panel?.setIsRunning?.(false);
                } catch {
                    /* noop */
                }
            }
        };
    }, [auto, run_panel]);

    const sample = React.useMemo(() => digits.slice(-window_size), [digits, window_size]);

    const distribution = React.useMemo(() => {
        const counts = new Array(10).fill(0);
        sample.forEach(d => {
            counts[d] += 1;
        });
        const total = sample.length || 1;
        return counts.map((c, d) => ({ digit: d, count: c, p: (c / total) * 100 }));
    }, [sample]);

    const max_pct = Math.max(10, ...distribution.map(d => d.p));
    const current_digit = digits.length ? digits[digits.length - 1] : null;
    const status_text = STATUS_TEXT[status] || STATUS_TEXT[TICK_STATUS.DISCONNECTED];
    const predicted = prediction?.predictedDigit;
    const quality = prediction?.signalQuality || 'NO SIGNAL';
    const evidence = stats?.summary?.n || 0;
    const unlocked = evidence >= MIN_EVIDENCE;
    const can_arm = isAuthorized && is_demo && unlocked;

    const setLimit = (key, value) => {
        const next = { ...limits_ref.current, [key]: key === 'min_quality' ? value : Number(value) };
        setLimits(next);
        saveLimits(next);
    };

    const marketLabel = React.useMemo(
        () => symbols.find(s => s.code === symbol)?.label || symbol,
        [symbols, symbol]
    );

    // Same numbers as the panel above, said in a sentence.
    const plainRead = React.useMemo(() => {
        if (!prediction || prediction.predictedDigit === null) return '';
        const lead = `Digit ${prediction.predictedDigit} is leading on ${marketLabel}`;
        if (prediction.signalQuality === 'NO SIGNAL') {
            return `${lead}, but the lead is within normal variation - nothing decisive.`;
        }
        if (prediction.signalQuality === 'WEAK') {
            return `${lead} and the lead is building, but it has not cleared the significance bar.`;
        }
        if (prediction.probabilityEstimate <= prediction.breakeven) {
            return `${lead} and the lead is statistically real, but at ${pct(prediction.probabilityEstimate)} it is still under the ${pct(prediction.breakeven)} this payout needs.`;
        }
        return `${lead}, clears the significance bar, and at ${pct(prediction.probabilityEstimate)} sits above the ${pct(prediction.breakeven)} break-even.`;
    }, [prediction, marketLabel]);

    return (
        <div className='matches-pro'>
            <div className='matches-pro__panel'>
                <div className='matches-pro__head'>
                    <div>
                        <div className='matches-pro__title'>MATCHES PRO</div>
                        <div className='matches-pro__subtitle'>Phase 3 - demo auto trading with risk limits.</div>
                    </div>
                    <div className={`matches-pro__status matches-pro__status--${status}`}>
                        <i className='matches-pro__dot' />
                        {status_text}
                    </div>
                </div>

                {error && <div className='matches-pro__warn'>{error}</div>}

                <div className='matches-pro__controls'>
                    <label className='matches-pro__field'>
                        <span>Market</span>
                        <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                            {symbols.map(s => (
                                <option key={s.code} value={s.code}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>Distribution window</span>
                        <select value={window_size} onChange={e => setWindowSize(Number(e.target.value))}>
                            {WINDOW_CHOICES.map(w => (
                                <option key={w} value={w}>
                                    {w} ticks
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>{live_pricing ? 'Payout multiplier (live from Deriv)' : 'Payout multiplier'}</span>
                        <input
                            type='number'
                            step='0.1'
                            min='1.1'
                            value={payout}
                            readOnly={live_pricing}
                            onChange={e => setPayout(Number(e.target.value) || 9.3)}
                        />
                    </label>
                </div>

                <div className='matches-pro__readout'>
                    <div className='matches-pro__stat'>
                        <span>Current tick</span>
                        <strong>{quote ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Current digit</span>
                        <strong className='matches-pro__digit'>{current_digit ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Decimals</span>
                        <strong>{decimals ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>History</span>
                        <strong>{digits.length}</strong>
                    </div>
                </div>

                <div className='matches-pro__section-title'>Statistical analysis</div>
                <div className={`matches-pro__signal matches-pro__signal--${quality.replace(' ', '-').toLowerCase()}`}>
                    <div className='matches-pro__signal-main'>
                        <div className='matches-pro__signal-digit'>{predicted ?? '-'}</div>
                        <div>
                            <div className='matches-pro__signal-quality'>{quality}</div>
                            <div className='matches-pro__signal-sub'>
                                Score {prediction?.score ?? 0}/100, sample {prediction?.sampleSize ?? 0}
                            </div>
                        </div>
                    </div>
                    <div className='matches-pro__signal-nums'>
                        <div>
                            <span>Estimated probability</span>
                            <strong>{prediction ? pct(prediction.probabilityEstimate) : '-'}</strong>
                        </div>
                        <div>
                            <span>Break-even needed</span>
                            <strong>{prediction ? pct(prediction.breakeven) : '-'}</strong>
                        </div>
                    </div>
                </div>

                {plainRead && <div className='matches-pro__read'>{plainRead}</div>}

                {prediction && (
                    <>
                        <button type='button' className='matches-pro__link' onClick={() => setShowWhy(v => !v)}>
                            {show_why ? 'Hide reasoning' : 'Why?'}
                        </button>
                        {show_why && (
                            <div className='matches-pro__why'>
                                <p>{prediction.reason}</p>
                                <table>
                                    <tbody>
                                        {prediction.factors.map(f => (
                                            <tr key={f.label}>
                                                <td>{f.label}</td>
                                                <td className={f.value >= 0 ? 'pos' : 'neg'}>
                                                    {f.value >= 0 ? '+' : ''}
                                                    {f.value.toFixed(2)} sigma
                                                </td>
                                                <td className='note'>{f.note || ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <p className='matches-pro__why-foot'>
                                    Significance bar is {Z_CRITICAL} sigma, corrected for testing 10 digits across 5
                                    windows every tick. Probability is shrunk toward 10% with a 500-observation prior.
                                </p>
                            </div>
                        )}
                    </>
                )}

                {/* -------------------------------- analyse -------------------------------- */}
                <div className='matches-pro__section-title'>Analyse</div>
                <div className='matches-pro__analyse'>
                    <div className='matches-pro__analyse-controls'>
                        <button
                            type='button'
                            className='matches-pro__analyse-btn'
                            disabled={!prediction || prediction.predictedDigit === null}
                            onClick={startAnalysis}
                        >
                            {analysis && !analysis.done ? 'ANALYSING...' : 'ANALYSE'}
                        </button>
                        <label className='matches-pro__field'>
                            <span>Window</span>
                            <select
                                value={window_seconds}
                                onChange={e => setWindowSeconds(Number(e.target.value))}
                                disabled={analysis && !analysis.done}
                            >
                                {WINDOW_SECONDS.map(w => (
                                    <option key={w} value={w}>
                                        {w} seconds
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {analysis && (
                        <div className={`matches-pro__analyse-card ${analysis.done ? 'done' : 'live'}`}>
                            <div className='matches-pro__analyse-digit'>{analysis.digit}</div>
                            <div className='matches-pro__analyse-body'>
                                {!analysis.done ? (
                                    <>
                                        <div className='matches-pro__analyse-count'>{remaining}s</div>
                                        <div className='matches-pro__analyse-bar'>
                                            <span
                                                style={{
                                                    width: `${(remaining / window_seconds) * 100}%`,
                                                }}
                                            />
                                        </div>
                                        <div className='matches-pro__analyse-sub'>
                                            {analysis.ticks.length} tick{analysis.ticks.length === 1 ? '' : 's'} so far,{' '}
                                            {analysis.hits} match{analysis.hits === 1 ? '' : 'es'}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className='matches-pro__analyse-count'>
                                            {analysis.hits}/{analysis.ticks.length}
                                        </div>
                                        <div className='matches-pro__analyse-sub'>
                                            Digit {analysis.digit} appeared {analysis.hits} time
                                            {analysis.hits === 1 ? '' : 's'} in {analysis.ticks.length} tick
                                            {analysis.ticks.length === 1 ? '' : 's'}. Expected about{' '}
                                            {(analysis.ticks.length * 0.1).toFixed(1)}.
                                        </div>
                                    </>
                                )}
                                <div className='matches-pro__analyse-nums'>
                                    {analysis.quality} &middot; estimated {pct(analysis.probability)} &middot; break-even{' '}
                                    {pct(analysis.breakeven)}
                                </div>
                            </div>
                            {analysis.ticks.length > 0 && (
                                <div className='matches-pro__analyse-ticks'>
                                    {analysis.ticks.map((d, i) => (
                                        <span key={`${i}-${d}`} className={d === analysis.digit ? 'hit' : ''}>
                                            {d}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {analyse_stats && analyse_stats.state.analyses > 0 && (
                        <div className='matches-pro__verdict'>
                            {analyse_stats.summary.verdict}
                            <button
                                type='button'
                                className='matches-pro__link'
                                onClick={() => {
                                    resetAnalyse(symbol);
                                    refreshAnalyseStats(symbol);
                                }}
                            >
                                Reset tally
                            </button>
                        </div>
                    )}

                    <div className='matches-pro__note-inline'>
                        The countdown is a window to act in, not a period during which the digit becomes more likely.
                        Each digit stays at roughly 10% per tick throughout. The tally above is this button&apos;s own
                        record - watch it rather than any single result.
                    </div>
                </div>

                {/* -------------------------------- trading -------------------------------- */}
                <div className='matches-pro__section-title'>Trading</div>

                <div className='matches-pro__locks'>
                    <div className={`matches-pro__lock ${isAuthorized ? 'ok' : 'bad'}`}>
                        {isAuthorized ? 'Signed in' : 'Not signed in'}
                    </div>
                    <div className={`matches-pro__lock ${is_demo ? 'ok' : 'bad'}`}>
                        {activeLoginid ? `${activeLoginid} ${is_demo ? '(demo)' : '(REAL - blocked)'}` : 'No account'}
                    </div>
                    <div className={`matches-pro__lock ${unlocked ? 'ok' : 'bad'}`}>
                        Evidence {evidence}/{MIN_EVIDENCE}
                    </div>
                </div>

                <div className='matches-pro__limits'>
                    {MAIN_FIELDS.map(f => (
                        <label key={f.key} className='matches-pro__field'>
                            <span>{f.label}</span>
                            <input
                                type='number'
                                step={f.step}
                                min={f.min}
                                value={limits[f.key]}
                                onChange={e => setLimit(f.key, e.target.value)}
                            />
                        </label>
                    ))}
                    <label className='matches-pro__field'>
                        <span>Trade on</span>
                        <select value={limits.min_quality} onChange={e => setLimit('min_quality', e.target.value)}>
                            {QUALITY_FLOORS.map(q => (
                                <option key={q.value} value={q.value}>
                                    {q.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                <div className='matches-pro__note-inline'>{FLOOR_RATE[limits.min_quality]}</div>

                {limits.min_quality === 'ANY' && (
                    <div className='matches-pro__warn'>
                        Validation mode: every tick qualifies, so the engine&apos;s judgement is bypassed. Useful for
                        checking the trading path end to end, not a strategy.
                    </div>
                )}

                <button type='button' className='matches-pro__link' onClick={() => setShowAdvanced(v => !v)}>
                    {show_advanced ? 'Hide advanced limits' : 'Advanced limits'}
                </button>

                {show_advanced && (
                    <div className='matches-pro__limits'>
                        {ADVANCED_FIELDS.map(f => (
                            <label key={f.key} className='matches-pro__field'>
                                <span>{f.label}</span>
                                <input
                                    type='number'
                                    step={f.step}
                                    min={f.min}
                                    value={limits[f.key]}
                                    onChange={e => setLimit(f.key, e.target.value)}
                                />
                            </label>
                        ))}
                    </div>
                )}

                <div className='matches-pro__trade-bar'>
                    <button
                        type='button'
                        className={`matches-pro__auto ${auto ? 'on' : ''}`}
                        disabled={!can_arm}
                        onClick={() => setAuto(v => !v)}
                    >
                        {auto ? 'STOP AUTO TRADING' : 'START AUTO TRADING (DEMO)'}
                    </button>
                    <div className={`matches-pro__gate ${gate.allowed ? 'ok' : ''}`}>{gate.reason}</div>
                </div>

                <div className='matches-pro__readout'>
                    <div className='matches-pro__stat'>
                        <span>Trades today</span>
                        <strong>{day.trades.length}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Wins / losses</span>
                        <strong>
                            {day.wins}/{day.losses}
                        </strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Hit rate</span>
                        <strong>
                            {day.trades.length ? `${((day.wins / day.trades.length) * 100).toFixed(1)}%` : '-'}
                        </strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Profit / loss</span>
                        <strong className={day.pl >= 0 ? 'pos' : 'neg'}>
                            {day.pl >= 0 ? '+' : ''}
                            {day.pl.toFixed(2)}
                        </strong>
                    </div>
                </div>

                <div className='matches-pro__note-inline'>
                    Every contract appears in the run panel below under Summary, Transactions and Journal.
                </div>

                <button
                    type='button'
                    className='matches-pro__link'
                    onClick={() => {
                        resetDay(symbol);
                        refreshDay(symbol);
                    }}
                >
                    Reset today&apos;s trading counters
                </button>

                {/* -------------------------------- backtest -------------------------------- */}
                <div className='matches-pro__section-title'>
                    Backtest
                    <button
                        type='button'
                        className='matches-pro__reset'
                        onClick={() => {
                            reset(symbol);
                            setFeed([]);
                            refreshStats(symbol);
                        }}
                    >
                        Reset
                    </button>
                </div>
                {stats && (
                    <>
                        <div className='matches-pro__readout'>
                            <div className='matches-pro__stat'>
                                <span>Predictions</span>
                                <strong>{stats.summary.n}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Correct</span>
                                <strong>{stats.summary.k}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Accuracy</span>
                                <strong>{stats.summary.n ? pct(stats.summary.accuracy) : '-'}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Baseline</span>
                                <strong>10.00%</strong>
                            </div>
                        </div>
                        <div className='matches-pro__verdict'>{stats.summary.verdict}</div>
                        <div className='matches-pro__mini'>
                            Last 100: {pct(stats.summary.recent_accuracy)}, longest hit streak{' '}
                            {stats.state.longest_win}, longest miss streak {stats.state.longest_loss}
                        </div>
                        {Object.keys(stats.state.by_quality).length > 0 && (
                            <div className='matches-pro__mini'>
                                {Object.entries(stats.state.by_quality).map(([q, v]) => (
                                    <span key={q} className='matches-pro__tag'>
                                        {q}: {v.correct}/{v.n} ({v.n ? ((v.correct / v.n) * 100).toFixed(1) : '0.0'}%)
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}

                <div className='matches-pro__section-title'>Signal feed</div>
                <div className='matches-pro__feed'>
                    {feed.map(f => (
                        <div key={f.t} className={`matches-pro__feed-row ${f.hit ? 'hit' : 'miss'}`}>
                            <span>{clockOf(f.t)}</span>
                            <span>MATCH {f.predicted}</span>
                            <span>actual {f.actual}</span>
                            <span>{f.quality}</span>
                            <span>{f.hit ? 'HIT' : 'miss'}</span>
                        </div>
                    ))}
                    {!feed.length && <span className='matches-pro__muted'>Waiting for the next tick...</span>}
                </div>

                <div className='matches-pro__section-title'>Digit distribution - last {sample.length} ticks</div>
                <div className='matches-pro__dist'>
                    {distribution.map(d => (
                        <div key={d.digit} className='matches-pro__row'>
                            <span className={`matches-pro__row-digit ${d.digit === predicted ? 'is-predicted' : ''}`}>
                                {d.digit}
                            </span>
                            <span className='matches-pro__bar'>
                                <span style={{ width: `${(d.p / max_pct) * 100}%` }} />
                            </span>
                            <span className='matches-pro__row-pct'>{d.p.toFixed(1)}%</span>
                        </div>
                    ))}
                </div>

                {diag && (
                    <div className='matches-pro__diag'>
                        socket {diag.ready_state} | messages {diag.messages} | last {diag.last_msg_type} | symbols{' '}
                        {diag.symbols_seen} | precision {diag.pip_source} ({diag.known_decimals} known) | open{' '}
                        {open_ref.current.size}
                        {diag.last_error ? ` | ${diag.last_error}` : ''}
                    </div>
                )}

                <div className='matches-pro__note'>
                    Demo accounts only in this phase - a real login id is refused by the execution layer, not just
                    hidden here. Auto trading unlocks per market at {MIN_EVIDENCE} graded predictions. The signal floor is yours to
                    set, but lowering it does not create an edge - it only trades more often on weaker evidence. Every trade still faces a negative expected value at a{' '}
                    {payout}x payout unless the estimated probability beats {pct(1 / payout)}, so treat a profitable
                    demo run as a small sample, not a discovery.
                </div>
            </div>
        </div>
    );
};

const MatchesProPage = () => (
    <PageBoundary name='Matches Pro'>
        <MatchesPro />
    </PageBoundary>
);

export default MatchesProPage;
'@

Info ''
Info '[1/3] Writing files'
Write-File 'src/components/shared/nlb/page-boundary.tsx'  $boundarySrc
Write-File 'src/components/shared/nlb/page-boundary.scss' $boundaryCss
Write-File 'src/pages/matches-pro/matches-pro.tsx'        $pageSrc

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
git pull --rebase origin main
git add -A
git commit -m "Fix Matches Pro crash (missing plainRead definition) and add page error boundary"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }
if ($NoPush) { Info 'Push skipped.' } else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}
Write-Host ''
Write-Host 'Done. Hard refresh once Vercel is green.' -ForegroundColor Yellow
