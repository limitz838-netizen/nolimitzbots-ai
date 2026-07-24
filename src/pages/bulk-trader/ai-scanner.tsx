// @ts-nocheck — AI Scanner for Bulk Trader (trap-scanner behaviour).
//
// How it works:
//   • Subscribes live to 10 volatility markets, keeping each one's LAST 4 DIGITS.
//   • Watches for a "trap":  all 4 digits <= 2  -> trade OVER 2
//                            all 4 digits >= 7  -> trade UNDER 7
//   • If no market matches it does NOT trade — it keeps re-scanning.
//   • On a match it fires the batch, tracks settlement, shows the result popup.
//
// Maths note: the 4-digit trap is an ENTRY FILTER, not a predictor — every tick
// is independent. The ~70% hit-rate comes from the Over 2 / Under 7 contract
// itself; the filter's real benefit is trading far less often.
import React from 'react';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { api_base } from '@/external/bot-skeleton';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './ai-scanner.scss';

const SCAN_MARKETS = [
    { code: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { code: '1HZ10V', label: 'Volatility 10 (1s) Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_100', label: 'Volatility 100 Index' },
];

const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
};

const TRAP_LEN = 4;
const LOW_MAX = 2;
const HIGH_MIN = 7;

const lastDigit = (q, d) => Number(Number(q).toFixed(d).slice(-1));

const BOOT_LINES = [
    '[INFO] Authenticating AI market matrix...',
    '[OK] Synthetic stream linked',
    '[INFO] Reading volatility clusters...',
    `[INFO] Searching last ${TRAP_LEN} <= ${LOW_MAX} and >= ${HIGH_MIN} traps...`,
];

const detectTrap = digits => {
    if (!digits || digits.length < TRAP_LEN) return null;
    const last = digits.slice(-TRAP_LEN);
    if (last.every(d => d <= LOW_MAX)) return { type: 'DIGITOVER', barrier: LOW_MAX, label: `OVER ${LOW_MAX}` };
    if (last.every(d => d >= HIGH_MIN)) return { type: 'DIGITUNDER', barrier: HIGH_MIN, label: `UNDER ${HIGH_MIN}` };
    return null;
};

const AiScanner = ({ open, onClose, stake, count, currency = 'USD', isLoggedIn = false }) => {
    const [phase, setPhase] = React.useState('idle'); // idle | scanning | firing | settling | done
    const [logs, setLogs] = React.useState([]);
    const [grid, setGrid] = React.useState({});
    const [status, setStatus] = React.useState('Ready to scan for last-four digit pressure.');
    const [match, setMatch] = React.useState(null);
    const [fireLog, setFireLog] = React.useState([]);
    const [settle, setSettle] = React.useState(null);
    const [batchResult, setBatchResult] = React.useState(null);

    const ws_ref = React.useRef(null);
    const track_ref = React.useRef(null);
    const digits_ref = React.useRef({});
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const armed_ref = React.useRef(false);
    const rescan_timer_ref = React.useRef(null);
    const cfg_ref = React.useRef({ stake, count, currency, isLoggedIn });
    cfg_ref.current = { stake, count, currency, isLoggedIn };

    const log = line => setLogs(p => [...p, line].slice(-60));

    const teardown = () => {
        armed_ref.current = false;
        if (rescan_timer_ref.current) {
            clearInterval(rescan_timer_ref.current);
            rescan_timer_ref.current = null;
        }
        try {
            ws_ref.current?.close();
        } catch {
            /* noop */
        }
        ws_ref.current = null;
    };

    React.useEffect(() => {
        if (!open) {
            teardown();
            track_ref.current?.cancel();
            track_ref.current = null;
            setPhase('idle');
            setLogs([]);
            setGrid({});
            setMatch(null);
            setFireLog([]);
            setSettle(null);
            setBatchResult(null);
            setStatus('Ready to scan for last-four digit pressure.');
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

    const fireBatch = async (market, trap) => {
        const { stake: st, count: ct, currency: cur, isLoggedIn: li } = cfg_ref.current;
        if (!li || !api_base?.api) {
            setPhase('done');
            setStatus(`Matched ${market.label}. Sign in with Deriv to auto-trade.`);
            return;
        }
        unlockAudio();
        setPhase('firing');
        setFireLog([]);
        const n = Math.max(1, Math.min(20, parseInt(ct, 10) || 5));
        const amount = Math.max(0.35, parseFloat(st) || 0.5);
        const ids = [];
        for (let i = 0; i < n; i++) {
            try {
                const proposal_req = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: trap.type,
                    currency: cur,
                    duration: 1,
                    duration_unit: 't',
                    underlying_symbol: market.code,
                    barrier: String(trap.barrier),
                };
                // eslint-disable-next-line no-await-in-loop
                const prop = await api_base.api.send(proposal_req);
                const pid = prop?.proposal?.id;
                if (!pid) throw new Error('No proposal');
                // eslint-disable-next-line no-await-in-loop
                const res = await api_base.api.send({ buy: pid, price: Number(prop.proposal.ask_price) });
                const cid = res?.buy?.contract_id;
                if (cid) ids.push(cid);
                setFireLog(p => [...p, `[BUY] #${i + 1} ${trap.label} — ${cur} ${amount.toFixed(2)}`]);
            } catch (e) {
                setFireLog(p => [...p, `[FAIL] #${i + 1} — ${describeError(e)}`]);
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 250));
        }
        if (!ids.length) {
            setPhase('done');
            return;
        }
        setStatus(`Sent ${ids.length} ${trap.label} contracts on ${market.label}.`);
        setPhase('settling');
        setSettle({ settled: 0, total: ids.length });
        track_ref.current = trackContracts(ids, {
            onUpdate: ({ settled, total }) => setSettle({ settled, total }),
            onDone: ({ total, wins, settled, count: c }) => {
                setSettle(null);
                if (total >= 0) playWin();
                else playLoss();
                setBatchResult({ total, wins, settled, count: c, market: market.label, side: trap.label });
                setPhase('done');
                track_ref.current = null;
            },
        });
    };

    const scan = () => {
        teardown();
        track_ref.current?.cancel();
        track_ref.current = null;
        setPhase('scanning');
        setLogs([]);
        setGrid({});
        setMatch(null);
        setBatchResult(null);
        setFireLog([]);
        setStatus('Scanning live markets for last-four digit pressure...');
        digits_ref.current = {};
        armed_ref.current = true;

        BOOT_LINES.forEach((line, i) => setTimeout(() => log(line), i * 260));

        const url = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
        const ws = new WebSocket(url);
        ws_ref.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            setTimeout(
                () => log(`[INFO] Scanning digit patterns on ${SCAN_MARKETS.length} Volatility markets...`),
                1100
            );
            SCAN_MARKETS.forEach(m => {
                ws.send(
                    JSON.stringify({
                        ticks_history: m.code,
                        count: TRAP_LEN,
                        end: 'latest',
                        style: 'ticks',
                        subscribe: 1,
                    })
                );
            });
        };

        const consider = (code, ds) => {
            if (!armed_ref.current) return;
            const market = SCAN_MARKETS.find(m => m.code === code);
            if (!market) return;
            const trap = detectTrap(ds);
            if (!trap) return;
            armed_ref.current = false;
            if (rescan_timer_ref.current) {
                clearInterval(rescan_timer_ref.current);
                rescan_timer_ref.current = null;
            }
            teardown();
            log(`[SUCCESS] ${market.label}: ${ds.slice(-TRAP_LEN).join(', ')} detected. Trading ${trap.label}.`);
            setMatch({ market, trap });
            setStatus(`Matched ${market.label}. Trading ${trap.label}.`);
            fireBatch(market, trap);
        };

        ws.onmessage = msg => {
            let data;
            try {
                data = JSON.parse(msg.data);
            } catch {
                return;
            }
            if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
                data.active_symbols.forEach(s => {
                    const c = s.symbol || s.underlying_symbol;
                    if (c && typeof s.pip === 'number') decimals_ref.current[c] = `${s.pip}`.split('.')[1]?.length ?? 0;
                });
                return;
            }
            if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
                const code = data.echo_req.ticks_history;
                const dec = decimals_ref.current[code] ?? 2;
                const ds = (data.history?.prices || []).map(p => lastDigit(p, dec)).slice(-TRAP_LEN);
                digits_ref.current[code] = ds;
                setGrid(g => ({ ...g, [code]: ds }));
                log(`[SCAN] ${code}: ${ds.join(',')}`);
                consider(code, ds);
                return;
            }
            if (data.msg_type === 'tick' && data.tick?.symbol) {
                const code = data.tick.symbol;
                const dec = decimals_ref.current[code] ?? 2;
                const prev = digits_ref.current[code] || [];
                const ds = [...prev, lastDigit(data.tick.quote, dec)].slice(-TRAP_LEN);
                digits_ref.current[code] = ds;
                setGrid(g => ({ ...g, [code]: ds }));
                consider(code, ds);
            }
        };

        ws.onerror = () => {
            if (!armed_ref.current) return;
            log('[WARNING] Scan connection error — retry.');
            setPhase('idle');
            setStatus('Connection error. Tap scan to retry.');
        };

        rescan_timer_ref.current = setInterval(() => {
            if (!armed_ref.current) return;
            log('[WARNING] No clean setup yet. Re-scanning...');
        }, 4000);
    };

    const stopScan = () => {
        teardown();
        setPhase('idle');
        setStatus('Scanner stopped. Tap scan to hunt again.');
        log('[INFO] Scanner stopped by user.');
    };

    const handleClose = () => {
        teardown();
        track_ref.current?.cancel();
        track_ref.current = null;
        setPhase('idle');
        setLogs([]);
        setGrid({});
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
            <div className='ai-scanner' onClick={e => e.stopPropagation()}>
                <div className='ai-scanner__bar'>
                    <span className='ai-scanner__dots'>
                        <i /> <i /> <i />
                    </span>
                    <button className='ai-scanner__close' onClick={handleClose}>
                        ✕
                    </button>
                </div>

                <div className='ai-scanner__title'>AI MARKET MATRIX</div>
                <div className='ai-scanner__subtitle'>Analysis Dashboard · Digit Scanner</div>

                {(scanning || busy) && (
                    <div className='ai-scanner__running'>
                        <span className='ai-scanner__running-dot' />
                        {scanning
                            ? 'Scanner running — hunting last-four traps…'
                            : phase === 'firing'
                              ? 'Scanner running — placing trades…'
                              : 'Scanner running — settling trades…'}
                    </div>
                )}

                <div className='ai-scanner__markets'>
                    {SCAN_MARKETS.map(m => {
                        const ds = grid[m.code];
                        const trapped = detectTrap(ds);
                        return (
                            <div
                                key={m.code}
                                className={`ai-scanner__mkt ${trapped ? 'ai-scanner__mkt--hit' : ''} ${
                                    match?.market?.code === m.code ? 'ai-scanner__mkt--match' : ''
                                }`}
                            >
                                <span className='ai-scanner__mkt-name'>{m.code}</span>
                                <span className='ai-scanner__mkt-val'>{ds?.length ? ds.join(',') : '— — — —'}</span>
                            </div>
                        );
                    })}
                </div>

                <div className='ai-scanner__terminal'>
                    {logs.length === 0 && phase === 'idle' && (
                        <div className='ai-scanner__standby'>
                            STANDBY — searching last {TRAP_LEN} ≤ {LOW_MAX} and ≥ {HIGH_MIN} traps across{' '}
                            {SCAN_MARKETS.length} markets.
                        </div>
                    )}
                    {logs.map((l, i) => (
                        <div
                            key={i}
                            className={`ai-scanner__log ${
                                l.startsWith('[SUCCESS]')
                                    ? 'ai-scanner__log--ok'
                                    : l.startsWith('[WARNING]')
                                      ? 'ai-scanner__log--warn'
                                      : ''
                            }`}
                        >
                            {l}
                        </div>
                    ))}
                </div>

                <div className='ai-scanner__statusbar'>
                    <span className='ai-scanner__statusbar-tag'>
                        {scanning ? 'SCANNING' : busy ? 'TRADING' : 'STANDBY'}
                    </span>
                    <span className='ai-scanner__statusbar-text'>{status}</span>
                </div>

                {busy && fireLog.length > 0 && (
                    <div className='ai-scanner__firing'>
                        {fireLog.slice(-6).map((l, i) => (
                            <div key={i} className='ai-scanner__log'>
                                {l}
                            </div>
                        ))}
                        {phase === 'settling' && settle && (
                            <div className='ai-scanner__settle'>
                                Settling contracts… {settle.settled}/{settle.total}
                            </div>
                        )}
                    </div>
                )}

                {!busy && (
                    <button
                        className={`ai-scanner__scan ${scanning ? 'ai-scanner__scan--stop' : ''}`}
                        onClick={scanning ? stopScan : scan}
                    >
                        {scanning ? 'STOP SCANNER' : '⚡ SCAN FOR BEST MARKET'}
                    </button>
                )}

                <div className='ai-scanner__foot-note'>
                    The trap filter decides <em>when</em> to trade, not the odds — the hit-rate comes from the Over{' '}
                    {LOW_MAX} / Under {HIGH_MIN} contract itself.
                </div>
            </div>

            {batchResult && (
                <div className='ai-scanner__batch-overlay' role='dialog' aria-modal='true' onClick={handleClose}>
                    <div
                        className={`ai-scanner__batch ai-scanner__batch--pop ${
                            batchResult.total >= 0 ? 'ai-scanner__batch--win' : 'ai-scanner__batch--loss'
                        }`}
                        onClick={e => e.stopPropagation()}
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
                            {batchResult.total.toFixed(2)}
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
                                <span>Trades</span>
                                {batchResult.settled}/{batchResult.count}
                            </div>
                            <div>
                                <span>Wins</span>
                                {batchResult.wins}
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
