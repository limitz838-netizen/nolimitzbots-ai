// @ts-nocheck — Nolimitz AI replaces the legacy Speedbot UI while preserving
// the proven Deriv execution / settlement plumbing underneath.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import Guide, { GuideButton } from '@/components/shared/nlb/guide';
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

const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
};

const STRATEGIES = [
    { id: 'alpha', label: 'Alpha', note: 'Balanced execution' },
    { id: 'quantum', label: 'Quantum', note: 'Dual confirmation' },
    { id: 'apex', label: 'Apex', note: 'Strict filtering' },
];

const CONTRACTS = [
    { id: 'rise_fall', label: 'Rise/Fall', symbol: '↕', available: true },
    { id: 'even_odd', label: 'Even/Odd', symbol: '#', available: true },
    { id: 'match', label: 'Match', symbol: '=', available: false, note: 'Matches Pro' },
    { id: 'over_under', label: 'Over/Under', symbol: '⌃', available: true, recommended: true },
    { id: 'differ', label: 'Differ', symbol: '/', available: false, note: 'Coming next' },
    { id: 'mix', label: 'Mix', symbol: '⌁', available: false, note: 'Coming next' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const maxMartingaleSteps = risk => (risk === 'high' ? 4 : risk === 'medium' ? 2 : 0);

const NolimitzAI = observer(() => {
    const { client, run_panel, transactions, summary_card } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const loginid = client?.loginid || 'NOT CONNECTED';
    const currency = client?.currency || 'USD';
    const balance = Number(client?.balance ?? 0);
    const is_demo = loginid.startsWith('VRT') || loginid.startsWith('VRTC');

    const [symbol, setSymbol] = React.useState('1HZ100V');
    const [strategy, setStrategy] = React.useState('quantum');
    const [contract, setContract] = React.useState('over_under');
    const [direction, setDirection] = React.useState('over');
    const [risk, setRisk] = React.useState('low');
    const [duration, setDuration] = React.useState(1);
    const [stake, setStake] = React.useState('0.5');
    const [tp, setTp] = React.useState('10');
    const [sl, setSl] = React.useState('5');
    const [optimization, setOptimization] = React.useState(true);
    const [martingale, setMartingale] = React.useState(false);
    const [mult, setMult] = React.useState('1.5');

    const [digits, setDigits] = React.useState([]);
    const [quote, setQuote] = React.useState(null);
    const [running, setRunning] = React.useState(false);
    const [stats, setStats] = React.useState({
        ticks: 0,
        last_digit: null,
        pnl: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        cur_stake: 0,
    });
    const [logs, setLogs] = React.useState([]);
    const [result, setResult] = React.useState(null);
    const [guide_open, setGuideOpen] = React.useState(false);

    const run_ref = React.useRef(null);
    const settle_handles_ref = React.useRef(new Set());
    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const sym_ref = React.useRef(symbol);
    sym_ref.current = symbol;

    const log = line =>
        setLogs(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 50));

    React.useEffect(() => {
        let alive = true;
        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;

        const subscribe = () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            setDigits([]);
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(
                JSON.stringify({
                    ticks_history: sym_ref.current,
                    count: 120,
                    end: 'latest',
                    style: 'ticks',
                    subscribe: 1,
                })
            );
        };

        ws.onopen = () => {
            if (!alive) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            subscribe();
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
                    if (code && typeof s.pip === 'number') {
                        decimals_ref.current[code] = `${s.pip}`.split('.')[1]?.length ?? 0;
                    }
                });
                return;
            }

            if (data.msg_type === 'history' && data.echo_req?.ticks_history === sym_ref.current) {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const prices = data.history?.prices || [];
                const ds = prices.map(pr => Number(Number(pr).toFixed(dec).slice(-1)));
                setDigits(ds.slice(-120));
                if (prices.length) setQuote(Number(prices[prices.length - 1]).toFixed(dec));
                return;
            }

            if (data.msg_type === 'tick' && data.tick?.symbol === sym_ref.current) {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const q = Number(data.tick.quote).toFixed(dec);
                const d = Number(q.slice(-1));
                setQuote(q);
                setDigits(prev => [...prev, d].slice(-120));
                setStats(prev => ({ ...prev, ticks: prev.ticks + 1, last_digit: d }));
            }
        };

        const resub = () => subscribe();
        window.addEventListener('nlb-ai-symbol', resub);

        return () => {
            alive = false;
            window.removeEventListener('nlb-ai-symbol', resub);
            if (run_ref.current) run_ref.current.active = false;
            settle_handles_ref.current.forEach(h => h.cancel());
            settle_handles_ref.current.clear();
            try {
                ws.close();
            } catch {
                /* noop */
            }
        };
    }, []);

    const evenCount = digits.filter(d => d % 2 === 0).length;
    const evenPct = digits.length ? (100 * evenCount) / digits.length : 50;
    const over2Pct = digits.length ? (100 * digits.filter(d => d > 2).length) / digits.length : 70;
    const under7Pct = digits.length ? (100 * digits.filter(d => d < 7).length) / digits.length : 70;

    const contractSpec = React.useMemo(() => {
        if (contract === 'rise_fall') {
            return direction === 'fall'
                ? { type: 'PUT', label: 'Fall' }
                : { type: 'CALL', label: 'Rise' };
        }

        if (contract === 'even_odd') {
            let side = direction;
            if (optimization && strategy !== 'alpha') {
                if (evenPct >= 52) side = 'even';
                else if (evenPct <= 48) side = 'odd';
            }
            return side === 'odd'
                ? { type: 'DIGITODD', label: 'Odd', liveRate: 100 - evenPct }
                : { type: 'DIGITEVEN', label: 'Even', liveRate: evenPct };
        }

        if (contract === 'over_under') {
            let side = direction;
            if (optimization && strategy !== 'alpha') {
                if (over2Pct > under7Pct) side = 'over';
                else if (under7Pct > over2Pct) side = 'under';
            }
            return side === 'under'
                ? { type: 'DIGITUNDER', label: 'Under 7', barrier: 7, liveRate: under7Pct }
                : { type: 'DIGITOVER', label: 'Over 2', barrier: 2, liveRate: over2Pct };
        }

        return null;
    }, [contract, direction, optimization, strategy, evenPct, over2Pct, under7Pct]);

    const strategyGate = React.useCallback(() => {
        if (!contractSpec) return { ok: false, reason: 'This contract mode is not enabled yet.' };
        if (strategy === 'alpha') return { ok: true };

        if (contract === 'even_odd') {
            const edge = Math.abs(evenPct - 50);
            const need = strategy === 'apex' ? 4 : 2;
            return edge >= need
                ? { ok: true }
                : { ok: false, reason: `Waiting for stronger Even/Odd separation (${edge.toFixed(1)}%, need ${need}%).` };
        }

        if (contract === 'over_under') {
            const rate = Number(contractSpec.liveRate || 0);
            const need = strategy === 'apex' ? 73 : 71;
            return rate >= need
                ? { ok: true }
                : { ok: false, reason: `Waiting for ${contractSpec.label} history rate ≥ ${need}% (now ${rate.toFixed(1)}%).` };
        }

        // Rise/Fall currently uses execution controls only; digit history does not
        // provide a legitimate directional price signal.
        if (contract === 'rise_fall' && strategy !== 'alpha') {
            return { ok: false, reason: 'Rise/Fall confirmation model is not enabled yet. Use Alpha for manual direction.' };
        }

        return { ok: true };
    }, [contractSpec, strategy, contract, evenPct]);

    const settleContract = contract_id =>
        new Promise(resolve => {
            const handle = trackContracts([contract_id], {
                timeoutMs: (duration + 30) * 1000,
                onContract: contractUpdate => {
                    try {
                        transactions?.onBotContractEvent?.(contractUpdate);
                        summary_card?.onBotContractEvent?.(contractUpdate);
                    } catch {
                        /* display mirroring must not interrupt trading */
                    }
                },
                onDone: ({ profits, settled }) => {
                    settle_handles_ref.current.delete(handle);
                    const values = Object.values(profits);
                    resolve(settled > 0 ? values[0] : null);
                },
            });
            settle_handles_ref.current.add(handle);
        });

    const buyOnce = async (spec, amount) => {
        const req = {
            proposal: 1,
            amount,
            basis: 'stake',
            contract_type: spec.type,
            currency,
            duration,
            duration_unit: 't',
            underlying_symbol: symbol,
            ...(spec.barrier !== undefined ? { barrier: String(spec.barrier) } : {}),
        };
        const prop = await api_base.api.send(req);
        const id = prop?.proposal?.id;
        if (!id) throw new Error('No proposal returned');
        const res = await api_base.api.send({ buy: id, price: Number(prop.proposal.ask_price) });
        return res?.buy?.contract_id;
    };

    const stopRun = (reason, r) => {
        if (!r) return;
        r.active = false;
        run_ref.current = null;
        setRunning(false);
        try {
            run_panel?.setIsRunning?.(false);
        } catch {
            /* noop */
        }

        if (reason) {
            const won = r.pnl >= 0;
            if (won) playWin();
            else playLoss();
            setResult({ reason, pnl: r.pnl, trades: r.trades, wins: r.wins, losses: r.losses });
        }
    };

    const start = async () => {
        if (running || !is_logged_in || !api_base?.api || !contractSpec) return;

        const baseStake = Math.max(0.35, parseFloat(stake) || 0.5);
        const tpValue = Math.max(0, parseFloat(tp) || 0);
        const slValue = Math.max(0, parseFloat(sl) || 0);
        const multiplier = clamp(parseFloat(mult) || 1.5, 1, 3);
        const maxSteps = maxMartingaleSteps(risk);

        unlockAudio();
        setResult(null);
        setLogs([]);

        const r = {
            active: true,
            pnl: 0,
            trades: 0,
            wins: 0,
            losses: 0,
            curStake: baseStake,
            steps: 0,
        };

        run_ref.current = r;
        setRunning(true);
        try {
            run_panel.run_id = `nolimitz-ai-${Date.now()}`;
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* noop */
        }

        log(`Nolimitz AI started · ${STRATEGIES.find(x => x.id === strategy)?.label} · ${symbol}`);

        while (r.active) {
            if (tpValue > 0 && r.pnl >= tpValue) {
                log(`Profit target reached: +${r.pnl.toFixed(2)}`);
                stopRun('Profit target reached', r);
                return;
            }
            if (slValue > 0 && r.pnl <= -slValue) {
                log(`Maximum loss reached: ${r.pnl.toFixed(2)}`);
                stopRun('Maximum loss reached', r);
                return;
            }

            const gate = strategyGate();
            if (!gate.ok) {
                log(gate.reason);
                // eslint-disable-next-line no-await-in-loop
                await new Promise(res => setTimeout(res, 1200));
                continue;
            }

            const liveSpec = contractSpec;
            try {
                setStats(prev => ({ ...prev, cur_stake: r.curStake }));
                // eslint-disable-next-line no-await-in-loop
                const cid = await buyOnce(liveSpec, Number(r.curStake.toFixed(2)));
                if (!cid) throw new Error('No contract id returned');
                log(`Trade · ${liveSpec.label} · ${currency} ${r.curStake.toFixed(2)}`);

                // eslint-disable-next-line no-await-in-loop
                const profit = await settleContract(cid);
                if (profit === null) {
                    log('Settlement timeout — no result counted.');
                    continue;
                }

                const won = profit > 0;
                r.trades += 1;
                r.pnl += profit;

                if (won) {
                    r.wins += 1;
                    r.steps = 0;
                    r.curStake = baseStake;
                } else {
                    r.losses += 1;
                    if (martingale && maxSteps > 0) {
                        r.steps += 1;
                        if (r.steps > maxSteps) {
                            r.steps = 0;
                            r.curStake = baseStake;
                        } else {
                            r.curStake = Math.min(r.curStake * multiplier, baseStake * 10);
                        }
                    } else {
                        r.curStake = baseStake;
                    }
                }

                setStats(prev => ({
                    ...prev,
                    pnl: r.pnl,
                    trades: r.trades,
                    wins: r.wins,
                    losses: r.losses,
                    cur_stake: r.curStake,
                }));

                log(`${won ? 'WIN' : 'LOSS'} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} · P/L ${r.pnl.toFixed(2)}`);
            } catch (e) {
                log(`Trade error · ${describeError(e)}`);
                // eslint-disable-next-line no-await-in-loop
                await new Promise(res => setTimeout(res, 1500));
            }

            // eslint-disable-next-line no-await-in-loop
            await new Promise(res => setTimeout(res, risk === 'high' ? 350 : risk === 'medium' ? 700 : 1100));
        }
    };

    const stop = () => {
        log('Stopped by user');
        settle_handles_ref.current.forEach(h => h.cancel());
        settle_handles_ref.current.clear();
        if (run_ref.current) stopRun(null, run_ref.current);
        setRunning(false);
    };

    const currentStrategy = STRATEGIES.find(x => x.id === strategy);
    const winRate = stats.trades ? (100 * stats.wins) / stats.trades : 0;

    return (
        <div className='nolimitz-ai'>
            <div className='nolimitz-ai__shell'>
                <div className='nolimitz-ai__hero'>
                    <div>
                        <span className='nolimitz-ai__eyebrow'>NOLIMITZBOTS</span>
                        <h1><span>Nolimitz AI</span> Trading Dashboard</h1>
                        <p>Automated Deriv execution with live controls, strategy filters and session risk limits.</p>
                    </div>
                    <GuideButton onClick={() => setGuideOpen(true)} />
                </div>
                <Guide tool='speedbot' open={guide_open} onClose={() => setGuideOpen(false)} />

                <section className='nolimitz-ai__account'>
                    <div className='nolimitz-ai__account-top'>
                        <div className='nolimitz-ai__account-id'>
                            <div className='nolimitz-ai__avatar'>NL</div>
                            <div>
                                <small>CONNECTED ACCOUNT</small>
                                <strong>{loginid}</strong>
                            </div>
                        </div>
                        <span className={`nolimitz-ai__account-type ${is_demo ? 'demo' : 'real'}`}>
                            <i /> {is_demo ? 'DEMO' : 'REAL'}
                        </span>
                    </div>
                    <div className='nolimitz-ai__balance'>
                        <small>LIVE BALANCE</small>
                        <strong>{balance.toFixed(2)} <span>{currency}</span></strong>
                        <div className='nolimitz-ai__live-dot'>● <span>LIVE</span></div>
                    </div>
                </section>

                {!is_logged_in && (
                    <div className='nolimitz-ai__warning'>Connect your Deriv account before starting Nolimitz AI.</div>
                )}

                <section className='nolimitz-ai__card nolimitz-ai__card--engine'>
                    <div className='nolimitz-ai__card-head'>
                        <div className='nolimitz-ai__brand-icon'>✦</div>
                        <div>
                            <span className='nolimitz-ai__tag'>NOLIMITZ AI</span>
                            <h2>Automated Trading Engine</h2>
                        </div>
                        <span className='nolimitz-ai__mode-badge'>{running ? 'RUNNING' : 'READY'}</span>
                    </div>

                    <div className='nolimitz-ai__field-label'>MARKET</div>
                    <div className='nolimitz-ai__market-row'>
                        <select
                            value={symbol}
                            disabled={running}
                            onChange={e => {
                                setSymbol(e.target.value);
                                setTimeout(() => window.dispatchEvent(new Event('nlb-ai-symbol')), 0);
                            }}
                        >
                            {MARKETS.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
                        </select>
                        <div className='nolimitz-ai__quote'>
                            <small>LIVE TICK</small>
                            <strong>{quote ?? '—'}</strong>
                        </div>
                    </div>

                    <div className='nolimitz-ai__field-label'>TRADING STRATEGY</div>
                    <div className='nolimitz-ai__segmented'>
                        {STRATEGIES.map(s => (
                            <button
                                key={s.id}
                                disabled={running}
                                className={strategy === s.id ? 'active' : ''}
                                onClick={() => setStrategy(s.id)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <div className='nolimitz-ai__strategy-note'>
                        {currentStrategy?.note} · {strategy === 'alpha' ? 'manual contract direction' : 'waits for live history confirmation'}
                    </div>

                    <div className='nolimitz-ai__field-label'>CONTRACT TYPE</div>
                    <div className='nolimitz-ai__contracts'>
                        {CONTRACTS.map(item => (
                            <button
                                key={item.id}
                                disabled={running || !item.available}
                                className={`${contract === item.id ? 'active' : ''} ${item.recommended ? 'recommended' : ''}`}
                                onClick={() => item.available && setContract(item.id)}
                            >
                                <b>{item.symbol}</b>
                                <span>{item.label}</span>
                                {item.recommended && <small>RECOMMENDED</small>}
                                {!item.available && <small>{item.note}</small>}
                            </button>
                        ))}
                    </div>

                    {contract === 'rise_fall' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'rise' ? 'active' : ''} onClick={() => setDirection('rise')} disabled={running}>RISE</button>
                            <button className={direction === 'fall' ? 'active' : ''} onClick={() => setDirection('fall')} disabled={running}>FALL</button>
                        </div>
                    )}
                    {contract === 'even_odd' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'even' ? 'active' : ''} onClick={() => setDirection('even')} disabled={running}>EVEN</button>
                            <button className={direction === 'odd' ? 'active' : ''} onClick={() => setDirection('odd')} disabled={running}>ODD</button>
                        </div>
                    )}
                    {contract === 'over_under' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'over' ? 'active' : ''} onClick={() => setDirection('over')} disabled={running}>OVER 2</button>
                            <button className={direction === 'under' ? 'active' : ''} onClick={() => setDirection('under')} disabled={running}>UNDER 7</button>
                        </div>
                    )}

                    <div className='nolimitz-ai__field-label'>STAKE SIZE [{currency}]</div>
                    <div className='nolimitz-ai__stepper'>
                        <button disabled={running} onClick={() => setStake(String(Math.max(0.35, (parseFloat(stake) || 0.5) - 0.5).toFixed(2)))}>−</button>
                        <input value={stake} disabled={running} onChange={e => setStake(e.target.value)} />
                        <button disabled={running} onClick={() => setStake(String(((parseFloat(stake) || 0.5) + 0.5).toFixed(2)))}>+</button>
                    </div>

                    <label className='nolimitz-ai__optimization'>
                        <span>
                            <b>ENABLE OPTIMIZATION</b>
                            <small>Uses recent tick distribution as an entry filter, not a guarantee.</small>
                        </span>
                        <input type='checkbox' checked={optimization} disabled={running} onChange={e => setOptimization(e.target.checked)} />
                        <i />
                    </label>

                    <div className='nolimitz-ai__field-label'>RISK LEVEL</div>
                    <div className='nolimitz-ai__risk-tabs'>
                        {['low', 'medium', 'high'].map(level => (
                            <button
                                key={level}
                                className={risk === level ? 'active' : ''}
                                disabled={running}
                                onClick={() => {
                                    setRisk(level);
                                    if (level === 'low') setMartingale(false);
                                }}
                            >
                                {level.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    <div className='nolimitz-ai__targets'>
                        <label>
                            <span>PROFIT TARGET</span>
                            <div><b>◎</b><input value={tp} disabled={running} onChange={e => setTp(e.target.value)} /><small>{currency}</small></div>
                        </label>
                        <label>
                            <span>MAXIMUM LOSS</span>
                            <div><b>♢</b><input value={sl} disabled={running} onChange={e => setSl(e.target.value)} /><small>{currency}</small></div>
                        </label>
                    </div>

                    <div className='nolimitz-ai__advanced'>
                        <label>
                            <span>Martingale</span>
                            <input
                                type='checkbox'
                                checked={martingale}
                                disabled={running || risk === 'low'}
                                onChange={e => setMartingale(e.target.checked)}
                            />
                            <i />
                        </label>
                        {martingale && (
                            <div className='nolimitz-ai__multiplier'>
                                <span>Factor</span>
                                <input value={mult} disabled={running} onChange={e => setMult(e.target.value)} />
                                <small>Max {maxMartingaleSteps(risk)} recovery steps</small>
                            </div>
                        )}
                        <div className='nolimitz-ai__duration'>
                            <span>Contract duration</span>
                            <select value={duration} disabled={running} onChange={e => setDuration(clamp(parseInt(e.target.value || 1, 10), 1, 10))}>
                                {[1,2,3,4,5,10].map(v => <option key={v} value={v}>{v} tick{v > 1 ? 's' : ''}</option>)}
                            </select>
                        </div>
                    </div>

                    <button
                        className={`nolimitz-ai__run ${running ? 'stop' : ''}`}
                        disabled={!is_logged_in}
                        onClick={running ? stop : start}
                    >
                        {running ? '■ STOP NOLIMITZ AI' : '⚡ RUN NOLIMITZ AI'}
                    </button>
                </section>

                <section className='nolimitz-ai__session'>
                    <div>
                        <span>TRADES</span>
                        <strong>{stats.trades}</strong>
                    </div>
                    <div>
                        <span>WINS / LOSSES</span>
                        <strong>{stats.wins}/{stats.losses}</strong>
                    </div>
                    <div>
                        <span>HIT RATE</span>
                        <strong>{stats.trades ? `${winRate.toFixed(1)}%` : '—'}</strong>
                    </div>
                    <div className={stats.pnl >= 0 ? 'positive' : 'negative'}>
                        <span>SESSION P/L</span>
                        <strong>{stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(2)} {currency}</strong>
                    </div>
                </section>

                <div className='nolimitz-ai__signal'>
                    <span>CURRENT ENGINE PICK</span>
                    <strong>{contractSpec ? contractSpec.label : 'WAITING'}</strong>
                    <small>
                        {contractSpec?.liveRate !== undefined
                            ? `Recent history rate: ${contractSpec.liveRate.toFixed(1)}%`
                            : 'Execution mode ready'}
                    </small>
                </div>

                {logs.length > 0 && (
                    <section className='nolimitz-ai__log'>
                        {logs.map((line, index) => <div key={index}>{line}</div>)}
                    </section>
                )}

                <div className='nolimitz-ai__disclaimer'>
                    Nolimitz AI automates execution and risk rules. Digit/tick outcomes remain probabilistic; filters do not guarantee profit.
                </div>
            </div>

            {result && (
                <div className='nolimitz-ai__overlay'>
                    <div className={`nolimitz-ai__result ${result.pnl >= 0 ? 'win' : 'loss'}`}>
                        <button onClick={() => setResult(null)}>×</button>
                        <small>{result.reason}</small>
                        <h3>{result.pnl >= 0 ? '+' : ''}{result.pnl.toFixed(2)} {currency}</h3>
                        <div>
                            <span>Trades <b>{result.trades}</b></span>
                            <span>Wins <b>{result.wins}</b></span>
                            <span>Losses <b>{result.losses}</b></span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default NolimitzAI;
