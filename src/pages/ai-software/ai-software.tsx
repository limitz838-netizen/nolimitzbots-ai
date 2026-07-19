// @ts-nocheck — follows vendored page code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './ai-software.scss';

const MARKETS = [
    { code: 'R_100', label: 'Vol 100' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_10', label: 'Vol 10' },
    { code: '1HZ100V', label: 'Vol 100 (1s)' },
    { code: '1HZ50V', label: 'Vol 50 (1s)' },
];

const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
};

// Trigger robots: watch the digit stream, enter when the pattern appears.
const ROBOTS = [
    {
        id: 'over1',
        name: 'Over 1',
        accent: 'blue',
        trigger_text: 'Enters when the last digit is ≤ 1',
        setup: 'Over 1',
        contract_type: 'DIGITOVER',
        barrier: 1,
        trigger: d => d[d.length - 1] <= 1,
    },
    {
        id: 'over1pro',
        name: 'Over 1 Pro',
        accent: 'green',
        trigger_text: 'Enters when the last 2 digits are ≤ 1',
        setup: 'Over 1',
        contract_type: 'DIGITOVER',
        barrier: 1,
        trigger: d => d.length >= 2 && d[d.length - 1] <= 1 && d[d.length - 2] <= 1,
    },
    {
        id: 'over2',
        name: 'Over 2 Sniper',
        accent: 'gold',
        trigger_text: 'Enters when the last digit is ≤ 2',
        setup: 'Over 2',
        contract_type: 'DIGITOVER',
        barrier: 2,
        trigger: d => d[d.length - 1] <= 2,
    },
    {
        id: 'under8',
        name: 'Under 8',
        accent: 'blue',
        trigger_text: 'Enters when the last digit is ≥ 8',
        setup: 'Under 8',
        contract_type: 'DIGITUNDER',
        barrier: 8,
        trigger: d => d[d.length - 1] >= 8,
    },
    {
        id: 'under8pro',
        name: 'Under 8 Pro',
        accent: 'green',
        trigger_text: 'Enters when the last 2 digits are ≥ 8',
        setup: 'Under 8',
        contract_type: 'DIGITUNDER',
        barrier: 8,
        trigger: d => d.length >= 2 && d[d.length - 1] >= 8 && d[d.length - 2] >= 8,
    },
    {
        id: 'under7',
        name: 'Under 7 Sniper',
        accent: 'gold',
        trigger_text: 'Enters when the last digit is ≥ 7',
        setup: 'Under 7',
        contract_type: 'DIGITUNDER',
        barrier: 7,
        trigger: d => d[d.length - 1] >= 7,
    },
];

const AiSoftware = observer(() => {
    const { client } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const currency = client?.currency || 'USD';

    const [symbol, setSymbol] = React.useState('R_100');
    const [stake, setStake] = React.useState('0.5');
    const [tp, setTp] = React.useState('10');
    const [sl, setSl] = React.useState('50');
    const [active_id, setActiveId] = React.useState(null);
    const [stats, setStats] = React.useState({ pnl: 0, trades: 0, wins: 0, losses: 0, last_digit: null });
    const [logs, setLogs] = React.useState([]);
    const [result, setResult] = React.useState(null);

    const run_ref = React.useRef(null);
    const ws_ref = React.useRef(null);
    const digits_ref = React.useRef([]);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const sym_ref = React.useRef(symbol);
    sym_ref.current = symbol;

    const log = line => setLogs(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));

    React.useEffect(() => {
        let alive = true;
        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;
        const sub = () => {
            digits_ref.current = [];
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(JSON.stringify({ ticks_history: sym_ref.current, count: 10, end: 'latest', style: 'ticks', subscribe: 1 }));
        };
        ws.onopen = () => {
            if (!alive) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            sub();
        };
        ws.onmessage = msg => {
            if (!alive) return;
            let data;
            try {
                data = JSON.parse(msg.data);
            } catch {
                return;
            }
            if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
                data.active_symbols.forEach(s => {
                    const code = s.symbol || s.underlying_symbol;
                    if (code && typeof s.pip === 'number') decimals_ref.current[code] = `${s.pip}`.split('.')[1]?.length ?? 0;
                });
                return;
            }
            const push = q => {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const d = Number(Number(q).toFixed(dec).slice(-1));
                digits_ref.current = [...digits_ref.current, d].slice(-10);
                setStats(prev => ({ ...prev, last_digit: d }));
                onDigit();
            };
            if (data.msg_type === 'history' && data.echo_req?.ticks_history === sym_ref.current) {
                (data.history?.prices || []).forEach(p => {
                    const dec = decimals_ref.current[sym_ref.current] ?? 2;
                    digits_ref.current = [...digits_ref.current, Number(Number(p).toFixed(dec).slice(-1))].slice(-10);
                });
                return;
            }
            if (data.msg_type === 'tick' && data.tick?.symbol === sym_ref.current) push(data.tick.quote);
        };
        const resub = () => ws.readyState === WebSocket.OPEN && sub();
        window.addEventListener('nlb-ai-symbol', resub);
        return () => {
            alive = false;
            window.removeEventListener('nlb-ai-symbol', resub);
            if (run_ref.current) run_ref.current.active = false;
            try {
                ws.close();
            } catch {
                /* noop */
            }
        };
    }, []);

    const settleContract = (contract_id, timeout_ms) =>
        new Promise(resolve => {
            let done = false;
            const finish = profit => {
                if (done) return;
                done = true;
                sub.unsubscribe();
                clearInterval(poll);
                clearTimeout(to);
                resolve(profit);
            };
            const sub = api_base.api.onMessage().subscribe(({ data }) => {
                const c = data?.proposal_open_contract;
                if (data?.msg_type === 'proposal_open_contract' && c?.contract_id === contract_id && c?.is_sold) {
                    finish(Number(c.profit ?? 0));
                }
            });
            const poll = setInterval(() => {
                try {
                    api_base.api.send({ proposal_open_contract: 1, contract_id });
                } catch {
                    /* noop */
                }
            }, 3000);
            const to = setTimeout(() => finish(null), timeout_ms);
        });

    const stopRun = (reason, r) => {
        if (run_ref.current) run_ref.current.active = false;
        run_ref.current = null;
        setActiveId(null);
        if (reason && r) {
            if (r.pnl >= 0) playWin();
            else playLoss();
            setResult({ reason, pnl: r.pnl, trades: r.trades, wins: r.wins, losses: r.losses, robot: r.robot.name });
        }
    };

    // Called on every new digit — the robot's brain.
    const onDigit = async () => {
        const r = run_ref.current;
        if (!r || !r.active || r.in_trade) return;
        if (!r.robot.trigger(digits_ref.current)) return;
        r.in_trade = true;
        try {
            const amount = r.stake;
            const prop = await api_base.api.send({
                proposal: 1,
                amount,
                basis: 'stake',
                contract_type: r.robot.contract_type,
                currency,
                duration: 1,
                duration_unit: 't',
                underlying_symbol: sym_ref.current,
                barrier: String(r.robot.barrier),
            });
            const id = prop?.proposal?.id;
            if (!id) throw new Error('No proposal');
            const res = await api_base.api.send({ buy: id, price: Number(prop.proposal.ask_price) });
            log(`▶ trigger hit — ${r.robot.setup}, stake ${amount.toFixed(2)}`);
            const profit = await settleContract(res?.buy?.contract_id, 40000);
            if (profit !== null) {
                r.trades += 1;
                r.pnl += profit;
                if (profit > 0) r.wins += 1;
                else r.losses += 1;
                log(`${profit > 0 ? '✔' : '✘'} ${profit > 0 ? '+' : ''}${profit.toFixed(2)} — P/L ${r.pnl.toFixed(2)}`);
                setStats(prev => ({ ...prev, pnl: r.pnl, trades: r.trades, wins: r.wins, losses: r.losses }));
                if (r.tp > 0 && r.pnl >= r.tp) {
                    log(`🎯 Take Profit hit: +${r.pnl.toFixed(2)}`);
                    stopRun('Take Profit hit', r);
                    return;
                }
                if (r.sl > 0 && r.pnl <= -r.sl) {
                    log(`🛑 Stop Loss hit: ${r.pnl.toFixed(2)}`);
                    stopRun('Stop Loss hit', r);
                    return;
                }
            } else {
                log('⚠ settlement timeout');
            }
        } catch (e) {
            log(`✘ ${e?.error?.message || e?.message || 'trade error'}`);
        } finally {
            if (run_ref.current) run_ref.current.in_trade = false;
        }
    };

    const openBot = robot => {
        if (!is_logged_in) return;
        if (active_id === robot.id) {
            log('Stopped by user');
            stopRun(null, null);
            return;
        }
        unlockAudio();
        if (run_ref.current) run_ref.current.active = false;
        setResult(null);
        setLogs([]);
        const r = {
            active: true,
            in_trade: false,
            robot,
            stake: Math.max(0.35, parseFloat(stake) || 0.5),
            tp: parseFloat(tp) || 0,
            sl: parseFloat(sl) || 0,
            pnl: 0,
            trades: 0,
            wins: 0,
            losses: 0,
        };
        run_ref.current = r;
        setStats({ pnl: 0, trades: 0, wins: 0, losses: 0, last_digit: stats.last_digit });
        setActiveId(robot.id);
        log(`${robot.name} armed on ${symbol} — ${robot.trigger_text}`);
    };

    return (
        <div className='ai-software'>
            <div className='ai-software__panel'>
                <div className='ai-software__title'>AI Software</div>
                <div className='ai-software__subtitle'>
                    Pattern robots that watch the digit stream and enter automatically when their setup appears.
                </div>

                {!is_logged_in && <div className='ai-software__warn'>Sign in with your Deriv account to arm a robot.</div>}

                <div className='ai-software__label'>Market</div>
                <div className='ai-software__pills'>
                    {MARKETS.map(m => (
                        <button
                            key={m.code}
                            className={`ai-software__pill ${symbol === m.code ? 'ai-software__pill--active' : ''}`}
                            disabled={!!active_id}
                            onClick={() => {
                                setSymbol(m.code);
                                setTimeout(() => window.dispatchEvent(new Event('nlb-ai-symbol')), 0);
                            }}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>

                <div className='ai-software__grid'>
                    <div className='ai-software__field'>
                        <span>Stake ({currency})</span>
                        <input type='number' min='0.35' step='0.01' value={stake} disabled={!!active_id} onChange={e => setStake(e.target.value)} />
                    </div>
                    <div className='ai-software__field'>
                        <span>Take Profit</span>
                        <input type='number' min='0' step='1' value={tp} disabled={!!active_id} onChange={e => setTp(e.target.value)} />
                    </div>
                    <div className='ai-software__field'>
                        <span>Stop Loss</span>
                        <input type='number' min='0' step='1' value={sl} disabled={!!active_id} onChange={e => setSl(e.target.value)} />
                    </div>
                </div>

                <div className='ai-software__status'>
                    <div>
                        <span>Last digit</span>
                        {stats.last_digit ?? '—'}
                    </div>
                    <div>
                        <span>Trades</span>
                        {stats.trades}
                    </div>
                    <div>
                        <span>W / L</span>
                        {stats.wins}/{stats.losses}
                    </div>
                    <div className={stats.pnl >= 0 ? 'pos' : 'neg'}>
                        <span>P/L</span>
                        {stats.pnl >= 0 ? '+' : ''}
                        {stats.pnl.toFixed(2)}
                    </div>
                </div>

                <div className='ai-software__cards'>
                    {ROBOTS.map(robot => (
                        <div key={robot.id} className={`ai-software__card ai-software__card--${robot.accent}`}>
                            <div className='ai-software__card-name'>{robot.name}</div>
                            <div className='ai-software__card-trigger'>{robot.trigger_text}</div>
                            <div className='ai-software__card-foot'>
                                <div className='ai-software__card-setup'>
                                    <span>Trade setup</span>
                                    {robot.setup}
                                </div>
                                <button
                                    className={`ai-software__card-open ${active_id === robot.id ? 'running' : ''}`}
                                    disabled={!is_logged_in || (!!active_id && active_id !== robot.id)}
                                    onClick={() => openBot(robot)}
                                >
                                    {active_id === robot.id ? '■ Stop bot' : 'Open bot'}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {logs.length > 0 && (
                    <div className='ai-software__log'>
                        {logs.map((l, i) => (
                            <div key={i}>{l}</div>
                        ))}
                    </div>
                )}

                <div className='ai-software__disclaimer'>
                    "Pattern" entries react to history on a random stream — every tick is independent. TP/SL limit a
                    session; they don't create an edge.
                </div>
            </div>

            {result && (
                <div className='ai-software__overlay' role='dialog'>
                    <div className={`ai-software__popup ${result.pnl >= 0 ? 'ai-software__popup--win' : 'ai-software__popup--loss'}`}>
                        <button className='ai-software__popup-close' onClick={() => setResult(null)}>
                            ✕
                        </button>
                        <div className='ai-software__popup-tag'>{result.reason}</div>
                        <div className='ai-software__popup-robot'>{result.robot}</div>
                        <div className='ai-software__popup-amount'>
                            {result.pnl >= 0 ? '+' : ''}
                            {result.pnl.toFixed(2)}
                        </div>
                        <div className='ai-software__popup-grid'>
                            <div>
                                <span>Trades</span>
                                {result.trades}
                            </div>
                            <div>
                                <span>Wins</span>
                                {result.wins}
                            </div>
                            <div>
                                <span>Losses</span>
                                {result.losses}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AiSoftware;
