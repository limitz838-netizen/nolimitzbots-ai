// @ts-nocheck — follows vendored page code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './speedbot.scss';

const MARKETS = [
    { code: '1HZ100V', label: 'Vol 100 (1s)' },
    { code: '1HZ75V', label: 'Vol 75 (1s)' },
    { code: '1HZ50V', label: 'Vol 50 (1s)' },
    { code: '1HZ25V', label: 'Vol 25 (1s)' },
    { code: '1HZ10V', label: 'Vol 10 (1s)' },
    { code: 'R_100', label: 'Vol 100' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_10', label: 'Vol 10' },
];

const TYPES = [
    { code: 'DIGITEVEN', label: 'Even' },
    { code: 'DIGITODD', label: 'Odd' },
    { code: 'DIGITOVER', label: 'Over 2', barrier: 2 },
    { code: 'DIGITUNDER', label: 'Under 7', barrier: 7 },
];

const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
};

const MAX_MARTINGALE_STEPS = 7;
const opposite = t => ({ DIGITEVEN: 'DIGITODD', DIGITODD: 'DIGITEVEN', DIGITOVER: 'DIGITUNDER', DIGITUNDER: 'DIGITOVER' })[t];

const Speedbot = observer(() => {
    const { client } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const currency = client?.currency || 'USD';

    const [symbol, setSymbol] = React.useState('1HZ100V');
    const [type_code, setTypeCode] = React.useState('DIGITEVEN');
    const [speed, setSpeed] = React.useState('normal'); // fast | normal
    const [duration, setDuration] = React.useState(1);
    const [stake, setStake] = React.useState('0.5');
    const [tp, setTp] = React.useState('10');
    const [sl, setSl] = React.useState('50');
    const [alt_eo, setAltEo] = React.useState(false);
    const [alt_on_loss, setAltOnLoss] = React.useState(false);
    const [martingale, setMartingale] = React.useState(false);
    const [mult, setMult] = React.useState('2.0');

    const [running, setRunning] = React.useState(false);
    const [stats, setStats] = React.useState({ ticks: 0, last_digit: null, pnl: 0, trades: 0, wins: 0, losses: 0, cur_stake: 0 });
    const [logs, setLogs] = React.useState([]);
    const [result, setResult] = React.useState(null);
    const [quote, setQuote] = React.useState(null);

    const run_ref = React.useRef(null);
    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const sym_ref = React.useRef(symbol);
    sym_ref.current = symbol;

    const log = line =>
        setLogs(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));

    // ticker socket for display digits
    React.useEffect(() => {
        let alive = true;
        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;
        const sub = () => {
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(JSON.stringify({ ticks_history: sym_ref.current, count: 1, end: 'latest', style: 'ticks', subscribe: 1 }));
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
            if (data.msg_type === 'tick' && data.tick?.symbol === sym_ref.current) {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const q = Number(data.tick.quote).toFixed(dec);
                setQuote(q);
                setStats(prev => ({ ...prev, ticks: prev.ticks + 1, last_digit: Number(q.slice(-1)) }));
            }
        };
        const resub = () => ws.readyState === WebSocket.OPEN && sub();
        window.addEventListener('nlb-speed-symbol', resub);
        return () => {
            alive = false;
            window.removeEventListener('nlb-speed-symbol', resub);
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

    const buyOnce = async (contract_type, barrier, amount) => {
        const proposal_req = {
            proposal: 1,
            amount,
            basis: 'stake',
            contract_type,
            currency,
            duration,
            duration_unit: 't',
            underlying_symbol: symbol,
            ...(barrier !== undefined ? { barrier: String(barrier) } : {}),
        };
        const prop = await api_base.api.send(proposal_req);
        const id = prop?.proposal?.id;
        if (!id) throw new Error('No proposal');
        const res = await api_base.api.send({ buy: id, price: Number(prop.proposal.ask_price) });
        return res?.buy?.contract_id;
    };

    const stopRun = (reason, final_pnl, r) => {
        if (run_ref.current) run_ref.current.active = false;
        run_ref.current = null;
        setRunning(false);
        if (reason) {
            const won = final_pnl >= 0;
            if (won) playWin();
            else playLoss();
            setResult({ reason, pnl: final_pnl, trades: r.trades, wins: r.wins, losses: r.losses });
        }
    };

    const start = async () => {
        if (running || !is_logged_in || !api_base?.api) return;
        unlockAudio();
        setResult(null);
        setLogs([]);
        const base_stake = parseFloat(stake) || 0;
        const tp_v = parseFloat(tp) || 0;
        const sl_v = parseFloat(sl) || 0;
        const mult_v = Math.max(1, parseFloat(mult) || 1);
        if (base_stake < 0.35) return;

        const r = {
            active: true,
            pnl: 0,
            trades: 0,
            wins: 0,
            losses: 0,
            cur_stake: base_stake,
            steps: 0,
            cur_type: TYPES.find(t => t.code === type_code),
        };
        run_ref.current = r;
        setRunning(true);
        log(`Started — ${r.cur_type.label} on ${symbol}, stake ${base_stake.toFixed(2)}`);

        const checkStop = () => {
            if (!r.active) return true;
            if (tp_v > 0 && r.pnl >= tp_v) {
                log(`🎯 Take Profit hit: +${r.pnl.toFixed(2)}`);
                stopRun('Take Profit hit', r.pnl, r);
                return true;
            }
            if (sl_v > 0 && r.pnl <= -sl_v) {
                log(`🛑 Stop Loss hit: ${r.pnl.toFixed(2)}`);
                stopRun('Stop Loss hit', r.pnl, r);
                return true;
            }
            return false;
        };

        const afterSettle = profit => {
            if (profit === null) {
                log('⚠ settlement timeout — counted as unresolved');
                return;
            }
            r.trades += 1;
            r.pnl += profit;
            const won = profit > 0;
            if (won) {
                r.wins += 1;
                r.steps = 0;
                r.cur_stake = base_stake;
                if (alt_eo) r.cur_type = TYPES.find(t => t.code === opposite(r.cur_type.code)) || r.cur_type;
            } else {
                r.losses += 1;
                if (martingale) {
                    r.steps += 1;
                    if (r.steps > MAX_MARTINGALE_STEPS) {
                        log(`⚠ Martingale cap (${MAX_MARTINGALE_STEPS} steps) — resetting stake`);
                        r.steps = 0;
                        r.cur_stake = base_stake;
                    } else {
                        r.cur_stake = Math.min(r.cur_stake * mult_v, base_stake * 200);
                    }
                }
                if (alt_on_loss) r.cur_type = TYPES.find(t => t.code === opposite(r.cur_type.code)) || r.cur_type;
            }
            log(`${won ? '✔' : '✘'} ${won ? '+' : ''}${profit.toFixed(2)} — P/L ${r.pnl.toFixed(2)}`);
            setStats(prev => ({ ...prev, pnl: r.pnl, trades: r.trades, wins: r.wins, losses: r.losses, cur_stake: r.cur_stake }));
        };

        while (r.active) {
            if (checkStop()) return;
            try {
                const t = r.cur_type;
                setStats(prev => ({ ...prev, cur_stake: r.cur_stake }));
                // eslint-disable-next-line no-await-in-loop
                const cid = await buyOnce(t.code, t.barrier, Number(r.cur_stake.toFixed(2)));
                log(`▶ ${t.label} — stake ${r.cur_stake.toFixed(2)}`);
                const settle_p = settleContract(cid, (duration + 30) * 1000);
                if (speed === 'normal') {
                    // eslint-disable-next-line no-await-in-loop
                    afterSettle(await settle_p);
                    if (checkStop()) return;
                } else {
                    settle_p.then(p => {
                        afterSettle(p);
                        checkStop();
                    });
                }
            } catch (e) {
                log(`✘ ${e?.error?.message || e?.message || 'trade error'}`);
                // eslint-disable-next-line no-await-in-loop
                await new Promise(res => setTimeout(res, 1500));
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(res => setTimeout(res, speed === 'fast' ? 700 : 250));
        }
    };

    const stop = () => {
        log('Stopped by user');
        if (run_ref.current) stopRun(null, 0, run_ref.current);
        setRunning(false);
    };

    return (
        <div className='speedbot'>
            <div className='speedbot__panel'>
                <div className='speedbot__title'>Speedbot</div>
                <div className='speedbot__subtitle'>Execute a trade on every cycle with TP/SL protection. Demo first.</div>

                {!is_logged_in && <div className='speedbot__warn'>Sign in with your Deriv account to run Speedbot.</div>}

                <div className='speedbot__startbar'>
                    <button
                        className={`speedbot__start ${running ? 'speedbot__start--stop' : ''}`}
                        disabled={!is_logged_in}
                        onClick={running ? stop : start}
                    >
                        {running ? '■ STOP' : '▶ START'}
                    </button>
                    <div className='speedbot__speed'>
                        <span className='speedbot__speed-label'>Execution speed</span>
                        <div className='speedbot__speed-btns'>
                            <button
                                className={speed === 'fast' ? 'active' : ''}
                                onClick={() => setSpeed('fast')}
                                disabled={running}
                            >
                                ⚡ Fast
                            </button>
                            <button
                                className={speed === 'normal' ? 'active' : ''}
                                onClick={() => setSpeed('normal')}
                                disabled={running}
                            >
                                ▶▶ Normal
                            </button>
                        </div>
                    </div>
                </div>

                <div className='speedbot__row speedbot__row--market'>
                    <select value={symbol} disabled={running} onChange={e => {
                        setSymbol(e.target.value);
                        setTimeout(() => window.dispatchEvent(new Event('nlb-speed-symbol')), 0);
                    }}>
                        {MARKETS.map(m => (
                            <option key={m.code} value={m.code}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                    <div className='speedbot__quote'>{quote ?? '—'}</div>
                </div>

                <div className='speedbot__row'>
                    <select value={type_code} disabled={running} onChange={e => setTypeCode(e.target.value)}>
                        {TYPES.map(t => (
                            <option key={t.code} value={t.code}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className='speedbot__grid'>
                    <div className='speedbot__field'>
                        <span>Ticks</span>
                        <input type='number' min={1} max={10} value={duration} disabled={running} onChange={e => setDuration(Math.min(10, Math.max(1, parseInt(e.target.value || 1, 10))))} />
                    </div>
                    <div className='speedbot__field'>
                        <span>Stake</span>
                        <input type='number' min='0.35' step='0.01' value={stake} disabled={running} onChange={e => setStake(e.target.value)} />
                    </div>
                    <div className='speedbot__field'>
                        <span>Take Profit</span>
                        <input type='number' min='0' step='1' value={tp} disabled={running} onChange={e => setTp(e.target.value)} />
                    </div>
                    <div className='speedbot__field'>
                        <span>Stop Loss</span>
                        <input type='number' min='0' step='1' value={sl} disabled={running} onChange={e => setSl(e.target.value)} />
                    </div>
                </div>

                <div className='speedbot__toggles'>
                    <label className='speedbot__toggle'>
                        <span>Alternate Even and Odd</span>
                        <input type='checkbox' checked={alt_eo} disabled={running} onChange={e => setAltEo(e.target.checked)} />
                        <i />
                    </label>
                    <label className='speedbot__toggle'>
                        <span>Alternate on Loss</span>
                        <input type='checkbox' checked={alt_on_loss} disabled={running} onChange={e => setAltOnLoss(e.target.checked)} />
                        <i />
                    </label>
                    <label className='speedbot__toggle'>
                        <span>Enable Martingale</span>
                        <input type='checkbox' checked={martingale} disabled={running} onChange={e => setMartingale(e.target.checked)} />
                        <i />
                    </label>
                    {martingale && (
                        <div className='speedbot__field speedbot__field--inline'>
                            <span>Martingale Multiplier</span>
                            <input type='number' min='1' max='5' step='0.05' value={mult} disabled={running} onChange={e => setMult(e.target.value)} />
                        </div>
                    )}
                </div>

                {martingale && (
                    <div className='speedbot__mart-warn'>
                        Martingale multiplies stake after losses — it can drain a balance fast. Capped at{' '}
                        {MAX_MARTINGALE_STEPS} steps, then stake resets.
                    </div>
                )}

                <div className='speedbot__status'>
                    <div>
                        <span>Ticks</span>
                        {stats.ticks}
                    </div>
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

                {logs.length > 0 && (
                    <div className='speedbot__log'>
                        {logs.map((l, i) => (
                            <div key={i}>{l}</div>
                        ))}
                    </div>
                )}

                <div className='speedbot__disclaimer'>
                    Every cycle stakes real balance on random tick outcomes. TP/SL limit a session — they don't create an
                    edge.
                </div>
            </div>

            {result && (
                <div className='speedbot__overlay' role='dialog'>
                    <div className={`speedbot__popup ${result.pnl >= 0 ? 'speedbot__popup--win' : 'speedbot__popup--loss'}`}>
                        <button className='speedbot__popup-close' onClick={() => setResult(null)}>
                            ✕
                        </button>
                        <div className='speedbot__popup-tag'>{result.reason}</div>
                        <div className='speedbot__popup-amount'>
                            {result.pnl >= 0 ? '+' : ''}
                            {result.pnl.toFixed(2)}
                        </div>
                        <div className='speedbot__popup-grid'>
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

export default Speedbot;
