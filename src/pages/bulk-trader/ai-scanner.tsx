// @ts-nocheck — AI Scanner for Bulk Trader.
// Traderscheme-style terminal + reveal, but the number shown is the REAL
// recent-frequency of the winning side over the analysis window — labeled
// honestly as recent frequency, never a prediction of the next tick.
import React from 'react';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
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

const AiScanner = ({ open, onClose, onApply }) => {
    const [phase, setPhase] = React.useState('idle'); // idle | scanning | done
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
                    setTimeout(() => {
                        setResult(top);
                        setPhase('done');
                    }, 600);
                    try {
                        ws.close();
                    } catch {
                        /* noop */
                    }
                }
            }
        };
        ws.onerror = () => {
            setLogs(p => [...p, '[WARN] Scan connection error — retry.']);
            setPhase('idle');
        };
    };

    if (!open) return null;

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

                {phase !== 'done' && (
                    <button className='ai-scanner__scan' disabled={phase === 'scanning'} onClick={scan}>
                        {phase === 'scanning' ? 'Scanning live markets…' : '⚡ Scan for strongest market'}
                    </button>
                )}

                {phase === 'done' && result && (
                    <div className='ai-scanner__result'>
                        <div className='ai-scanner__result-tag'>Strongest recent skew</div>
                        <div className='ai-scanner__result-market'>{result.label}</div>
                        <div className='ai-scanner__result-side'>{result.best.label}</div>
                        <div className='ai-scanner__result-freq'>{result.best.freq.toFixed(1)}%</div>
                        <div className='ai-scanner__result-note'>
                            of the last {WINDOW} ticks — recent history, not a prediction of the next tick.
                        </div>
                        <button
                            className='ai-scanner__apply'
                            onClick={() => {
                                onApply?.({
                                    symbol: result.code,
                                    contract_type: result.best.type,
                                    barrier: result.best.barrier,
                                    label: result.best.label,
                                });
                                onClose?.();
                            }}
                        >
                            Load {result.best.label} on {result.label} →
                        </button>
                        <button className='ai-scanner__rescan' onClick={scan}>
                            Re-scan
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AiScanner;
