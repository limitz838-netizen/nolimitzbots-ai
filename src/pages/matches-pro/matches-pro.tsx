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
    const { run_panel, transactions, summary_card } = useStore();

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

    const activeAccount = React.useMemo(
        () => (accountList || []).find(a => a.loginid === activeLoginid),
        [accountList, activeLoginid]
    );
    const currency = activeAccount?.currency || 'USD';
    const accountBalance = Number(activeAccount?.balance);

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
                    onContract: contract => {
                        // Matches Pro lives outside the Bot Builder route. Mirror every
                        // open-contract update into the same stores used by Bot Builder,
                        // so Summary and Transactions stay live even if its event
                        // listeners are not mounted on this route.
                        try {
                            transactions?.onBotContractEvent?.(contract);
                            summary_card?.onBotContractEvent?.(contract);
                        } catch {
                            /* display mirroring must never interrupt execution */
                        }
                    },
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
        [currency, refreshDay, transactions, summary_card]
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
                // First settle the prediction that was made BEFORE this tick.
                // step() then creates the next prediction from the history that
                // existed before this tick, preventing current-tick leakage.
                step(symbol, digit, Date.now());
                digits_ref.current = [...digits_ref.current, digit].slice(-HISTORY);
                setDigits(digits_ref.current);
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

    // Give a Matches Auto Trader session the same run identity/state as Bot Builder.
    // Contracts themselves are mirrored into its Summary/Transactions stores above.
    React.useEffect(() => {
        try {
            if (auto) {
                run_panel.run_id = `matches-pro-${Date.now()}`;
                run_panel?.setIsRunning?.(true);
                run_panel?.setHasOpenContract?.(open_ref.current.size > 0);
                run_panel?.toggleDrawer?.(true);
            } else {
                run_panel?.setIsRunning?.(false);
                if (open_ref.current.size === 0) run_panel?.setHasOpenContract?.(false);
            }
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

    const runAnalysis = () => {
        const next = predict(digits_ref.current, { payout: payout_ref.current });
        setPrediction(next);
        if (next?.predictedDigit === null || next?.predictedDigit === undefined) {
            setAnalysis(null);
            setError(next?.reason || 'NO PREDICTION — no validated edge detected.');
            return;
        }
        setError('');
        setAnalysis({
            symbol,
            digit: next.predictedDigit,
            sampleSize: next.sampleSize,
            createdAt: Date.now(),
        });
    };

    const predictionHistory = stats?.state?.recent?.slice(-10).reverse() || [];

    return (
        <div className='matches-pro matches-pro--v2'>
            <div className='matches-pro__panel matches-pro__panel--v2'>
                <div className='matches-pro__v2-head'>
                    <div>
                        <div className='matches-pro__eyebrow'>NOLIMITZ AI</div>
                        <div className='matches-pro__title'>MATCHES PRO V2</div>
                        <div className='matches-pro__subtitle'>
                            Live last-digit prediction analysis for Deriv Matches contracts.
                        </div>
                    </div>
                    <div className={`matches-pro__status matches-pro__status--${status}`}>
                        <i className='matches-pro__dot' />
                        {status_text}
                    </div>
                </div>

                {error && <div className='matches-pro__warn'>{error}</div>}

                <section className='matches-pro__v2-card matches-pro__v2-card--analyser'>
                    <div className='matches-pro__v2-section-head'>
                        <div>
                            <span className='matches-pro__v2-step'>01</span>
                            <h2>Prediction Analyzer</h2>
                            <p>Uses real Deriv tick history. Tap Analyze to generate one last-digit prediction.</p>
                        </div>
                    </div>

                    <div className='matches-pro__v2-controls'>
                        <label className='matches-pro__field'>
                            <span>Market</span>
                            <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                                {symbols.map(s => (
                                    <option key={s.code} value={s.code}>{s.label}</option>
                                ))}
                            </select>
                        </label>
                        <div className='matches-pro__v2-live'>
                            <span>Live tick</span>
                            <strong>{quote ?? '-'}</strong>
                            <small>Last digit {current_digit ?? '-'}</small>
                        </div>
                        <div className='matches-pro__v2-live'>
                            <span>Real tick history</span>
                            <strong>{digits.length}</strong>
                            <small>{marketLabel}</small>
                        </div>
                    </div>

                    <button
                        type='button'
                        className='matches-pro__analyse-btn matches-pro__analyse-btn--primary'
                        disabled={status !== TICK_STATUS.LIVE || digits.length < 100}
                        onClick={runAnalysis}
                    >
                        ANALYZE LAST DIGIT
                    </button>

                    <div className='matches-pro__prediction-result'>
                        <span className='matches-pro__prediction-label'>PREDICTED LAST DIGIT</span>
                        <strong>{analysis?.digit ?? '-'}</strong>
                        <p>
                            {analysis
                                ? `Prediction generated from ${analysis.sampleSize} real Deriv ticks. This is a model prediction, not a guaranteed outcome.`
                                : status === TICK_STATUS.LIVE
                                  ? 'Ready. Tap Analyze when you want a new prediction.'
                                  : 'Connecting to the Deriv tick stream...'}
                        </p>
                    </div>

                    <div className='matches-pro__truth-grid'>
                        <div><span>Verified predictions</span><strong>{stats?.summary?.n ?? 0}</strong></div>
                        <div><span>Correct</span><strong>{stats?.summary?.k ?? 0}</strong></div>
                        <div>
                            <span>Measured accuracy</span>
                            <strong>{stats?.summary?.n ? pct(stats.summary.accuracy) : '-'}</strong>
                        </div>
                        <div><span>Random baseline</span><strong>10.00%</strong></div>
                        <div><span>Selected model</span><strong>{prediction?.selectedModel || '-'}</strong></div>
                        <div><span>Walk-forward rate</span><strong>{prediction?.modelResults?.[0]?.trials ? pct(prediction.modelResults[0].accuracy) : '-'}</strong></div>
                        <div><span>Break-even</span><strong>{prediction?.breakeven ? pct(prediction.breakeven) : '-'}</strong></div>
                        <div><span>Decision</span><strong>{prediction?.predictedDigit === null ? 'NO PREDICTION' : 'PREDICT'}</strong></div>
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Walk-forward model comparison</div>
                        {prediction?.modelResults?.map(model => (
                            <div key={model.id} className='matches-pro__verify-row'>
                                <span><b>{model.id}</b></span>
                                <span>{model.hits}/{model.trials} correct</span>
                                <strong>{model.trials ? pct(model.accuracy) : '-'}</strong>
                            </div>
                        ))}
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Recent verified predictions</div>
                        {predictionHistory.length ? predictionHistory.map((item, i) => (
                            <div key={`${item.t}-${i}`} className={`matches-pro__verify-row ${item.hit ? 'hit' : 'miss'}`}>
                                <span>Predicted <b>{item.predicted}</b></span>
                                <span>Actual <b>{item.actual}</b></span>
                                <strong>{item.hit ? 'CORRECT' : 'MISS'}</strong>
                            </div>
                        )) : <div className='matches-pro__muted'>Waiting for verified live predictions...</div>}
                    </div>
                </section>

                <section className='matches-pro__v2-card'>
                    <div className='matches-pro__v2-section-head'>
                        <div>
                            <span className='matches-pro__v2-step'>02</span>
                            <h2>Matches Auto Trader</h2>
                            <p>Automatically buys a 1-tick DIGITMATCH contract only when the existing risk gate allows it.</p>
                        </div>
                        <div className={`matches-pro__account-pill ${is_demo ? 'demo' : 'blocked'}`}>
                            {activeLoginid ? (is_demo ? 'DEMO ACCOUNT' : 'REAL BLOCKED') : 'NOT SIGNED IN'}
                        </div>
                    </div>

                    <div className='matches-pro__v2-controls matches-pro__v2-controls--trade'>
                        <label className='matches-pro__field'>
                            <span>Stake ({currency})</span>
                            <input
                                type='number'
                                step='0.05'
                                min='0.35'
                                value={limits.stake}
                                onChange={e => setLimit('stake', e.target.value)}
                            />
                        </label>
                        <label className='matches-pro__field'>
                            <span>Maximum trades</span>
                            <input
                                type='number'
                                step='1'
                                min='1'
                                value={limits.max_trades}
                                onChange={e => setLimit('max_trades', e.target.value)}
                            />
                        </label>
                        <label className='matches-pro__field'>
                            <span>Stop after profit</span>
                            <input
                                type='number'
                                step='0.5'
                                min='0.5'
                                value={limits.daily_profit_target}
                                onChange={e => setLimit('daily_profit_target', e.target.value)}
                            />
                        </label>
                        <label className='matches-pro__field'>
                            <span>Stop after loss</span>
                            <input
                                type='number'
                                step='0.5'
                                min='0.5'
                                value={limits.daily_loss_limit}
                                onChange={e => setLimit('daily_loss_limit', e.target.value)}
                            />
                        </label>
                    </div>

                    <div className='matches-pro__auto-pick'>
                        <span>Current model pick</span>
                        <strong>{predicted ?? '-'}</strong>
                        <small>{quality === 'NO SIGNAL' ? 'NO TRADE - waiting for a valid prediction' : `${quality} signal`}</small>
                    </div>

                    <div className='matches-pro__locks'>
                        <div className={`matches-pro__lock ${isAuthorized ? 'ok' : 'bad'}`}>
                            {isAuthorized ? 'Deriv connected' : 'Connect Deriv'}
                        </div>
                        <div className={`matches-pro__lock ${is_demo ? 'ok' : 'bad'}`}>
                            {is_demo ? 'Demo execution enabled' : 'Demo account required'}
                        </div>
                        <div className={`matches-pro__lock ${unlocked ? 'ok' : 'bad'}`}>
                            Verified evidence {evidence}/{MIN_EVIDENCE}
                        </div>
                    </div>

                    <button
                        type='button'
                        className={`matches-pro__auto matches-pro__auto--v2 ${auto ? 'on' : ''}`}
                        disabled={!can_arm}
                        onClick={() => setAuto(v => !v)}
                    >
                        {auto ? 'STOP AUTO TRADER' : 'START AUTO TRADER'}
                    </button>
                    <div className={`matches-pro__gate ${gate.allowed ? 'ok' : ''}`}>{gate.reason}</div>

                    <div className='matches-pro__truth-grid matches-pro__truth-grid--trading'>
                        <div><span>Trades today</span><strong>{day.trades.length}</strong></div>
                        <div><span>Wins / losses</span><strong>{day.wins}/{day.losses}</strong></div>
                        <div>
                            <span>Trade hit rate</span>
                            <strong>{day.trades.length ? `${((day.wins / day.trades.length) * 100).toFixed(1)}%` : '-'}</strong>
                        </div>
                        <div>
                            <span>Session P/L</span>
                            <strong className={day.pl >= 0 ? 'pos' : 'neg'}>{day.pl >= 0 ? '+' : ''}{day.pl.toFixed(2)} {currency}</strong>
                        </div>
                    </div>

                    <div className='matches-pro__v2-safety'>
                        Auto trading remains demo-only while we validate the measured prediction record. The execution layer still blocks real accounts.
                    </div>
                </section>
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