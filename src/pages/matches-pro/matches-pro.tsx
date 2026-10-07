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
import { record, read, reset, summarise, setupStats, topSetups } from '@/components/shared/nlb/backtest-store';
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
const MIN_SETUP_EVIDENCE = 30;
const SETUP_EDGE_MARGIN = 0.005;

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
    const [executionTesting, setExecutionTesting] = React.useState(false);
    const [executionTestResult, setExecutionTestResult] = React.useState('');
    const [sessionResult, setSessionResult] = React.useState(null);
    const [sessionStats, setSessionStats] = React.useState({ trades: 0, wins: 0, losses: 0, pnl: 0 });
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
    const payout_by_digit_ref = React.useRef({});
    const last_shadow_fingerprint_ref = React.useRef(null);
    const session_stats_ref = React.useRef({ trades: 0, wins: 0, losses: 0, pnl: 0 });

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

    const calibratePrediction = React.useCallback((raw, state) => {
        if (!raw) return raw;
        if (!raw.fingerprint || raw.candidateDigit === null || raw.candidateDigit === undefined) {
            return {
                ...raw,
                predictedDigit: null,
                signalQuality: 'NO SIGNAL',
                liveCalibration: { n: 0, correct: 0, accuracy: 0, lowerBound: 0, tradeReady: false },
            };
        }

        const setup = setupStats(state, raw.fingerprint);
        const required = Number(raw.breakeven || 0.1) + SETUP_EDGE_MARGIN;
        const enough = setup.n >= MIN_SETUP_EVIDENCE;
        const tradeReady = enough && setup.lowerBound > required;

        let reason = raw.reason;
        if (!enough) {
            reason = `Shadow testing setup: ${setup.n}/${MIN_SETUP_EVIDENCE} independent forward results collected for this exact fingerprint.`;
        } else if (!tradeReady) {
            reason = `No trade: this exact setup's lower-bound accuracy is ${(setup.lowerBound * 100).toFixed(2)}%; it must exceed ${(required * 100).toFixed(2)}% for this digit's current payout.`;
        } else {
            reason = `TRADE CANDIDATE: exact setup has ${setup.correct}/${setup.n} correct, ${(setup.accuracy * 100).toFixed(2)}% raw accuracy and ${(setup.lowerBound * 100).toFixed(2)}% lower-bound accuracy versus ${(required * 100).toFixed(2)}% required.`;
        }

        return {
            ...raw,
            predictedDigit: tradeReady ? raw.candidateDigit : null,
            signalQuality: tradeReady ? 'STRONG' : 'NO SIGNAL',
            reason,
            liveCalibration: { ...setup, required, tradeReady },
        };
    }, []);

    const resetV2Evidence = React.useCallback(() => {
        // Only reset measured prediction/analyse evidence for the selected
        // market. Trading limits and account settings are intentionally kept.
        reset(symbol);
        resetAnalyse(symbol);
        pending_ref.current = null;
        last_shadow_fingerprint_ref.current = null;
        analysis_ref.current = null;
        setFeed([]);
        setAnalysis(null);
        setPrediction(null);
        const clean = refreshStats(symbol);
        setAnalyseStats(summariseAnalyse(readAnalyse(symbol)));

        // Seed a fresh next-tick prediction from the currently visible history.
        // It is not counted until a future real tick arrives.
        if (digits_ref.current.length) {
            const raw = predict(digits_ref.current, { payout: payout_ref.current, payoutByDigit: payout_by_digit_ref.current });
            const seeded = calibratePrediction(raw, clean);
            setPrediction(seeded);
            if (seeded.fingerprint && seeded.candidateDigit !== null) {
                last_shadow_fingerprint_ref.current = seeded.fingerprint;
                pending_ref.current = {
                    symbol,
                    predicted: seeded.candidateDigit,
                    quality: seeded.signalQuality,
                    score: seeded.score,
                    model: seeded.selectedModel,
                    engineVersion: seeded.engineVersion,
                    tradable: seeded.predictedDigit !== null,
                    fingerprint: seeded.fingerprint,
                    agreementTier: seeded.agreementTier,
                    agreementModels: seeded.agreementModels,
                };
            }

        }

        setError('');
        return clean;
    }, [symbol, refreshStats, calibratePrediction]);

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
                cooldown_ref.current = 0;

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

                        const updatedDay = recordTrade(sym, {
                            t: Date.now(),
                            contract_id,
                            symbol: sym,
                            predicted: digit,
                            stake,
                            payout: win_payout,
                            profit,
                        });
                        setDay(updatedDay);

                        const s = session_stats_ref.current;
                        s.trades += 1;
                        s.pnl = Number((s.pnl + profit).toFixed(4));
                        if (profit > 0) s.wins += 1;
                        else s.losses += 1;
                        setSessionStats({ ...s });

                        const tp = Math.abs(Number(limits_ref.current.daily_profit_target) || 0);
                        const sl = Math.abs(Number(limits_ref.current.daily_loss_limit) || 0);
                        const hitTp = tp > 0 && s.pnl >= tp;
                        const hitSl = sl > 0 && s.pnl <= -sl;

                        if (auto_ref.current && (hitTp || hitSl)) {
                            auto_ref.current = false;
                            setAuto(false);
                            setGate({
                                allowed: false,
                                reason: hitTp ? 'Take profit reached' : 'Stop loss reached',
                            });
                            setSessionResult({
                                type: hitTp ? 'tp' : 'sl',
                                pnl: s.pnl,
                                trades: s.trades,
                                wins: s.wins,
                                losses: s.losses,
                                target: hitTp ? tp : sl,
                            });
                        }
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


    const testDemoExecution = React.useCallback(async () => {
        if (executionTesting) return;

        if (!isAuthorized) {
            setExecutionTestResult('TEST FAILED — Deriv trading connection is not authorized.');
            return;
        }
        if (!is_demo) {
            setExecutionTestResult('TEST BLOCKED — switch to a Deriv demo account.');
            return;
        }
        if (!api_base?.api) {
            setExecutionTestResult('TEST FAILED — trading connection is not ready yet.');
            return;
        }

        const testDigit =
            prediction?.candidateDigit ??
            (digits_ref.current.length ? digits_ref.current[digits_ref.current.length - 1] : null);

        if (testDigit === null || testDigit === undefined) {
            setExecutionTestResult('TEST FAILED — waiting for a live digit first.');
            return;
        }

        const stake = Math.max(0.35, Number(limits_ref.current.stake) || 0.35);
        setExecutionTesting(true);
        setExecutionTestResult('Preparing one live demo DIGITMATCH proposal…');
        setError('');

        try {
            run_panel.run_id = 'matches-pro-test-' + Date.now();
            summary_card?.clear?.();
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);

            const response = await api_base.api.send({
                proposal: 1,
                amount: stake,
                basis: 'stake',
                contract_type: 'DIGITMATCH',
                currency,
                duration: 1,
                duration_unit: 't',
                underlying_symbol: symbol,
                barrier: String(testDigit),
            });

            const proposal = response?.proposal;
            if (!proposal?.id) throw new Error('No proposal returned');

            setExecutionTestResult('Proposal accepted. Sending one demo buy…');

            const bought = await api_base.api.send({
                buy: proposal.id,
                price: Number(proposal.ask_price),
            });

            const contract_id = bought?.buy?.contract_id;
            if (!contract_id) throw new Error('Buy did not return a contract');

            setExecutionTestResult('BOUGHT demo contract ' + contract_id + ' · waiting for settlement.');

            const tracker = trackContracts([contract_id], {
                timeoutMs: 60000,
                onContract: contract => {
                    try {
                        transactions?.onBotContractEvent?.(contract);
                        summary_card?.onBotContractEvent?.(contract);
                        run_panel?.onBotContractEvent?.(contract);
                    } catch {
                        /* display mirroring must never interrupt execution */
                    }
                },
                onDone: ({ profits, settled }) => {
                    const profit = Number(Object.values(profits)[0] ?? 0);
                    setExecutionTestResult(
                        settled > 0
                            ? 'TEST PASSED — contract settled ' +
                              (profit >= 0 ? '+' : '') +
                              profit.toFixed(2) +
                              ' ' +
                              currency +
                              '. Normal Matches Pro evidence gates remain unchanged.'
                            : 'TEST FAILED — contract did not settle before timeout.'
                    );
                    setExecutionTesting(false);
                    try {
                        run_panel?.setIsRunning?.(false);
                    } catch {
                        /* noop */
                    }
                },
            });

            trackers_ref.current.push(tracker);
        } catch (e) {
            const message = describeError(e);
            setExecutionTestResult('TEST FAILED — ' + message);
            setError(message);
            setExecutionTesting(false);
            try {
                run_panel?.setIsRunning?.(false);
            } catch {
                /* noop */
            }
        }
    }, [
        executionTesting,
        isAuthorized,
        is_demo,
        prediction,
        currency,
        symbol,
        run_panel,
        transactions,
        summary_card,
    ]);

    // ------------------------------------------------------------- per tick
    const step = React.useCallback(
        (sym, actual_digit, ts, already_graded = false) => {
            if (cooldown_ref.current > 0) cooldown_ref.current -= 1;

            const pending = pending_ref.current;
            if (!already_graded && pending && pending.predicted !== null && pending.symbol === sym) {
                record(sym, {
                    t: ts,
                    predicted: pending.predicted,
                    actual: actual_digit,
                    quality: pending.quality,
                    score: pending.score,
                    model: pending.model,
                    engineVersion: pending.engineVersion,
                    tradable: pending.tradable,
                    fingerprint: pending.fingerprint,
                    agreementTier: pending.agreementTier,
                    agreementModels: pending.agreementModels,
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

            const rawNext = predict(digits_ref.current, { payout: payout_ref.current, payoutByDigit: payout_by_digit_ref.current });
            const state = refreshStats(sym);
            const next = calibratePrediction(rawNext, state);
            setPrediction(next);

            // Count a fingerprint only once while it remains unchanged.
            // A materially different setup (digit/models/tier/strength/previous digit)
            // can create a new independent shadow observation.
            if (next.fingerprint && next.candidateDigit !== null) {
                if (next.fingerprint !== last_shadow_fingerprint_ref.current) {
                    last_shadow_fingerprint_ref.current = next.fingerprint;
                    pending_ref.current = {
                        symbol: sym,
                        predicted: next.candidateDigit,
                        quality: next.signalQuality,
                        score: next.score,
                        model: next.selectedModel,
                        engineVersion: next.engineVersion,
                        tradable: next.predictedDigit !== null,
                        fingerprint: next.fingerprint,
                        agreementTier: next.agreementTier,
                        agreementModels: next.agreementModels,
                    };
                } else {
                    pending_ref.current = null;
                }
            } else {
                last_shadow_fingerprint_ref.current = null;
                pending_ref.current = null;
            }

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
                session_pl: session_stats_ref.current.pnl,
                stop_mode: 'targets',
            });
            setGate(decision);

            if (decision.allowed && next.predictedDigit !== null) {
                fireTrade(sym, next.predictedDigit);
            }
        },
        [refreshStats, isAuthorized, activeLoginid, fireTrade, calibratePrediction]
    );

    React.useEffect(() => {
        digits_ref.current = [];
        pending_ref.current = null;
        last_shadow_fingerprint_ref.current = null;
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
                const rawSeeded = predict(digits_ref.current, { payout: payout_ref.current, payoutByDigit: payout_by_digit_ref.current });
                const currentState = read(symbol);
                const seeded = calibratePrediction(rawSeeded, currentState);
                setPrediction(seeded);
                if (seeded.fingerprint && seeded.candidateDigit !== null) {
                    last_shadow_fingerprint_ref.current = seeded.fingerprint;
                    pending_ref.current = {
                        symbol,
                        predicted: seeded.candidateDigit,
                        quality: seeded.signalQuality,
                        score: seeded.score,
                        model: seeded.selectedModel,
                        engineVersion: seeded.engineVersion,
                        tradable: seeded.predictedDigit !== null,
                        fingerprint: seeded.fingerprint,
                        agreementTier: seeded.agreementTier,
                        agreementModels: seeded.agreementModels,
                    };
                }
            },
            onTick: ({ digit, quote: q, decimals: dec }) => {
                setDecimals(dec);
                setQuote(q);

                // The pending prediction was created before this tick, so it is
                // safe to grade it against the arriving digit. Then include the
                // now-known tick in history before creating the prediction for
                // the NEXT tick. That is the correct boundary for a 1-tick contract.
                const pendingBeforeTick = pending_ref.current;
                if (pendingBeforeTick && pendingBeforeTick.predicted !== null && pendingBeforeTick.symbol === symbol) {
                    record(symbol, {
                        t: Date.now(),
                        predicted: pendingBeforeTick.predicted,
                        actual: digit,
                        quality: pendingBeforeTick.quality,
                        score: pendingBeforeTick.score,
                        model: pendingBeforeTick.model,
                        engineVersion: pendingBeforeTick.engineVersion,
                        tradable: pendingBeforeTick.tradable,
                        fingerprint: pendingBeforeTick.fingerprint,
                        agreementTier: pendingBeforeTick.agreementTier,
                        agreementModels: pendingBeforeTick.agreementModels,
                    });
                }
                pending_ref.current = null;

                digits_ref.current = [...digits_ref.current, digit].slice(-HISTORY);
                setDigits(digits_ref.current);
                step(symbol, digit, Date.now(), true);
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
    }, [symbol, step, refreshStats, refreshDay, calibratePrediction]);

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
        payout_by_digit_ref.current = {};

        if (!isAuthorized || !activeLoginid) return undefined;
        const stake = Number(limits.stake);
        if (!(stake > 0)) return undefined;

        let handle = null;
        try {
            handle = startProposals({
                symbol,
                currency,
                amount: stake,
                onUpdate: ({ multiplier, latest }) => {
                    if (latest) {
                        const exact = {};
                        Object.entries(latest).forEach(([digit, proposal]) => {
                            const ask = Number(proposal?.ask);
                            const winPayout = Number(proposal?.payout);
                            if (ask > 0 && winPayout > 0) exact[Number(digit)] = winPayout / ask;
                        });
                        payout_by_digit_ref.current = exact;
                    }
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
        const next = predict(digits_ref.current, { payout: payout_ref.current, payoutByDigit: payout_by_digit_ref.current });
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

    const toggleAutoSession = () => {
        if (auto) {
            auto_ref.current = false;
            setAuto(false);
            setGate({ allowed: false, reason: 'Auto trade stopped by user' });
            return;
        }

        const fresh = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        session_stats_ref.current = fresh;
        setSessionStats(fresh);
        setSessionResult(null);
        setExecutionTestResult('');
        cooldown_ref.current = 0;
        auto_ref.current = true;
        setAuto(true);
        setGate({ allowed: true, reason: 'Running until take profit or stop loss is reached' });
    };

    const marketLabel = React.useMemo(
        () => symbols.find(s => s.code === symbol)?.label || symbol,
        [symbols, symbol]
    );

    const runAnalysis = () => {
        const rawNext = predict(digits_ref.current, { payout: payout_ref.current, payoutByDigit: payout_by_digit_ref.current });
        const next = calibratePrediction(rawNext, read(symbol));
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
    const predictionDistribution = React.useMemo(
        () => (stats?.state?.by_digit || []).map((row, digit) => ({ digit, n: row?.n || 0, correct: row?.correct || 0 })),
        [stats]
    );
    const modelUsage = React.useMemo(
        () => Object.entries(stats?.state?.by_model || {}).map(([model, row]) => ({
            model,
            n: row?.n || 0,
            correct: row?.correct || 0,
        })),
        [stats]
    );
    const setupLeaderboard = React.useMemo(() => topSetups(stats?.state, 8), [stats]);
    const tierStats = React.useMemo(
        () => Object.entries(stats?.state?.by_tier || {}).map(([tier, row]) => ({
            tier: Number(tier),
            n: row?.n || 0,
            correct: row?.correct || 0,
            accuracy: row?.n ? row.correct / row.n : 0,
        })).sort((a, b) => b.tier - a.tier),
        [stats]
    );

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
                        <div><span>Engine</span><strong>{prediction?.engineVersion || '-'}</strong></div>
                        <div><span>Consensus rate</span><strong>{prediction?.consensus?.trials ? pct(prediction.consensus.accuracy) : '-'}</strong></div>
                        <div><span>Lower bound</span><strong>{prediction?.consensus?.trials ? pct(prediction.consensus.lowerBound) : '-'}</strong></div>
                        <div><span>Exact digit break-even</span><strong>{prediction?.breakeven ? pct(prediction.breakeven) : '-'}</strong></div>
                        <div><span>Consensus trials</span><strong>{prediction?.consensus?.trials ?? 0}</strong></div>
                        <div><span>Consensus coverage</span><strong>{prediction?.consensus ? pct(prediction.consensus.coverage) : '-'}</strong></div>
                        <div><span>Candidate digit</span><strong>{prediction?.candidateDigit ?? '-'}</strong></div>
                        <div><span>Agreement tier</span><strong>{prediction?.agreementTier ? `${prediction.agreementTier}-model` : '-'}</strong></div>
                        <div><span>Exact setup sample</span><strong>{prediction?.liveCalibration?.n ?? 0}/{MIN_SETUP_EVIDENCE}</strong></div>
                        <div><span>Setup lower bound</span><strong>{prediction?.liveCalibration?.n ? pct(prediction.liveCalibration.lowerBound) : '-'}</strong></div>
                        <div><span>Decision</span><strong>{prediction?.liveCalibration?.tradeReady ? 'TRADE CANDIDATE' : 'SHADOW ONLY'}</strong></div>
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
                        <div className='matches-pro__v2-subtitle'>Evidence controls</div>
                        <div className='matches-pro__verify-row'>
                            <span>Clear current engine evidence for this market and begin a fresh forward test.</span>
                            <span>Trading limits are kept.</span>
                            <button type='button' className='matches-pro__secondary' onClick={resetV2Evidence}>
                                RESET FRESH EVIDENCE
                            </button>
                        </div>
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Live Matches model votes</div>
                        {prediction?.liveVotes?.length ? prediction.liveVotes.map(vote => (
                            <div key={vote.model} className={`matches-pro__verify-row ${vote.agrees ? 'hit' : ''}`}>
                                <span><b>{vote.model}</b></span>
                                <span>Next digit <b>{vote.digit ?? '-'}</b></span>
                                <strong>{vote.agrees ? 'AGREES' : '—'}</strong>
                            </div>
                        )) : <div className='matches-pro__muted'>Waiting for model votes...</div>}
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Agreement-tier forward results</div>
                        {tierStats.length ? tierStats.map(row => (
                            <div key={row.tier} className='matches-pro__verify-row'>
                                <span><b>{row.tier}-model agreement</b></span>
                                <span>{row.correct}/{row.n} correct</span>
                                <strong>{row.n ? pct(row.accuracy) : '-'}</strong>
                            </div>
                        )) : <div className='matches-pro__muted'>Collecting independent agreement-tier evidence...</div>}
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Exact setup calibration</div>
                        {setupLeaderboard.length ? setupLeaderboard.map(row => (
                            <div key={row.fingerprint} className='matches-pro__setup-row'>
                                <div>
                                    <strong>Digit {row.digit} · {row.tier}-model</strong>
                                    <small>{(row.models || []).join(' + ') || 'unknown models'}</small>
                                </div>
                                <span>{row.correct}/{row.n}</span>
                                <span>{pct(row.accuracy)}</span>
                                <span>LB {pct(row.lowerBound)}</span>
                            </div>
                        )) : <div className='matches-pro__muted'>No independent setup fingerprints graded yet.</div>}
                    </div>

                    <div className='matches-pro__verification'>
                        <div className='matches-pro__v2-subtitle'>Fresh prediction distribution</div>
                        <div className='matches-pro__digit-diagnostics'>
                            {predictionDistribution.map(row => (
                                <div key={row.digit} className='matches-pro__digit-diagnostic'>
                                    <strong>{row.digit}</strong>
                                    <span>{row.n} picks</span>
                                    <small>{row.n ? `${((row.correct / row.n) * 100).toFixed(1)}% hit` : '—'}</small>
                                </div>
                            ))}
                        </div>
                        {modelUsage.length > 0 && (
                            <div className='matches-pro__model-usage'>
                                {modelUsage.map(row => (
                                    <span key={row.model}>{row.model}: {row.n} emitted / {row.correct} correct</span>
                                ))}
                            </div>
                        )}
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
                        className='matches-pro__auto matches-pro__auto--v2 matches-pro__auto--test'
                        disabled={!isAuthorized || !is_demo || executionTesting || auto}
                        onClick={testDemoExecution}
                    >
                        {executionTesting ? 'TESTING DEMO EXECUTION…' : 'TEST 1 DEMO MATCH CONTRACT'}
                    </button>
                    {executionTestResult && (
                        <div className='matches-pro__gate'>{executionTestResult}</div>
                    )}

                    <button
                        type='button'
                        className={`matches-pro__auto matches-pro__auto--v2 ${auto ? 'on' : ''}`}
                        disabled={!can_arm || executionTesting}
                        onClick={toggleAutoSession}
                    >
                        {auto ? 'STOP AUTO TRADER' : 'START AUTO TRADER'}
                    </button>
                    <div className={`matches-pro__gate ${gate.allowed ? 'ok' : ''}`}>{gate.reason}</div>

                    <div className='matches-pro__truth-grid matches-pro__truth-grid--trading'>
                        <div><span>Session trades</span><strong>{sessionStats.trades}</strong></div>
                        <div><span>Wins / losses</span><strong>{sessionStats.wins}/{sessionStats.losses}</strong></div>
                        <div>
                            <span>Trade hit rate</span>
                            <strong>{sessionStats.trades ? `${((sessionStats.wins / sessionStats.trades) * 100).toFixed(1)}%` : '-'}</strong>
                        </div>
                        <div>
                            <span>Session P/L</span>
                            <strong className={sessionStats.pnl >= 0 ? 'pos' : 'neg'}>{sessionStats.pnl >= 0 ? '+' : ''}{sessionStats.pnl.toFixed(2)} {currency}</strong>
                        </div>
                    </div>

                    <div className='matches-pro__v2-safety'>
                        Auto trading remains demo-only while validation is active. Once started, Matches Pro keeps taking eligible 1-tick contracts until your Take Profit or Stop Loss is reached.
                    </div>
                </section>
            </div>

            {sessionResult && (
                <div className='matches-pro__target-overlay' role='dialog' aria-modal='true'>
                    <div className={`matches-pro__target-popup ${sessionResult.type}`}>
                        <button type='button' onClick={() => setSessionResult(null)}>×</button>
                        <div className='matches-pro__target-kicker'>
                            {sessionResult.type === 'tp' ? 'TAKE PROFIT REACHED' : 'STOP LOSS REACHED'}
                        </div>
                        <h3>
                            {sessionResult.pnl >= 0 ? '+' : ''}{sessionResult.pnl.toFixed(2)} {currency}
                        </h3>
                        <p>
                            {sessionResult.type === 'tp'
                                ? `Profit target of ${sessionResult.target.toFixed(2)} ${currency} reached. Auto trading stopped.`
                                : `Stop loss of ${sessionResult.target.toFixed(2)} ${currency} reached. Auto trading stopped.`}
                        </p>
                        <div className='matches-pro__target-stats'>
                            <span>Trades <b>{sessionResult.trades}</b></span>
                            <span>Wins <b>{sessionResult.wins}</b></span>
                            <span>Losses <b>{sessionResult.losses}</b></span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const MatchesProPage = () => (
    <PageBoundary name='Matches Pro'>
        <MatchesPro />
    </PageBoundary>
);

export default MatchesProPage;