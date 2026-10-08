// @ts-nocheck
// Nolimitz AI Market Matrix — Bulk Trader digit scanner.
//
// Observable flow intentionally follows the reference scanner:
// 13 volatility markets -> repeated sweeps -> same setup confirmation ->
// bulk execution -> settlement -> Scan Again.
//
// "Edge" below is a model/pattern score derived from real Deriv digit history.
// It is NOT a guaranteed trading advantage and is deliberately kept separate
// from payout/break-even claims.
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
    { code: '1HZ15V', label: 'Volatility 15 (1s) Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ30V', label: 'Volatility 30 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: '1HZ90V', label: 'Volatility 90 (1s) Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: 'R_100', label: 'Volatility 100 Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
];

const FALLBACK_DECIMALS = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
    '1HZ10V': 2,
    '1HZ15V': 2,
    '1HZ25V': 2,
    '1HZ30V': 2,
    '1HZ50V': 2,
    '1HZ75V': 2,
    '1HZ90V': 2,
    '1HZ100V': 2,
};

const CANDIDATES = [
    { type: 'DIGITOVER', barrier: 1, side: 'OVER', label: 'Over 1', baseline: 0.8 },
    { type: 'DIGITOVER', barrier: 2, side: 'OVER', label: 'Over 2', baseline: 0.7 },
    { type: 'DIGITOVER', barrier: 3, side: 'OVER', label: 'Over 3', baseline: 0.6 },
    { type: 'DIGITOVER', barrier: 4, side: 'OVER', label: 'Over 4', baseline: 0.5 },
    { type: 'DIGITUNDER', barrier: 5, side: 'UNDER', label: 'Under 5', baseline: 0.5 },
    { type: 'DIGITUNDER', barrier: 6, side: 'UNDER', label: 'Under 6', baseline: 0.6 },
    { type: 'DIGITUNDER', barrier: 7, side: 'UNDER', label: 'Under 7', baseline: 0.7 },
    { type: 'DIGITUNDER', barrier: 8, side: 'UNDER', label: 'Under 8', baseline: 0.8 },
];

const HISTORY_COUNT = 1000;
const MIN_HISTORY = 700;
const SWEEP_MS = 3400;
const CONFIRM_EDGE = 0.04; // +4.0 model-edge points, matching the selective video flow
const MAX_EDGE_DISPLAY = 0.099;
const MAX_ATTEMPTS_PER_SLOT = 4;

const lastDigit = (quote, decimals) => Number(Number(quote).toFixed(decimals).slice(-1));
const winsCandidate = (candidate, digit) =>
    candidate.type === 'DIGITOVER' ? digit > candidate.barrier : digit < candidate.barrier;

const rate = (digits, candidate, n) => {
    const sample = digits.slice(-Math.min(n, digits.length));
    if (!sample.length) return candidate.baseline;
    let hits = 0;
    sample.forEach(digit => {
        if (winsCandidate(candidate, digit)) hits += 1;
    });
    return hits / sample.length;
};

const shrinkRate = (raw, n, baseline, prior = 28) =>
    (raw * n + baseline * prior) / (n + prior);

const conditionalNextRate = (digits, candidate, depth = 1) => {
    if (digits.length < 40) {
        return { rate: candidate.baseline, n: 0 };
    }

    const pattern = digits.slice(-depth);
    let trials = 0;
    let hits = 0;

    for (let i = depth - 1; i < digits.length - 1; i += 1) {
        let matches = true;
        for (let j = 0; j < depth; j += 1) {
            if (digits[i - depth + 1 + j] !== pattern[j]) {
                matches = false;
                break;
            }
        }
        if (!matches) continue;

        trials += 1;
        if (winsCandidate(candidate, digits[i + 1])) hits += 1;
    }

    if (!trials) return { rate: candidate.baseline, n: 0 };
    return {
        rate: shrinkRate(hits / trials, trials, candidate.baseline, depth === 1 ? 18 : 10),
        n: trials,
    };
};

const scoreCandidate = (digits, candidate) => {
    if (digits.length < MIN_HISTORY) {
        return {
            ...candidate,
            hitRate: candidate.baseline,
            modelRate: candidate.baseline,
            edge: 0,
        };
    }

    const r60 = shrinkRate(rate(digits, candidate, 60), 60, candidate.baseline, 24);
    const r140 = shrinkRate(rate(digits, candidate, 140), 140, candidate.baseline, 40);
    const r360 = shrinkRate(rate(digits, candidate, 360), 360, candidate.baseline, 80);
    const rAll = rate(digits, candidate, Math.min(HISTORY_COUNT, digits.length));

    const c1 = conditionalNextRate(digits, candidate, 1);
    const c2 = conditionalNextRate(digits, candidate, 2);

    // Multi-horizon pattern score. Short/conditional signals drive the scan,
    // while medium/long history prevents one tiny streak from winning alone.
    let modelRate =
        r60 * 0.27 +
        r140 * 0.23 +
        r360 * 0.17 +
        rAll * 0.13 +
        c1.rate * 0.13 +
        c2.rate * 0.07;

    // Reward agreement rather than one isolated noisy horizon.
    const votes = [r60, r140, r360, c1.rate].filter(v => v > candidate.baseline).length;
    const agreementBoost = Math.max(0, votes - 2) * 0.004;
    modelRate += agreementBoost;

    const edge = Math.max(-0.099, Math.min(MAX_EDGE_DISPLAY, modelRate - candidate.baseline));

    return {
        ...candidate,
        hitRate: rAll,
        modelRate,
        edge,
        votes,
        recent: digits.slice(-4),
    };
};

const bestCandidate = digits =>
    CANDIDATES.map(candidate => scoreCandidate(digits, candidate)).sort(
        (a, b) => b.edge - a.edge || b.votes - a.votes || b.hitRate - a.hitRate
    )[0] || null;

const pct1 = value => `${(Number(value || 0) * 100).toFixed(1)}%`;
const plusPct1 = value => `${Number(value) >= 0 ? '+' : ''}${pct1(value)}`;

const withTimeout = (promise, ms, label) =>
    Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error(`${label} timed out`)), ms)
        ),
    ]);

const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));

const AiScanner = ({ open, onClose, stake, count, currency = 'USD', isLoggedIn = false }) => {
    const { run_panel, transactions, summary_card } = useStore();

    const [phase, setPhase] = React.useState('idle'); // idle | scanning | firing | settling | done
    const [scannerStake, setScannerStake] = React.useState(String(stake ?? '5'));
    const [scannerCount, setScannerCount] = React.useState(Math.max(1, Math.min(20, Number(count) || 5)));
    const [rows, setRows] = React.useState({});
    const [logs, setLogs] = React.useState([]);
    const [statusTitle, setStatusTitle] = React.useState('STANDBY');
    const [statusText, setStatusText] = React.useState('Set your stake and number of bulk trades, then start the scanner.');
    const [sweep, setSweep] = React.useState(0);
    const [settle, setSettle] = React.useState(null);
    const [batchResult, setBatchResult] = React.useState(null);

    const ws_ref = React.useRef(null);
    const track_ref = React.useRef(null);
    const timer_ref = React.useRef(null);
    const digits_ref = React.useRef({});
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const active_ref = React.useRef(false);
    const sweep_ref = React.useRef(0);
    const confirm_ref = React.useRef(null);
    const cfg_ref = React.useRef({});

    cfg_ref.current = {
        stake: scannerStake,
        count: scannerCount,
        currency,
        isLoggedIn,
    };

    const log = line => setLogs(prev => [...prev, line].slice(-70));

    const stopSweepTimer = () => {
        if (timer_ref.current) {
            window.clearTimeout(timer_ref.current);
            timer_ref.current = null;
        }
    };

    const stopSocket = () => {
        stopSweepTimer();
        try {
            ws_ref.current?.close();
        } catch {
            /* noop */
        }
        ws_ref.current = null;
    };

    const resetLive = () => {
        active_ref.current = false;
        stopSocket();
        confirm_ref.current = null;
        sweep_ref.current = 0;
    };

    React.useEffect(() => {
        if (open && phase === 'idle') {
            setScannerStake(String(stake ?? '5'));
            setScannerCount(Math.max(1, Math.min(20, Number(count) || 5)));
        }

        if (!open) {
            resetLive();
            track_ref.current?.cancel();
            track_ref.current = null;
            setPhase('idle');
            setRows({});
            setLogs([]);
            setSweep(0);
            setSettle(null);
            setBatchResult(null);
            setStatusTitle('STANDBY');
            setStatusText('Set your stake and number of bulk trades, then start the scanner.');
            digits_ref.current = {};
        }
    }, [open]);

    React.useEffect(
        () => () => {
            resetLive();
            track_ref.current?.cancel();
        },
        []
    );

    const fireBatch = async candidate => {
        const { stake: st, count: ct, currency: cur, isLoggedIn: connected } = cfg_ref.current;

        if (!connected || !api_base?.api) {
            setPhase('done');
            setStatusTitle('COMPLETE');
            setStatusText('Best market found, but Deriv is not connected.');
            return;
        }

        const amount = Math.max(0.35, Number(st) || 0.5);
        const requested = Math.max(1, Math.min(20, parseInt(ct, 10) || 5));
        const ids = [];

        unlockAudio();
        setPhase('firing');
        setStatusTitle('TRADING');
        setStatusText('Opening bulk contracts…');
        log(`[INFO] Placing ${requested} trade(s) on ${candidate.market.code}...`);

        try {
            run_panel.run_id = `bulk-scanner-${Date.now()}`;
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* noop */
        }

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

        for (let slot = 1; slot <= requested; slot += 1) {
            let opened = false;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SLOT && !opened; attempt += 1) {
                try {
                    const proposalResponse = await withTimeout(
                        api_base.api.send({
                            ...proposalReq,
                            passthrough: {
                                nolimitz_batch: run_panel?.run_id || 'bulk-scanner',
                                slot,
                                attempt,
                            },
                        }),
                        5000,
                        `Proposal #${slot}`
                    );

                    if (proposalResponse?.error) {
                        throw new Error(proposalResponse.error.message || 'Proposal rejected');
                    }

                    const proposal = proposalResponse?.proposal;
                    if (!proposal?.id) throw new Error('No proposal returned');

                    const buyResponse = await withTimeout(
                        api_base.api.send({
                            buy: proposal.id,
                            price: Number(proposal.ask_price ?? amount),
                            passthrough: {
                                nolimitz_batch: run_panel?.run_id || 'bulk-scanner',
                                slot,
                                attempt,
                            },
                        }),
                        5000,
                        `Buy #${slot}`
                    );

                    if (buyResponse?.error) {
                        throw new Error(buyResponse.error.message || 'Buy rejected');
                    }

                    const contractId = buyResponse?.buy?.contract_id;
                    if (!contractId) throw new Error('No contract id returned');

                    ids.push(contractId);
                    opened = true;

                    if (ids.length === 1) {
                        try {
                            run_panel?.setIsRunning?.(true);
                        } catch {
                            /* noop */
                        }
                    }
                } catch (error) {
                    if (attempt === MAX_ATTEMPTS_PER_SLOT) {
                        log(`[WARN] Trade ${slot}/${requested} could not open: ${describeError(error)}`);
                    } else {
                        await sleep(100);
                    }
                }
            }

            if (slot < requested) await sleep(55);
        }

        if (!ids.length) {
            try {
                run_panel?.setIsRunning?.(false);
            } catch {
                /* noop */
            }
            setPhase('done');
            setStatusTitle('COMPLETE');
            setStatusText('No contracts opened. Tap Scan Again to retry.');
            return;
        }

        log(`[OK] ${ids.length}/${requested} contracts opened.`);
        setPhase('settling');
        setStatusTitle('TRADING');
        setStatusText('Waiting for settlement…');
        setSettle({ settled: 0, total: ids.length });

        track_ref.current = trackContracts(ids, {
            onUpdate: ({ settled, total }) => setSettle({ settled, total }),
            onContract: contract => {
                try {
                    transactions?.onBotContractEvent?.(contract);
                    summary_card?.onBotContractEvent?.(contract);
                    run_panel?.onBotContractEvent?.(contract);
                } catch {
                    /* UI mirroring cannot stop settlement */
                }
            },
            onDone: ({ total, wins, count: settledCount }) => {
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
                    count: settledCount,
                    requested,
                    executed: ids.length,
                    marketCode: candidate.market.code,
                    marketLabel: candidate.market.label,
                    side: candidate.side,
                    contractLabel: candidate.label,
                    edge: candidate.edge,
                    hitRate: candidate.hitRate,
                });
                setPhase('done');
                setStatusTitle('COMPLETE');
                setStatusText(total >= 0 ? 'Scanner batch won.' : 'Scanner batch lost.');
                track_ref.current = null;
            },
        });
    };

    const runSweep = React.useCallback(async () => {
        if (!active_ref.current) return;

        const nextSweep = sweep_ref.current + 1;
        sweep_ref.current = nextSweep;
        setSweep(nextSweep);

        const scored = [];

        SCAN_MARKETS.forEach(market => {
            const digits = digits_ref.current[market.code] || [];
            const candidate = bestCandidate(digits);
            if (!candidate || digits.length < MIN_HISTORY) return;

            const row = {
                market,
                ...candidate,
                recent: digits.slice(-4),
            };
            scored.push(row);

            setRows(prev => ({
                ...prev,
                [market.code]: row,
            }));

            log(
                `[SCAN] ${market.code}: ${row.recent.join(',')} → ${row.label} edge ${plusPct1(
                    row.edge
                )}`
            );
        });

        if (!scored.length) {
            setStatusTitle('SCANNING');
            setStatusText('Collecting live digit history…');
        } else {
            scored.sort((a, b) => b.edge - a.edge || b.votes - a.votes || b.hitRate - a.hitRate);
            const best = scored[0];

            if (best.edge >= CONFIRM_EDGE) {
                const key = `${best.market.code}:${best.type}:${best.barrier}`;
                const previous = confirm_ref.current;

                if (previous && previous.key === key && previous.sweep === nextSweep - 1) {
                    active_ref.current = false;
                    stopSocket();
                    confirm_ref.current = null;

                    log(
                        `[OK] Best market found: ${best.market.code} → ${best.label} (hit rate ${pct1(
                            best.hitRate
                        )}, edge ${plusPct1(best.edge)})`
                    );
                    await fireBatch(best);
                    return;
                }

                confirm_ref.current = { key, sweep: nextSweep };
                log(
                    `[INFO] ${best.market.code} ${best.label} cleared the bar — confirming on next sweep...`
                );
                setStatusTitle('SCANNING');
                setStatusText(`Still scanning… sweep ${nextSweep}. Confirming strongest setup.`);
            } else {
                confirm_ref.current = null;
                setStatusTitle('SCANNING');
                setStatusText(
                    nextSweep === 1
                        ? 'Scanning live markets…'
                        : `Still scanning… sweep ${nextSweep}. Tap stop to cancel.`
                );
            }
        }

        if (active_ref.current) {
            timer_ref.current = window.setTimeout(runSweep, SWEEP_MS);
        }
    }, []);

    const startScan = () => {
        resetLive();
        track_ref.current?.cancel();
        track_ref.current = null;

        setPhase('scanning');
        setRows({});
        setLogs([]);
        setSweep(0);
        setSettle(null);
        setBatchResult(null);
        setStatusTitle('SCANNING');
        setStatusText('Scanning live markets…');

        digits_ref.current = {};
        sweep_ref.current = 0;
        confirm_ref.current = null;
        active_ref.current = true;

        log(`[INFO] Scanning digit patterns on ${SCAN_MARKETS.length} volatility markets...`);

        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;

        ws.onopen = () => {
            if (!active_ref.current) return;

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

        ws.onmessage = event => {
            if (!active_ref.current) return;

            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
                data.active_symbols.forEach(symbol => {
                    const code = symbol.symbol || symbol.underlying_symbol;
                    if (!code || typeof symbol.pip !== 'number') return;
                    decimals_ref.current[code] = `${symbol.pip}`.split('.')[1]?.length ?? 0;
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

                if (
                    SCAN_MARKETS.every(market => (digits_ref.current[market.code] || []).length >= MIN_HISTORY) &&
                    sweep_ref.current === 0
                ) {
                    stopSweepTimer();
                    timer_ref.current = window.setTimeout(runSweep, 250);
                }
                return;
            }

            if (data.msg_type === 'tick' && data.tick?.symbol) {
                const code = data.tick.symbol;
                if (!SCAN_MARKETS.some(market => market.code === code)) return;

                const decimals = decimals_ref.current[code] ?? 2;
                const prev = digits_ref.current[code] || [];
                digits_ref.current[code] = [
                    ...prev,
                    lastDigit(data.tick.quote, decimals),
                ].slice(-HISTORY_COUNT);
            }
        };

        ws.onerror = () => {
            if (!active_ref.current) return;
            setStatusTitle('SCANNING');
            setStatusText('Live stream interrupted. Reconnecting may be required.');
            log('[WARN] Deriv market stream interrupted.');
        };
    };

    const stopScan = () => {
        resetLive();
        setPhase('idle');
        setStatusTitle('STANDBY');
        setStatusText('Scanner stopped. Tap Scan for Best Market to start again.');
        log('[INFO] Scanner stopped by user.');
    };

    const handleClose = () => {
        resetLive();
        track_ref.current?.cancel();
        track_ref.current = null;
        setPhase('idle');
        setRows({});
        setLogs([]);
        setSweep(0);
        setSettle(null);
        setBatchResult(null);
        onClose?.();
    };

    if (!open) return null;

    const scanning = phase === 'scanning';
    const trading = phase === 'firing' || phase === 'settling';

    return (
        <div className='ai-scanner__overlay' role='dialog' aria-modal='true' onClick={handleClose}>
            <div className='ai-scanner ai-scanner--reference' onClick={event => event.stopPropagation()}>
                <div className='ai-scanner__reference-head'>
                    <div>
                        <span>NOLIMITZ AI MARKET MATRIX</span>
                        <h2>Analysis Dashboard - Digit Scanner</h2>
                    </div>
                    <button type='button' onClick={handleClose}>×</button>
                </div>

                <div className='ai-scanner__reference-fields'>
                    <label>
                        <span>STAKE</span>
                        <input
                            type='number'
                            min='0.35'
                            step='0.01'
                            value={scannerStake}
                            disabled={scanning || trading}
                            onChange={event => setScannerStake(event.target.value)}
                        />
                    </label>
                    <label>
                        <span>NO. OF BULK TRADES</span>
                        <input
                            type='number'
                            min='1'
                            max='20'
                            step='1'
                            value={scannerCount}
                            disabled={scanning || trading}
                            onChange={event =>
                                setScannerCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
                            }
                        />
                    </label>
                </div>

                <div className='ai-scanner__reference-label'>Markets</div>
                <div className='ai-scanner__reference-markets'>
                    {SCAN_MARKETS.map(market => {
                        const row = rows[market.code];
                        return (
                            <div key={market.code} className='ai-scanner__reference-market'>
                                <b>{market.code}</b>{' '}
                                <span>
                                    {row?.recent?.length ? row.recent.join(',') : '—,—,—,—'}
                                </span>{' '}
                                <em>({row ? plusPct1(row.edge) : '—'})</em>
                            </div>
                        );
                    })}
                </div>

                <div className='ai-scanner__reference-terminal'>
                    {logs.length ? (
                        logs.slice(-13).map((line, index) => (
                            <div
                                key={`${index}-${line}`}
                                className={
                                    line.startsWith('[OK]')
                                        ? 'ok'
                                        : line.startsWith('[INFO]')
                                          ? 'info'
                                          : line.startsWith('[WARN]')
                                            ? 'warn'
                                            : ''
                                }
                            >
                                {line}
                            </div>
                        ))
                    ) : (
                        <div className='muted'>Waiting to scan live Deriv digit patterns…</div>
                    )}
                </div>

                <div className='ai-scanner__reference-status'>
                    <strong>{statusTitle}</strong>
                    <span>
                        {phase === 'settling' && settle
                            ? `Waiting for settlement… ${settle.settled}/${settle.total}`
                            : statusText}
                    </span>
                </div>

                {phase === 'idle' || phase === 'done' ? (
                    <button className='ai-scanner__reference-start' type='button' onClick={startScan}>
                        {phase === 'done' ? 'SCAN AGAIN' : 'SCAN FOR BEST MARKET'}
                    </button>
                ) : scanning ? (
                    <button className='ai-scanner__reference-stop' type='button' onClick={stopScan}>
                        STOP SCANNER
                    </button>
                ) : (
                    <button className='ai-scanner__reference-trading' type='button' disabled>
                        Trading…
                    </button>
                )}

                <div className='ai-scanner__reference-note'>
                    Pattern edge is a live model score from real Deriv ticks, not a guaranteed outcome.
                </div>
            </div>

            {batchResult && (
                <div className='ai-scanner__batch-overlay' role='dialog' aria-modal='true'>
                    <div
                        className={`ai-scanner__reference-result ${
                            batchResult.total >= 0 ? 'win' : 'loss'
                        }`}
                        onClick={event => event.stopPropagation()}
                    >
                        <button className='close' type='button' onClick={handleClose}>×</button>
                        <span className='eyebrow'>TOTAL PROFIT</span>
                        <h3>Scanner batch {batchResult.total >= 0 ? 'won' : 'lost'}</h3>
                        <div className='amount'>
                            {batchResult.total >= 0 ? '+' : ''}
                            {batchResult.total.toFixed(2)} {currency}
                        </div>

                        <div className='result-box'>
                            <span>MARKET</span>
                            <b>{batchResult.marketCode}</b>
                        </div>
                        <div className='result-box'>
                            <span>CONTRACT</span>
                            <b>{batchResult.side}</b>
                        </div>
                        <div className='result-box'>
                            <span>TRADES</span>
                            <b>{batchResult.wins}/{batchResult.requested}</b>
                            {batchResult.executed !== batchResult.requested && (
                                <small>Executed {batchResult.executed}/{batchResult.requested}</small>
                            )}
                        </div>

                        <button
                            className='scan-again'
                            type='button'
                            onClick={() => {
                                setBatchResult(null);
                                setPhase('idle');
                                setStatusTitle('STANDBY');
                                setStatusText('Ready. Tap Scan for Best Market.');
                            }}
                        >
                            SCAN AGAIN
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AiScanner;
