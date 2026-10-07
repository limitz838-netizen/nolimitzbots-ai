// @ts-nocheck — Nolimitz AI market scanner for Bulk Trader.
//
// The scanner does not invent an "AI edge". It:
//   1. keeps real Deriv digit history for every supported volatility market,
//   2. evaluates practical 1-tick Over/Under contracts on a fixed evidence window,
//   3. asks Deriv for the CURRENT proposal/payout on each market's strongest setup,
//   4. computes observed edge = measured hit-rate - live break-even,
//   5. auto-fires only when the sample also passes a confidence check.
//
// This is still statistical evidence, not a guarantee. Synthetic ticks may be
// independent and an observed historical edge can disappear immediately.
import React from 'react';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './ai-scanner.scss';

const SCAN_MARKETS = [
    { code: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { code: '1HZ10V', label: 'Volatility 10 (1s) Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
    { code: 'R_100', label: 'Volatility 100 Index' },
];

const FALLBACK_DECIMALS = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
    '1HZ10V': 2,
    '1HZ25V': 2,
    '1HZ50V': 2,
    '1HZ75V': 2,
    '1HZ100V': 2,
};

const CANDIDATES = [
    { type: 'DIGITOVER', barrier: 2, label: 'OVER 2', theoretical: 0.7 },
    { type: 'DIGITOVER', barrier: 3, label: 'OVER 3', theoretical: 0.6 },
    { type: 'DIGITOVER', barrier: 4, label: 'OVER 4', theoretical: 0.5 },
    { type: 'DIGITUNDER', barrier: 5, label: 'UNDER 5', theoretical: 0.5 },
    { type: 'DIGITUNDER', barrier: 6, label: 'UNDER 6', theoretical: 0.6 },
    { type: 'DIGITUNDER', barrier: 7, label: 'UNDER 7', theoretical: 0.7 },
];

const HISTORY_COUNT = 1000;
const EVIDENCE_WINDOW = 600;
const MIN_SAMPLE = 400;
const MIN_OBSERVED_EDGE = 0.01; // at least +1.00 percentage point over live break-even
const EVALUATE_EVERY_MS = 2200;
const LOG_EVERY_MS = 4200;
const WILSON_Z = 1.282; // one-sided ~90% lower confidence bound

const lastDigit = (q, d) => Number(Number(q).toFixed(d).slice(-1));

const candidateWins = (candidate, digit) =>
    candidate.type === 'DIGITOVER' ? digit > candidate.barrier : digit < candidate.barrier;

const wilsonLower = (hits, trials, z = WILSON_Z) => {
    if (!trials) return 0;
    const p = hits / trials;
    const z2 = z * z;
    const den = 1 + z2 / trials;
    const centre = p + z2 / (2 * trials);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
    return Math.max(0, (centre - spread) / den);
};

const localStats = (digits, candidate) => {
    const sample = (digits || []).slice(-EVIDENCE_WINDOW);
    const n = sample.length;
    if (!n) {
        return {
            ...candidate,
            n: 0,
            hits: 0,
            hitRate: 0,
            lowerBound: 0,
            deviation: -1,
        };
    }
    const hits = sample.reduce((sum, digit) => sum + (candidateWins(candidate, digit) ? 1 : 0), 0);
    const hitRate = hits / n;
    return {
        ...candidate,
        n,
        hits,
        hitRate,
        lowerBound: wilsonLower(hits, n),
        deviation: hitRate - candidate.theoretical,
    };
};

const bestLocalCandidate = digits =>
    CANDIDATES.map(candidate => localStats(digits, candidate)).sort(
        (a, b) => b.deviation - a.deviation || b.lowerBound - a.lowerBound
    )[0] || null;

const pct = value => (Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—');

const withTimeout = (promise, ms, label) =>
    Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
        ),
    ]);

const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));

const AiScanner = ({ open, onClose, stake, count, currency = 'USD', isLoggedIn = false }) => {
    const { run_panel, transactions, summary_card } = useStore();

    const [phase, setPhase] = React.useState('idle'); // idle | scanning | firing | settling | done
    const [scannerStake, setScannerStake] = React.useState(String(stake ?? '0.5'));
    const [scannerCount, setScannerCount] = React.useState(Math.max(1, Math.min(20, Number(count) || 5)));
    const [logs, setLogs] = React.useState([]);
    const [matrix, setMatrix] = React.useState({});
    const [status, setStatus] = React.useState('Ready to scan all supported volatility markets.');
    const [match, setMatch] = React.useState(null);
    const [fireLog, setFireLog] = React.useState([]);
    const [settle, setSettle] = React.useState(null);
    const [batchResult, setBatchResult] = React.useState(null);
    const [scanSummary, setScanSummary] = React.useState({
        marketsReady: 0,
        bestEdge: null,
        evaluations: 0,
    });

    const ws_ref = React.useRef(null);
    const track_ref = React.useRef(null);
    const digits_ref = React.useRef({});
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const armed_ref = React.useRef(false);
    const eval_inflight_ref = React.useRef(false);
    const eval_timer_ref = React.useRef(null);
    const last_eval_ref = React.useRef(0);
    const last_log_ref = React.useRef(0);
    const evaluations_ref = React.useRef(0);
    const cfg_ref = React.useRef({
        stake: scannerStake,
        count: scannerCount,
        currency,
        isLoggedIn,
    });

    cfg_ref.current = {
        stake: scannerStake,
        count: scannerCount,
        currency,
        isLoggedIn,
    };

    const log = line => setLogs(prev => [...prev, line].slice(-80));

    const stopSocket = () => {
        if (eval_timer_ref.current) {
            window.clearTimeout(eval_timer_ref.current);
            eval_timer_ref.current = null;
        }
        try {
            ws_ref.current?.close();
        } catch {
            /* noop */
        }
        ws_ref.current = null;
    };

    const teardown = () => {
        armed_ref.current = false;
        eval_inflight_ref.current = false;
        stopSocket();
    };

    React.useEffect(() => {
        if (open && phase === 'idle') {
            setScannerStake(String(stake ?? '0.5'));
            setScannerCount(Math.max(1, Math.min(20, Number(count) || 5)));
        }

        if (!open) {
            teardown();
            track_ref.current?.cancel();
            track_ref.current = null;
            setPhase('idle');
            setLogs([]);
            setMatrix({});
            setMatch(null);
            setFireLog([]);
            setSettle(null);
            setBatchResult(null);
            setScanSummary({ marketsReady: 0, bestEdge: null, evaluations: 0 });
            setStatus('Ready to scan all supported volatility markets.');
            digits_ref.current = {};
        }
    }, [open]);

    React.useEffect(
        () => () => {
            teardown();
            track_ref.current?.cancel();
        },
        []
    );

    const requestEconomics = async (market, stats) => {
        if (!api_base?.api || !stats) return null;
        const amount = Math.max(0.35, parseFloat(cfg_ref.current.stake) || 0.5);
        const request = {
            proposal: 1,
            amount,
            basis: 'stake',
            contract_type: stats.type,
            currency: cfg_ref.current.currency || 'USD',
            duration: 1,
            duration_unit: 't',
            underlying_symbol: market.code,
            barrier: String(stats.barrier),
        };

        try {
            const response = await api_base.api.send(request);
            const proposal = response?.proposal;
            const ask = Number(proposal?.ask_price ?? amount);
            const payout = Number(proposal?.payout ?? 0);
            if (!(ask > 0) || !(payout > 0)) return null;
            const breakEven = ask / payout;
            return {
                ...stats,
                market,
                proposalId: proposal?.id || null,
                ask,
                payout,
                breakEven,
                observedEdge: stats.hitRate - breakEven,
                confidenceEdge: stats.lowerBound - breakEven,
                qualified:
                    stats.n >= MIN_SAMPLE &&
                    stats.hitRate - breakEven >= MIN_OBSERVED_EDGE &&
                    stats.lowerBound >= stats.theoretical,
            };
        } catch (error) {
            return {
                ...stats,
                market,
                proposalError: describeError(error),
                qualified: false,
            };
        }
    };

    const fireBatch = async candidate => {
        const {
            stake: st,
            count: ct,
            currency: cur,
            isLoggedIn: li,
        } = cfg_ref.current;

        if (!li || !api_base?.api) {
            setPhase('done');
            setStatus(`Best setup found on ${candidate.market.label}, but Deriv is not connected for trading.`);
            return;
        }

        const n = Math.max(1, Math.min(20, parseInt(ct, 10) || 5));
        const amount = Math.max(0.35, parseFloat(st) || 0.5);
        const exposure = amount * n;

        // Scanner mode intentionally uses the user's selected stake × bulk-trade
        // count as the batch size. The manual Bulk Trader's separate exposure
        // ceiling must not silently block scanner execution.
        log(`[READY] Batch total ${cur} ${exposure.toFixed(2)} · ${n} contracts × ${cur} ${amount.toFixed(2)}.`);

        unlockAudio();
        try {
            run_panel.run_id = `bulk-scanner-${Date.now()}`;
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* run panel unavailable */
        }

        setPhase('firing');
        setFireLog([]);
        setStatus(
            `BEST MARKET FOUND · ${candidate.market.label} · ${candidate.label} · placing ${n} contracts…`
        );

        const proposalReq = {
            proposal: 1,
            amount,
            basis: 'stake',
            contract_type: candidate.type,
            currency: cur,
            duration: 1,
            duration_unit: 't',
            underlying_symbol: candidate.market.code,
            barrier: String(candidate.barrier),
        };

        const ids = [];
        const buyMeta = [];
        const maxAttemptsPerSlot = 3;

        setFireLog(prev => [...prev, `[EXEC] Opening exactly ${n} contracts…`]);

        // For fast 1-tick digit contracts, proposal -> immediate buy is much more
        // reliable than preparing several proposals first and buying them later.
        // Each requested bulk slot gets its own fresh proposal and immediate buy.
        for (let slot = 1; slot <= n; slot += 1) {
            let opened = false;

            for (let attempt = 1; attempt <= maxAttemptsPerSlot && !opened; attempt += 1) {
                try {
                    setStatus(
                        `BEST MARKET FOUND · ${candidate.market.label} · ${candidate.label} · opening ${slot}/${n}${
                            attempt > 1 ? ` · retry ${attempt}/${maxAttemptsPerSlot}` : ''
                        }…`
                    );

                    const proposalResponse = await withTimeout(
                        api_base.api.send({
                            ...proposalReq,
                            passthrough: {
                                nolimitz_batch: run_panel?.run_id || 'bulk-scanner',
                                slot,
                                attempt,
                                stage: 'proposal',
                            },
                        }),
                        5000,
                        `Proposal #${slot}`
                    );

                    if (proposalResponse?.error) {
                        throw new Error(
                            proposalResponse.error.message ||
                                proposalResponse.error.code ||
                                'Proposal rejected'
                        );
                    }

                    const proposal = proposalResponse?.proposal;
                    if (!proposal?.id) {
                        throw new Error('No proposal returned');
                    }

                    setFireLog(prev => [
                        ...prev,
                        `[READY] #${slot} proposal · payout ${cur} ${Number(
                            proposal.payout ?? 0
                        ).toFixed(2)}`,
                    ]);

                    const buyResponse = await withTimeout(
                        api_base.api.send({
                            buy: proposal.id,
                            price: Number(proposal.ask_price ?? amount),
                            passthrough: {
                                nolimitz_batch: run_panel?.run_id || 'bulk-scanner',
                                slot,
                                attempt,
                                stage: 'buy',
                            },
                        }),
                        5000,
                        `Buy #${slot}`
                    );

                    if (buyResponse?.error) {
                        throw new Error(
                            buyResponse.error.message || buyResponse.error.code || 'Buy rejected'
                        );
                    }

                    const cid = buyResponse?.buy?.contract_id;
                    if (!cid) {
                        throw new Error('Buy returned no contract id');
                    }

                    ids.push(cid);
                    buyMeta.push({
                        contract_id: cid,
                        slot,
                        buy_price: Number(buyResponse?.buy?.buy_price ?? amount),
                    });
                    opened = true;

                    if (ids.length === 1) {
                        try {
                            run_panel?.setIsRunning?.(true);
                        } catch {
                            /* noop */
                        }
                    }

                    setFireLog(prev => [
                        ...prev,
                        `[BUY] #${slot}/${n} ${candidate.label} · contract ${cid} · ${cur} ${Number(
                            buyResponse?.buy?.buy_price ?? amount
                        ).toFixed(2)}`,
                    ]);

                    log(`[BUY] Contract ${slot}/${n} opened · id ${cid}.`);
                } catch (error) {
                    const message = describeError(error);
                    setFireLog(prev => [
                        ...prev,
                        `[FAIL] #${slot} attempt ${attempt}/${maxAttemptsPerSlot} — ${message}`,
                    ]);

                    if (attempt < maxAttemptsPerSlot) {
                        await sleep(140);
                    }
                }
            }

            if (!opened) {
                log(`[WARNING] Contract slot ${slot}/${n} could not be opened after ${maxAttemptsPerSlot} attempts.`);
            }

            if (slot < n) {
                await sleep(70);
            }
        }

        log(
            `[EXEC] Opened ${ids.length}/${n} requested contracts · requested exposure ${cur} ${exposure.toFixed(
                2
            )}.`
        );

        if (!ids.length) {
            setPhase('done');
            setStatus('Best setup found, but all buy requests failed.');
            try {
                run_panel?.setIsRunning?.(false);
            } catch {
                /* noop */
            }
            return;
        }

        setStatus(
            ids.length === n
                ? `Waiting for settlement · ${ids.length}/${n} ${candidate.label} contracts opened on ${candidate.market.label}.`
                : `Partial batch · ${ids.length}/${n} contracts opened. Waiting for those contracts to settle.`
        );
        setPhase('settling');
        setSettle({ settled: 0, total: ids.length });

        track_ref.current = trackContracts(ids, {
            onUpdate: ({ settled, total }) => setSettle({ settled, total }),
            onContract: contract => {
                try {
                    transactions?.onBotContractEvent?.(contract);
                    summary_card?.onBotContractEvent?.(contract);
                    run_panel?.onBotContractEvent?.(contract);
                } catch {
                    /* display mirroring must never interrupt settlement */
                }
            },
            onDone: ({ total, wins, settled, count: settledCount }) => {
                setSettle(null);
                try {
                    run_panel?.setIsRunning?.(false);
                } catch {
                    /* noop */
                }
                if (total >= 0) playWin();
                else playLoss();

                setBatchResult({
                    total,
                    wins,
                    settled,
                    count: settledCount,
                    requested: n,
                    executed: ids.length,
                    market: candidate.market.label,
                    marketCode: candidate.market.code,
                    side: candidate.label,
                    hitRate: candidate.hitRate,
                    lowerBound: candidate.lowerBound,
                    breakEven: candidate.breakEven,
                    observedEdge: candidate.observedEdge,
                });
                setPhase('done');
                track_ref.current = null;
            },
        });
    };

    const evaluateMatrix = React.useCallback(async () => {
        if (!armed_ref.current || eval_inflight_ref.current) return;

        const now = Date.now();
        if (now - last_eval_ref.current < EVALUATE_EVERY_MS) return;
        last_eval_ref.current = now;
        eval_inflight_ref.current = true;

        try {
            const local = SCAN_MARKETS.map(market => {
                const digits = digits_ref.current[market.code] || [];
                return {
                    market,
                    digits,
                    stats: bestLocalCandidate(digits),
                };
            }).filter(row => row.stats?.n >= MIN_SAMPLE);

            setScanSummary(prev => ({
                ...prev,
                marketsReady: local.length,
            }));

            if (!local.length) {
                setStatus(`Collecting evidence… 0/${SCAN_MARKETS.length} markets have ${MIN_SAMPLE}+ ticks.`);
                return;
            }

            // One proposal per market keeps the scanner responsive and avoids
            // hammering Deriv with 60 simultaneous proposal requests.
            const priced = (
                await Promise.all(local.map(row => requestEconomics(row.market, row.stats)))
            ).filter(Boolean);

            evaluations_ref.current += 1;
            const byCode = {};
            priced.forEach(row => {
                byCode[row.market.code] = row;
            });

            setMatrix(prev => {
                const next = { ...prev };
                SCAN_MARKETS.forEach(market => {
                    const digits = digits_ref.current[market.code] || [];
                    const pricedRow = byCode[market.code];
                    const localBest = bestLocalCandidate(digits);
                    next[market.code] = {
                        ...(next[market.code] || {}),
                        digits: digits.slice(-5),
                        sample: localBest?.n || digits.length,
                        candidate: pricedRow || (localBest ? { ...localBest, market } : null),
                    };
                });
                return next;
            });

            const ranked = priced
                .filter(row => Number.isFinite(row.observedEdge))
                .sort(
                    (a, b) =>
                        b.observedEdge - a.observedEdge ||
                        b.lowerBound - a.lowerBound ||
                        b.hitRate - a.hitRate
                );

            const best = ranked[0] || null;
            const qualified = ranked.find(row => row.qualified) || null;

            setScanSummary({
                marketsReady: local.length,
                bestEdge: best?.observedEdge ?? null,
                evaluations: evaluations_ref.current,
            });

            if (qualified && armed_ref.current) {
                armed_ref.current = false;
                stopSocket();
                setMatch(qualified);
                log(
                    `[SUCCESS] ${qualified.market.code} · ${qualified.label} · hit ${pct(
                        qualified.hitRate
                    )} · break-even ${pct(qualified.breakEven)} · edge +${pct(
                        qualified.observedEdge
                    ).replace('+', '')}.`
                );
                setStatus(
                    `BEST MARKET FOUND · ${qualified.market.label} · ${qualified.label} · +${pct(
                        qualified.observedEdge
                    ).replace('+', '')} observed edge.`
                );
                await fireBatch(qualified);
                return;
            }

            const current = Date.now();
            if (best) {
                setStatus(
                    `Scanning · best now: ${best.market.code} ${best.label} · hit ${pct(
                        best.hitRate
                    )} vs BE ${pct(best.breakEven)} · edge ${best.observedEdge >= 0 ? '+' : ''}${pct(
                        best.observedEdge
                    )}. Waiting for validation.`
                );
                if (current - last_log_ref.current >= LOG_EVERY_MS) {
                    last_log_ref.current = current;
                    log(
                        `[SCAN] best ${best.market.code} ${best.label} · observed ${pct(
                            best.hitRate
                        )} · BE ${pct(best.breakEven)} · edge ${best.observedEdge >= 0 ? '+' : ''}${pct(
                            best.observedEdge
                        )} · lower bound ${pct(best.lowerBound)}.`
                    );
                }
            } else {
                setStatus('Live history is ready, but proposal economics are still loading.');
            }
        } finally {
            eval_inflight_ref.current = false;
        }
    }, []);

    const scheduleEvaluation = React.useCallback(() => {
        if (!armed_ref.current || eval_timer_ref.current) return;
        const wait = Math.max(0, EVALUATE_EVERY_MS - (Date.now() - last_eval_ref.current));
        eval_timer_ref.current = window.setTimeout(() => {
            eval_timer_ref.current = null;
            evaluateMatrix();
        }, wait);
    }, [evaluateMatrix]);

    const scan = () => {
        teardown();
        track_ref.current?.cancel();
        track_ref.current = null;

        setPhase('scanning');
        setLogs([]);
        setMatrix({});
        setMatch(null);
        setBatchResult(null);
        setFireLog([]);
        setSettle(null);
        setScanSummary({ marketsReady: 0, bestEdge: null, evaluations: 0 });
        setStatus(`Collecting up to ${HISTORY_COUNT} real ticks from ${SCAN_MARKETS.length} markets…`);

        digits_ref.current = {};
        evaluations_ref.current = 0;
        last_eval_ref.current = 0;
        last_log_ref.current = 0;
        armed_ref.current = true;

        log('[INFO] Nolimitz AI market matrix started.');
        log('[INFO] Reading real Deriv digit history.');
        log('[INFO] Comparing OVER 2/3/4 and UNDER 5/6/7.');
        log('[INFO] Edge = observed hit-rate minus current Deriv break-even.');

        const url = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
        const ws = new WebSocket(url);
        ws_ref.current = ws;

        ws.onopen = () => {
            if (!armed_ref.current) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            SCAN_MARKETS.forEach(market => {
                ws.send(
                    JSON.stringify({
                        ticks_history: market.code,
                        count: HISTORY_COUNT,
                        end: 'latest',
                        style: 'ticks',
                        subscribe: 1,
                    })
                );
            });
        };

        ws.onmessage = message => {
            if (!armed_ref.current) return;

            let data;
            try {
                data = JSON.parse(message.data);
            } catch {
                return;
            }

            if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
                data.active_symbols.forEach(symbol => {
                    const code = symbol.symbol || symbol.underlying_symbol;
                    if (code && typeof symbol.pip === 'number') {
                        decimals_ref.current[code] = `${symbol.pip}`.split('.')[1]?.length ?? 0;
                    }
                });
                return;
            }

            if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
                const code = data.echo_req.ticks_history;
                if (!SCAN_MARKETS.some(market => market.code === code)) return;
                const decimals = decimals_ref.current[code] ?? 2;
                const digits = (data.history?.prices || [])
                    .map(price => lastDigit(price, decimals))
                    .slice(-HISTORY_COUNT);
                digits_ref.current[code] = digits;

                setMatrix(prev => ({
                    ...prev,
                    [code]: {
                        ...(prev[code] || {}),
                        digits: digits.slice(-5),
                        sample: digits.length,
                        candidate: bestLocalCandidate(digits),
                    },
                }));
                scheduleEvaluation();
                return;
            }

            if (data.msg_type === 'tick' && data.tick?.symbol) {
                const code = data.tick.symbol;
                if (!SCAN_MARKETS.some(market => market.code === code)) return;
                const decimals = decimals_ref.current[code] ?? 2;
                const prev = digits_ref.current[code] || [];
                const digits = [...prev, lastDigit(data.tick.quote, decimals)].slice(-HISTORY_COUNT);
                digits_ref.current[code] = digits;

                setMatrix(previous => ({
                    ...previous,
                    [code]: {
                        ...(previous[code] || {}),
                        digits: digits.slice(-5),
                        sample: digits.length,
                        candidate: previous[code]?.candidate || bestLocalCandidate(digits),
                    },
                }));
                scheduleEvaluation();
            }
        };

        ws.onerror = () => {
            if (!armed_ref.current) return;
            log('[WARNING] Market stream interrupted. Stop and scan again if it does not recover.');
            setStatus('Market stream interrupted — waiting for socket recovery.');
        };
    };

    const stopScan = () => {
        teardown();
        setPhase('idle');
        setStatus('Scanner stopped. Tap Scan for Best Market to start again.');
        log('[INFO] Scanner stopped by user.');
    };

    const handleClose = () => {
        teardown();
        track_ref.current?.cancel();
        track_ref.current = null;
        setPhase('idle');
        setLogs([]);
        setMatrix({});
        setMatch(null);
        setFireLog([]);
        setSettle(null);
        setBatchResult(null);
        onClose?.();
    };

    if (!open) return null;

    const scanning = phase === 'scanning';
    const busy = phase === 'firing' || phase === 'settling';

    return (
        <div className='ai-scanner__overlay' role='dialog' aria-modal='true' onClick={handleClose}>
            <div className='ai-scanner' onClick={event => event.stopPropagation()}>
                <div className='ai-scanner__bar'>
                    <span className='ai-scanner__dots'>
                        <i /> <i /> <i />
                    </span>
                    <button className='ai-scanner__close' onClick={handleClose}>
                        ✕
                    </button>
                </div>

                <div className='ai-scanner__title'>NOLIMITZ AI MARKET MATRIX</div>
                <div className='ai-scanner__subtitle'>Live Deriv scanner · measured Over/Under edge</div>

                <div className='ai-scanner__config'>
                    <label>
                        <span>Stake ({currency})</span>
                        <input
                            type='number'
                            min='0.35'
                            step='0.01'
                            value={scannerStake}
                            disabled={busy}
                            onChange={event => setScannerStake(event.target.value)}
                        />
                    </label>
                    <label>
                        <span>Bulk trades</span>
                        <input
                            type='number'
                            min='1'
                            max='20'
                            step='1'
                            value={scannerCount}
                            disabled={busy}
                            onChange={event =>
                                setScannerCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
                            }
                        />
                    </label>
                    <div>
                        <span>Batch total</span>
                        <strong>
                            {currency}{' '}
                            {(
                                Math.max(0.35, Number(scannerStake) || 0.35) *
                                Math.max(1, Number(scannerCount) || 1)
                            ).toFixed(2)}
                        </strong>
                    </div>
                </div>

                {(scanning || busy) && (
                    <div className='ai-scanner__running'>
                        <span className='ai-scanner__running-dot' />
                        {scanning
                            ? `Scanning ${SCAN_MARKETS.length} markets · ${scanSummary.marketsReady} ready`
                            : phase === 'firing'
                              ? 'Best market found — dispatching batch…'
                              : 'Contracts live — waiting for settlement…'}
                    </div>
                )}

                <div className='ai-scanner__metrics'>
                    <div>
                        <span>Markets</span>
                        <strong>{scanSummary.marketsReady}/{SCAN_MARKETS.length}</strong>
                    </div>
                    <div>
                        <span>Evidence</span>
                        <strong>{EVIDENCE_WINDOW} ticks</strong>
                    </div>
                    <div>
                        <span>Best edge</span>
                        <strong>
                            {scanSummary.bestEdge === null
                                ? '—'
                                : `${scanSummary.bestEdge >= 0 ? '+' : ''}${pct(scanSummary.bestEdge)}`}
                        </strong>
                    </div>
                    <div>
                        <span>Checks</span>
                        <strong>{scanSummary.evaluations}</strong>
                    </div>
                </div>

                <div className='ai-scanner__markets ai-scanner__markets--matrix'>
                    {SCAN_MARKETS.map(market => {
                        const row = matrix[market.code];
                        const candidate = row?.candidate;
                        const isMatch = match?.market?.code === market.code;
                        const isQualified = Boolean(candidate?.qualified);

                        return (
                            <div
                                key={market.code}
                                className={`ai-scanner__mkt ${isQualified ? 'ai-scanner__mkt--hit' : ''} ${
                                    isMatch ? 'ai-scanner__mkt--match' : ''
                                }`}
                            >
                                <div className='ai-scanner__mkt-top'>
                                    <span className='ai-scanner__mkt-name'>{market.code}</span>
                                    <span className='ai-scanner__mkt-sample'>{row?.sample || 0} ticks</span>
                                </div>
                                <div className='ai-scanner__mkt-contract'>
                                    {candidate?.label || 'COLLECTING'}
                                </div>
                                <div className='ai-scanner__mkt-stats'>
                                    <span>
                                        HIT <b>{candidate?.hitRate ? pct(candidate.hitRate) : '—'}</b>
                                    </span>
                                    <span>
                                        BE <b>{Number.isFinite(candidate?.breakEven) ? pct(candidate.breakEven) : '—'}</b>
                                    </span>
                                    <span>
                                        EDGE{' '}
                                        <b className={candidate?.observedEdge > 0 ? 'pos' : candidate?.observedEdge < 0 ? 'neg' : ''}>
                                            {Number.isFinite(candidate?.observedEdge)
                                                ? `${candidate.observedEdge >= 0 ? '+' : ''}${pct(candidate.observedEdge)}`
                                                : '—'}
                                        </b>
                                    </span>
                                </div>
                                <div className='ai-scanner__mkt-digits'>
                                    {(row?.digits || []).map((digit, index) => (
                                        <i key={`${market.code}-${index}`}>{digit}</i>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {match && (
                    <div className='ai-scanner__best'>
                        <span>BEST MARKET FOUND</span>
                        <h3>{match.market.label}</h3>
                        <strong>{match.label}</strong>
                        <div>
                            <span>Observed hit <b>{pct(match.hitRate)}</b></span>
                            <span>Break-even <b>{pct(match.breakEven)}</b></span>
                            <span>Observed edge <b>+{pct(match.observedEdge).replace('+', '')}</b></span>
                            <span>Confidence LB <b>{pct(match.lowerBound)}</b></span>
                        </div>
                    </div>
                )}

                <div className='ai-scanner__terminal'>
                    {logs.length === 0 && phase === 'idle' && (
                        <div className='ai-scanner__standby'>
                            STANDBY — scan real Deriv history, price live contracts, then execute only the strongest validated setup.
                        </div>
                    )}
                    {logs.map((line, index) => (
                        <div
                            key={index}
                            className={`ai-scanner__log ${
                                line.startsWith('[SUCCESS]')
                                    ? 'ai-scanner__log--ok'
                                    : line.startsWith('[WARNING]') || line.startsWith('[BLOCKED]')
                                      ? 'ai-scanner__log--warn'
                                      : ''
                            }`}
                        >
                            {line}
                        </div>
                    ))}
                </div>

                <div className='ai-scanner__statusbar'>
                    <span className='ai-scanner__statusbar-tag'>
                        {scanning ? 'SCANNING' : busy ? 'TRADING' : phase === 'done' ? 'COMPLETE' : 'STANDBY'}
                    </span>
                    <span className='ai-scanner__statusbar-text'>{status}</span>
                </div>

                {busy && fireLog.length > 0 && (
                    <div className='ai-scanner__firing'>
                        {fireLog.slice(-8).map((line, index) => (
                            <div key={index} className='ai-scanner__log'>
                                {line}
                            </div>
                        ))}
                        {phase === 'settling' && settle && (
                            <div className='ai-scanner__settle'>
                                Waiting for settlement… {settle.settled}/{settle.total}
                            </div>
                        )}
                    </div>
                )}

                {!busy && (
                    <button
                        className={`ai-scanner__scan ${scanning ? 'ai-scanner__scan--stop' : ''}`}
                        onClick={scanning ? stopScan : scan}
                    >
                        {scanning ? 'STOP SCANNER' : phase === 'done' ? '⚡ SCAN AGAIN' : '⚡ SCAN FOR BEST MARKET'}
                    </button>
                )}

                <div className='ai-scanner__foot-note'>
                    <em>Observed edge is measured, not guaranteed.</em> The scanner compares the recent real digit sample
                    with the current Deriv proposal break-even and requires the confidence lower bound to stay above the
                    contract's random baseline before auto-execution.
                </div>
            </div>

            {batchResult && (
                <div className='ai-scanner__batch-overlay' role='dialog' aria-modal='true' onClick={handleClose}>
                    <div
                        className={`ai-scanner__batch ai-scanner__batch--pop ${
                            batchResult.total >= 0 ? 'ai-scanner__batch--win' : 'ai-scanner__batch--loss'
                        }`}
                        onClick={event => event.stopPropagation()}
                    >
                        <button className='ai-scanner__batch-close' onClick={handleClose}>
                            ✕
                        </button>
                        <div className='ai-scanner__batch-tag'>Total profit</div>
                        <div className='ai-scanner__batch-head'>
                            Scanner batch {batchResult.total >= 0 ? 'won' : 'lost'}
                        </div>
                        <div className='ai-scanner__batch-amt'>
                            {batchResult.total >= 0 ? '+' : ''}
                            {batchResult.total.toFixed(2)} {currency}
                        </div>
                        <div className='ai-scanner__batch-grid'>
                            <div>
                                <span>Market</span>
                                {batchResult.market}
                            </div>
                            <div>
                                <span>Contract</span>
                                {batchResult.side}
                            </div>
                            <div>
                                <span>Requested / Executed</span>
                                {batchResult.requested}/{batchResult.executed}
                            </div>
                            <div>
                                <span>Wins</span>
                                {batchResult.wins}/{batchResult.executed}
                            </div>
                            <div>
                                <span>Observed edge</span>
                                {batchResult.observedEdge >= 0 ? '+' : ''}
                                {pct(batchResult.observedEdge)}
                            </div>
                            <div>
                                <span>Measured hit</span>
                                {pct(batchResult.hitRate)}
                            </div>
                            <div>
                                <span>Break-even</span>
                                {pct(batchResult.breakEven)}
                            </div>
                        </div>
                        <button
                            className='ai-scanner__rescan'
                            onClick={() => {
                                setBatchResult(null);
                                scan();
                            }}
                        >
                            Scan again
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AiScanner;
