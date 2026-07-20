// @ts-nocheck — AI Scanner for Bulk Trader.
// Traderscheme-style terminal + reveal, but the number shown is the REAL
// recent-frequency of the winning side over the analysis window — labeled
// honestly as recent frequency, never a prediction of the next tick.
import React from 'react';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { api_base } from '@/external/bot-skeleton';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './ai-scanner.scss';

const SCAN_MARKETS = [
    { code: 'R_10', label: 'Vol 10' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_100', label: 'Vol 100' },
    { code: '1HZ50V', label: 'Vol 50 (1s)' },
    { code: '1HZ100V', label: 'Vol 100 (1s)' },
];
const DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ50V': 2, '1HZ100V': 2,
};
const WINDOW = 120;
const lastDigit = (q, d) => Number(Number(q).toFixed(d).slice(-1));

const BOOT_LINES = [
    '[INFO] Initializing market scanner…',
    '[OK] Synthetic stream linked',
    '[INFO] Reading recent digit frequencies…',
    '[INFO] Ranking markets by strongest recent skew…',
];

// Given a digit array, return the strongest side + its recent frequency.
const analyze = digits => {
    const counts = Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const total = digits.length || 1;
    const pct = counts.map(c => (100 * c) / total);
    const even = pct[0] + pct[2] + pct[4] + pct[6] + pct[8];
    const odd = 100 - even;
    const over2 = pct.slice(3).reduce((a, b) => a + b, 0); // digit >2 wins DIGITOVER 2
    const under7 = pct.slice(0, 7).reduce((a, b) => a + b, 0); // digit <7 wins DIGITUNDER 7
    // Candidate contracts and their recent-frequency
    const cands = [
        { type: 'DIGITEVEN', label: 'Even', freq: even },
        { type: 'DIGITODD', label: 'Odd', freq: odd },
        { type: 'DIGITOVER', barrier: 2, label: 'Over 2', freq: over2 },
        { type: 'DIGITUNDER', barrier: 7, label: 'Under 7', freq: under7 },
    ];
    cands.sort((a, b) => b.freq - a.freq);
    return { best: cands[0], pct, total: digits.length };
};

const AiScanner = ({ open, onClose, stake, count, currency = 'USD', isLoggedIn = false }) => {
    const [phase, setPhase] = React.useState('idle'); // idle | scanning | firing | settling | done
    const [fireLog, setFireLog] = React.useState([]);
    const [settle, setSettle] = React.useState(null); // {settled,total}
    const [batchResult, setBatchResult] = React.useState(null);
    const track_ref = React.useRef(null);
    const [logs, setLogs] = React.useState([]);
    const [rows, setRows] = React.useState([]); // {label, code, best}
    const [result, setResult] = React.useState(null);
    const ws_ref = React.useRef(null);

    React.useEffect(() => {
        if (!open) {
            // reset on close
            setPhase('idle');
            setLogs([]);
            setRows([]);
            setResult(null);
            setFireLog([]);
            setSettle(null);
            setBatchResult(null);
            track_ref.current?.cancel();
            if (ws_ref.current) {
                try {
                    ws_ref.current.close();
                } catch {
                    /* noop */
                }
                ws_ref.current = null;
            }
        }
    }, [open]);

    const scan = () => {
        setPhase('scanning');
        setLogs([]);
        setRows([]);
        setResult(null);

        // boot log animation
        BOOT_LINES.forEach((line, i) => setTimeout(() => setLogs(p => [...p, line]), i * 450));

        const url = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
        const ws = new WebSocket(url);
        ws_ref.current = ws;
        const collected = {};
        let received = 0;

        ws.onopen = () => {
            SCAN_MARKETS.forEach(m => {
                ws.send(
                    JSON.stringify({
                        ticks_history: m.code,
                        count: WINDOW,
                        end: 'latest',
                        style: 'ticks',
                        req_id: SCAN_MARKETS.indexOf(m) + 1,
                    })
                );
            });
        };
        ws.onmessage = msg => {
            let data;
            try {
                data = JSON.parse(msg.data);
            } catch {
                return;
            }
            if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
                const code = data.echo_req.ticks_history;
                const mkt = SCAN_MARKETS.find(m => m.code === code);
                if (!mkt) return;
                const dec = DECIMALS[code] ?? 2;
                const digits = (data.history?.prices || []).map(p => lastDigit(p, dec));
                const a = analyze(digits);
                collected[code] = { ...mkt, best: a.best };
                received += 1;
                setLogs(p => [...p, `[SCAN] ${mkt.label}: ${a.best.label} ${a.best.freq.toFixed(1)}%`]);
                setRows(Object.values(collected));
                if (received === SCAN_MARKETS.length) {
                    // pick market with strongest recent skew
                    const ranked = Object.values(collected).sort((x, y) => y.best.freq - x.best.freq);
                    const top = ranked[0];
                    try {
                        ws.close();
                    } catch {
                        /* noop */
                    }
                    setTimeout(() => {
                        setResult(top);
                        autoFire(top);
                    }, 600);
                }
            }
        };
        ws.onerror = () => {
            setLogs(p => [...p, '[WARN] Scan connection error — retry.']);
            setPhase('idle');
        };
    };

    // Auto-fire the batch on the chosen market + contract, then track settlement.
    const autoFire = async top => {
        if (!isLoggedIn || !api_base?.api) {
            setPhase('done'); // fall back to showing the pick if not logged in
            return;
        }
        unlockAudio();
        setPhase('firing');
        setFireLog([]);
        const n = Math.max(1, Math.min(20, parseInt(count, 10) || 5));
        const amount = Math.max(0.35, parseFloat(stake) || 0.5);
        const ids = [];
        for (let i = 0; i < n; i++) {
            try {
                const proposal_req = {
                    proposal: 1,
                    amount,
                    basis: 'stake',
                    contract_type: top.best.type,
                    currency,
                    duration: 1,
                    duration_unit: 't',
                    underlying_symbol: top.code,
                    ...(top.best.barrier !== undefined ? { barrier: String(top.best.barrier) } : {}),
                };
                // eslint-disable-next-line no-await-in-loop
                const prop = await api_base.api.send(proposal_req);
                const pid = prop?.proposal?.id;
                if (!pid) throw new Error('No proposal');
                // eslint-disable-next-line no-await-in-loop
                const res = await api_base.api.send({ buy: pid, price: Number(prop.proposal.ask_price) });
                const cid = res?.buy?.contract_id;
                if (cid) ids.push(cid);
                setFireLog(p => [...p, `[BUY] #${i + 1} ${top.best.label} — ${currency} ${amount.toFixed(2)}`]);
            } catch (e) {
                setFireLog(p => [...p, `[FAIL] #${i + 1} — ${describeError(e)}`]);
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 300));
        }
        if (!ids.length) {
            setPhase('done');
            return;
        }
        setPhase('settling');
        setSettle({ settled: 0, total: ids.length });
        track_ref.current = trackContracts(ids, {
            onUpdate: ({ settled, total }) => setSettle({ settled, total }),
            onDone: ({ total, wins, settled, count: c }) => {
                setSettle(null);
                if (total >= 0) playWin();
                else playLoss();
                setBatchResult({ total, wins, settled, count: c, market: top.label, side: top.best.label });
                setPhase('done');
                track_ref.current = null;
            },
        });
    };

    React.useEffect(() => () => track_ref.current?.cancel(), []);


    return (
        <div className='ai-scanner__overlay' role='dialog' aria-modal='true'>
            <div className='ai-scanner'>
                <div className='ai-scanner__bar'>
                    <span className='ai-scanner__dots'>
                        <i /> <i /> <i />
                    </span>
                    <button className='ai-scanner__close' onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className='ai-scanner__title'>AI MARKET SCANNER</div>
                <div className='ai-scanner__subtitle'>Recent-frequency analysis · Digit markets</div>
                {(phase === 'scanning' || phase === 'firing' || phase === 'settling') && (
                    <div className='ai-scanner__running'>
                        <span className='ai-scanner__running-dot' />
                        {phase === 'scanning' ? 'Scanner running — analysing markets…' : phase === 'firing' ? 'Scanner running — placing trades…' : 'Scanner running — settling trades…'}
                    </div>
                )}

                <div className='ai-scanner__markets'>
                    {(rows.length ? rows : SCAN_MARKETS.map(m => ({ ...m, best: null }))).map(r => (
                        <div key={r.code} className='ai-scanner__mkt'>
                            <span className='ai-scanner__mkt-name'>{r.label}</span>
                            <span className='ai-scanner__mkt-val'>
                                {r.best ? `${r.best.label} ${r.best.freq.toFixed(1)}%` : '— — —'}
                            </span>
                        </div>
                    ))}
                </div>

                <div className='ai-scanner__terminal'>
                    {logs.length === 0 && phase === 'idle' && (
                        <div className='ai-scanner__standby'>
                            STANDBY — ready to scan recent frequencies across {SCAN_MARKETS.length} markets.
                        </div>
                    )}
                    {logs.map((l, i) => (
                        <div key={i} className='ai-scanner__log'>
                            {l}
                        </div>
                    ))}
                </div>

                {phase !== 'done' && phase !== 'firing' && phase !== 'settling' && (
                    <button className='ai-scanner__scan' disabled={phase === 'scanning'} onClick={scan}>
                        {phase === 'scanning' ? 'Scanning live markets…' : '⚡ Scan & auto-trade best market'}
                    </button>
                )}

                {(phase === 'firing' || phase === 'settling') && result && (
                    <div className='ai-scanner__firing'>
                        <div className='ai-scanner__firing-head'>
                            {phase === 'firing' ? 'Placing batch' : 'Settling'} — {result.best.label} on {result.label}
                        </div>
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

                {phase === 'done' && !batchResult && result && (
                    <div className='ai-scanner__result'>
                        <div className='ai-scanner__result-tag'>Strongest recent skew</div>
                        <div className='ai-scanner__result-market'>{result.label}</div>
                        <div className='ai-scanner__result-side'>{result.best.label}</div>
                        <div className='ai-scanner__result-freq'>{result.best.freq.toFixed(1)}%</div>
                        <div className='ai-scanner__result-note'>
                            {isLoggedIn
                                ? 'No trades placed. Tap Scan again to retry.'
                                : 'Sign in with Deriv to let the scanner auto-trade.'}
                        </div>
                        <button className='ai-scanner__rescan' onClick={scan}>
                            Scan again
                        </button>
                    </div>
                )}
            </div>

            {batchResult && (
                <div className='ai-scanner__batch-overlay' role='dialog' aria-modal='true'>
                    <div
                        className={`ai-scanner__batch ai-scanner__batch--pop ${batchResult.total >= 0 ? 'ai-scanner__batch--win' : 'ai-scanner__batch--loss'}`}
                    >
                        <button className='ai-scanner__batch-close' onClick={() => setBatchResult(null)}>✕</button>
                        <div className='ai-scanner__batch-tag'>Total profit</div>
                        <div className='ai-scanner__batch-head'>
                            Scanner batch {batchResult.total >= 0 ? 'won' : 'lost'}
                        </div>
                        <div className='ai-scanner__batch-amt'>
                            {batchResult.total >= 0 ? '+' : ''}
                            {batchResult.total.toFixed(2)}
                        </div>
                        <div className='ai-scanner__batch-grid'>
                            <div><span>Market</span>{batchResult.market}</div>
                            <div><span>Contract</span>{batchResult.side}</div>
                            <div><span>Trades</span>{batchResult.settled}/{batchResult.count}</div>
                            <div><span>Wins</span>{batchResult.wins}</div>
                        </div>
                        <button className='ai-scanner__rescan' onClick={() => { setBatchResult(null); scan(); }}>
                            Scan again
                        </button>
                        <div className='ai-scanner__result-note'>
                            Wide contracts (Over/Under) win often but pay small — recent skew, not a prediction.
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AiScanner;
