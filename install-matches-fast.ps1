# ==========================================================================
#  NolimitzBots - Matches Pro: live proposal stream
#   * subscribed proposals for all ten digits, so a buy skips the
#     proposal round-trip and lands on the intended tick far more often
#   * payout multiplier now comes live from Deriv instead of being typed in,
#     so break-even is always correct
#   * plain-language read of what the analysis currently says
#
#      powershell -ExecutionPolicy Bypass -File .\install-matches-fast.ps1
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
if (-not (Test-Path 'src/components/shared/nlb/risk-guard.ts')) { Fail 'Matches Pro Phase 3 not installed.' }
Info "Repo: $root"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

$streamSrc = @'
// @ts-nocheck -- Live DIGITMATCH proposal stream.
//
// Without this, buying takes two round-trips to Deriv: request a proposal,
// wait, then buy against the id it returns. On a one-tick contract that delay
// can push the order onto a later tick than the one the engine was reasoning
// about.
//
// Here we keep a subscribed proposal open for all ten barriers at once. Deriv
// pushes a fresh id and price on every tick, so a buy is a single message with
// an id we already hold.
//
// It also gives the real payout multiplier continuously, which is what the
// break-even figure should be based on rather than a typed-in guess.

import { api_base } from '@/external/bot-skeleton';

const STALE_MS = 15000; // a proposal id older than this is not trusted

export const startProposals = ({ symbol, currency, amount, contract_type = 'DIGITMATCH', onUpdate, onError }) => {
    const latest = {}; // digit -> { id, ask, payout, at }
    let stream = null;
    let stopped = false;

    try {
        stream = api_base.api.onMessage().subscribe(({ data }) => {
            if (stopped) return;
            if (data?.msg_type !== 'proposal' || !data.proposal) return;

            const echo = data.echo_req || {};
            // Only accept proposals matching the stream we asked for - the
            // account may have other proposal traffic from other surfaces.
            if (echo.underlying_symbol !== symbol) return;
            if (echo.contract_type !== contract_type) return;
            if (Number(echo.amount) !== Number(amount)) return;
            if (echo.barrier === undefined || echo.barrier === null) return;

            const digit = Number(echo.barrier);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) return;

            latest[digit] = {
                id: data.proposal.id,
                ask: Number(data.proposal.ask_price),
                payout: Number(data.proposal.payout),
                at: Date.now(),
            };
            onUpdate?.(latest, digit);
        });
    } catch (e) {
        onError?.(e);
    }

    for (let digit = 0; digit < 10; digit += 1) {
        try {
            api_base.api
                .send({
                    proposal: 1,
                    subscribe: 1,
                    amount: Number(amount),
                    basis: 'stake',
                    contract_type,
                    currency,
                    duration: 1,
                    duration_unit: 't',
                    underlying_symbol: symbol,
                    barrier: String(digit),
                })
                .catch(e => onError?.(e));
        } catch (e) {
            onError?.(e);
        }
    }

    return {
        // A priced, unexpired proposal for this digit, or null.
        get: digit => {
            const p = latest[digit];
            if (!p) return null;
            if (Date.now() - p.at > STALE_MS) return null;
            return p;
        },
        all: () => latest,
        // Payout multiplier implied by whatever we currently hold.
        multiplier: () => {
            const priced = Object.values(latest).filter(p => p.ask > 0 && Date.now() - p.at <= STALE_MS);
            if (!priced.length) return null;
            const ratios = priced.map(p => p.payout / p.ask);
            return ratios.reduce((a, b) => a + b, 0) / ratios.length;
        },
        stop: () => {
            stopped = true;
            try {
                api_base.api.send({ forget_all: 'proposal' });
            } catch {
                /* noop */
            }
            try {
                stream?.unsubscribe();
            } catch {
                /* noop */
            }
        },
    };
};
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
                let live = proposals_ref.current?.get?.(digit) || null;

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

        const handle = startProposals({
            symbol,
            currency,
            amount: stake,
            onUpdate: () => {
                const m = handle.multiplier();
                if (m && Number.isFinite(m)) {
                    setLivePricing(true);
                    setPayout(prev => (Math.abs(prev - m) > 0.005 ? Number(m.toFixed(3)) : prev));
                }
            },
            onError: e => setError(describeError(e)),
        });
        proposals_ref.current = handle;

        return () => {
            handle.stop();
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

export default MatchesPro;
'@

$stylesSrc = @'
.matches-pro {
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

    &__analyse {
        margin-bottom: 1.6rem;
    }

    &__analyse-controls {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 1rem;
        margin-bottom: 1.2rem;
    }

    &__analyse-btn {
        padding: 1.1rem 2.4rem;
        border-radius: 1rem;
        border: 1px solid rgba(212, 175, 55, 0.55);
        background: linear-gradient(180deg, rgba(212, 175, 55, 0.3), rgba(212, 175, 55, 0.14));
        color: #e8cf7a;
        font-size: 1.4rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        cursor: pointer;

        &:disabled { opacity: 0.4; cursor: not-allowed; }
    }

    &__analyse-card {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 1.4rem;
        padding: 1.4rem;
        border-radius: 1.2rem;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.03);

        &.live { border-color: rgba(212, 175, 55, 0.55); }
        &.done { border-color: rgba(148, 163, 184, 0.35); }

        @media (max-width: 600px) {
            grid-template-columns: 1fr;
        }
    }

    &__analyse-digit {
        width: 9rem;
        height: 9rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 1.4rem;
        background: rgba(212, 175, 55, 0.14);
        border: 1px solid rgba(212, 175, 55, 0.4);
        color: #e8cf7a;
        font-size: 5rem;
        font-weight: 800;
        line-height: 1;
    }

    &__analyse-body {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 0.6rem;
    }

    &__analyse-count {
        color: #e8eaf0;
        font-size: 2.4rem;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
    }

    &__analyse-bar {
        height: 0.6rem;
        background: rgba(255, 255, 255, 0.07);
        border-radius: 999px;
        overflow: hidden;

        span {
            display: block;
            height: 100%;
            background: linear-gradient(90deg, rgba(212, 175, 55, 0.6), #e8cf7a);
            transition: width 0.25s linear;
        }
    }

    &__analyse-sub {
        color: #9aa1b0;
        font-size: 1.2rem;
        line-height: 1.5;
    }

    &__analyse-nums {
        color: #7c8698;
        font-size: 1.1rem;
    }

    &__analyse-ticks {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;

        span {
            min-width: 2.4rem;
            text-align: center;
            padding: 0.35rem 0.5rem;
            border-radius: 0.6rem;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #9aa1b0;
            font-family: monospace;
            font-size: 1.2rem;

            &.hit {
                color: #34d399;
                border-color: rgba(52, 211, 153, 0.5);
                background: rgba(52, 211, 153, 0.12);
            }
        }
    }

    &__read {
        margin-top: 1rem;
        padding: 1rem 1.2rem;
        border-radius: 1rem;
        background: rgba(148, 163, 184, 0.09);
        border: 1px solid rgba(148, 163, 184, 0.22);
        color: #cbd5e1;
        font-size: 1.3rem;
        line-height: 1.55;
    }

    &__note-inline {
        margin-top: 1rem;
        color: #7c8698;
        font-size: 1.15rem;
        line-height: 1.55;
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
Write-File 'src/components/shared/nlb/proposal-stream.ts' $streamSrc
Write-File 'src/pages/matches-pro/matches-pro.tsx'        $pageSrc
Write-File 'src/pages/matches-pro/matches-pro.scss'       $stylesSrc

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
git commit -m "Matches Pro: live proposal stream for instant buys and real payout"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }
if ($NoPush) { Info 'Push skipped.' } else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}
Write-Host ''
Write-Host 'Done. Hard refresh once Vercel is green.' -ForegroundColor Yellow
