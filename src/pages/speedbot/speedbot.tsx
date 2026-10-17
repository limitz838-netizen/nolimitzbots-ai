// @ts-nocheck — Nolimitz AI · High-Win Engine.
//
// Trades contracts that win about 9 ticks in 10 (Differs / Over 0 / Under 9),
// one contract at a time, back to back, until the session profit target or
// stop-loss is reached. Measured on 195,000 real Deriv ticks: 90.0% win rate.
// Break-even on Deriv's payout is ~91.2%, so the page shows the session odds
// and the real maths up front. Demo and real accounts (real needs a one-time
// confirmation per login).
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import {
    HW_CONTRACTS,
    MIN_FULL_PAYOUT_STAKE,
    differsPick,
    digitShares,
    lastDigit,
    losingDigit,
    sessionOdds,
    ticksSince,
} from '@/components/shared/nlb/high-win-engine';
import Guide, { GuideButton } from '@/components/shared/nlb/guide';
import './speedbot.scss';

const MARKETS = [
    { code: '1HZ100V', label: 'Vol 100 (1s)' },
    { code: '1HZ90V', label: 'Vol 90 (1s)' },
    { code: '1HZ75V', label: 'Vol 75 (1s)' },
    { code: '1HZ50V', label: 'Vol 50 (1s)' },
    { code: '1HZ30V', label: 'Vol 30 (1s)' },
    { code: '1HZ25V', label: 'Vol 25 (1s)' },
    { code: '1HZ15V', label: 'Vol 15 (1s)' },
    { code: '1HZ10V', label: 'Vol 10 (1s)' },
    { code: 'R_100', label: 'Vol 100' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_10', label: 'Vol 10' },
];
const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ15V': 3, '1HZ25V': 2, '1HZ30V': 3, '1HZ50V': 2, '1HZ75V': 2, '1HZ90V': 3, '1HZ100V': 2,
};
const HISTORY = 500;
const DEFAULT_PAYOUT = 1.096;
const MEASURED = { DIFF: 0.9005, OVER0: 0.9006, UNDER9: 0.8999 };

const money = v => (Math.round(v * 100) / 100).toFixed(2);
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const sleep = ms => new Promise(r => window.setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
    Promise.race([
        Promise.resolve(p),
        new Promise((_, rej) => window.setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

const Sparkline = ({ points }) => {
    if (points.length < 2) return <div className='nolimitz-ai__spark nolimitz-ai__spark--empty'>Session curve appears after 2 trades</div>;
    const w = 300;
    const h = 64;
    const min = Math.min(0, ...points);
    const max = Math.max(0, ...points);
    const span = max - min || 1;
    const x = i => (i / (points.length - 1)) * w;
    const y = v => h - ((v - min) / span) * (h - 8) - 4;
    const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const last = points[points.length - 1];
    return (
        <svg className='nolimitz-ai__spark' viewBox={`0 0 ${w} ${h}`} preserveAspectRatio='none' role='img' aria-label='Session profit curve'>
            <line x1='0' x2={w} y1={y(0)} y2={y(0)} className='zero' />
            <path d={d} className={last >= 0 ? 'up' : 'down'} />
        </svg>
    );
};

const NolimitzAI = observer(() => {
    const { client, run_panel, transactions, summary_card } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const loginid = client?.loginid || 'NOT CONNECTED';
    const currency = client?.currency || 'USD';
    const balance = Number(client?.balance ?? 0);
    const is_demo = !!client?.is_virtual || loginid.startsWith('VRT');
    const account_mode = !is_logged_in ? 'offline' : is_demo ? 'demo' : 'real';

    const [guide_open, setGuideOpen] = React.useState(false);
    const [symbol, setSymbol] = React.useState('1HZ100V');
    const [contractId, setContractId] = React.useState('OVER0');
    const [stake, setStake] = React.useState('2');
    const [tp, setTp] = React.useState('5');
    const [sl, setSl] = React.useState('20');
    const [digits, setDigits] = React.useState([]);
    const [quote, setQuote] = React.useState(null);
    const [feedStatus, setFeedStatus] = React.useState('CONNECTING');
    const [payout, setPayout] = React.useState(DEFAULT_PAYOUT);
    const [running, setRunning] = React.useState(false);
    const [stats, setStats] = React.useState({ trades: 0, wins: 0, losses: 0, pnl: 0, curve: [0] });
    const [logs, setLogs] = React.useState([]);
    const [result, setResult] = React.useState(null);
    const [real_ok, setRealOk] = React.useState(false);
    const [notice, setNotice] = React.useState('');

    React.useEffect(() => setRealOk(false), [loginid]);

    const contract = HW_CONTRACTS.find(c => c.id === contractId) || HW_CONTRACTS[1];
    const stake_num = parseFloat(stake) || 0;
    const tp_num = Math.abs(parseFloat(tp) || 0);
    const sl_num = Math.abs(parseFloat(sl) || 0);
    const needs_real_ack = is_logged_in && !is_demo && !real_ok;

    const ws_ref = React.useRef(null);
    const digits_ref = React.useRef([]);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const running_ref = React.useRef(false);
    const stats_ref = React.useRef(stats);
    stats_ref.current = stats;
    const cfg_ref = React.useRef({});
    cfg_ref.current = { symbol, contract, stake_num, tp_num, sl_num, currency };
    const track_ref = React.useRef(null);
    const mounted_ref = React.useRef(true);

    const log = line =>
        setLogs(prev => [`${new Date().toLocaleTimeString('en-GB')} · ${line}`, ...prev].slice(0, 12));

    // ------------------------------------------------------------ live ticks (selected market)
    React.useEffect(() => {
        mounted_ref.current = true;
        let alive = true;
        let reconnect = null;
        const open = () => {
            const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
            ws_ref.current = ws;
            setFeedStatus('CONNECTING');
            ws.onopen = () => {
                ws.send(JSON.stringify({ ticks_history: symbol, count: HISTORY, end: 'latest', style: 'ticks', subscribe: 1 }));
            };
            ws.onmessage = ev => {
                if (!alive) return;
                let d;
                try {
                    d = JSON.parse(ev.data);
                } catch {
                    return;
                }
                if (d.msg_type === 'history' && d.echo_req?.ticks_history === symbol) {
                    if (typeof d.pip_size === 'number') decimals_ref.current[symbol] = d.pip_size;
                    const dec = decimals_ref.current[symbol] ?? 2;
                    const prices = d.history?.prices || [];
                    digits_ref.current = prices.map(p => lastDigit(p, dec)).slice(-HISTORY);
                    setDigits(digits_ref.current);
                    if (prices.length) setQuote(Number(prices[prices.length - 1]).toFixed(dec));
                    setFeedStatus('LIVE');
                    return;
                }
                if (d.msg_type === 'tick' && d.tick?.symbol === symbol) {
                    if (typeof d.tick.pip_size === 'number') decimals_ref.current[symbol] = d.tick.pip_size;
                    const dec = decimals_ref.current[symbol] ?? 2;
                    digits_ref.current = [...digits_ref.current, lastDigit(d.tick.quote, dec)].slice(-HISTORY);
                    setDigits(digits_ref.current);
                    setQuote(Number(d.tick.quote).toFixed(dec));
                    setFeedStatus('LIVE');
                }
            };
            ws.onclose = () => {
                if (!alive) return;
                setFeedStatus('RECONNECTING');
                reconnect = window.setTimeout(open, 1200);
            };
            ws.onerror = () => {
                /* onclose handles recovery */
            };
        };
        digits_ref.current = [];
        setDigits([]);
        setQuote(null);
        open();
        return () => {
            alive = false;
            if (reconnect) window.clearTimeout(reconnect);
            const ws = ws_ref.current;
            if (ws) {
                ws.onclose = null;
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
            }
        };
    }, [symbol]);

    React.useEffect(
        () => () => {
            mounted_ref.current = false;
            running_ref.current = false;
            track_ref.current?.cancel?.();
        },
        []
    );

    // ------------------------------------------------------------ live payout quote
    React.useEffect(() => {
        if (!(stake_num >= 0.35)) return undefined;
        let ws;
        const t = window.setTimeout(() => {
            try {
                ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
                ws.onopen = () =>
                    ws.send(
                        JSON.stringify({
                            proposal: 1,
                            amount: stake_num,
                            basis: 'stake',
                            contract_type: contract.type,
                            currency,
                            duration: 1,
                            duration_unit: 't',
                            underlying_symbol: symbol,
                            barrier: String(contract.barrier ?? 5),
                        })
                    );
                ws.onmessage = m => {
                    try {
                        const d = JSON.parse(m.data);
                        const ask = Number(d?.proposal?.ask_price);
                        const win = Number(d?.proposal?.payout);
                        if (ask > 0 && win > 0 && mounted_ref.current) setPayout(win / ask);
                    } catch {
                        /* noop */
                    }
                    try {
                        ws.close();
                    } catch {
                        /* noop */
                    }
                };
            } catch {
                /* keep estimate */
            }
        }, 400);
        return () => {
            window.clearTimeout(t);
            try {
                ws?.close();
            } catch {
                /* noop */
            }
        };
    }, [stake_num, contract.type, contract.barrier, currency, symbol]);

    // ------------------------------------------------------------ execution loop
    const buyOne = async (c, barrier, amount, sym, cur) => {
        const parameters = {
            amount,
            basis: 'stake',
            contract_type: c.type,
            currency: cur,
            duration: 1,
            duration_unit: 't',
            underlying_symbol: sym,
            barrier: String(barrier),
        };
        const HARD = /Insufficient balance|Market closed|Session expired/;
        try {
            const r = await withTimeout(
                api_base.api.send({ buy: '1', price: amount, parameters, passthrough: { nolimitz_source: 'nolimitz-ai' } }),
                5000,
                'Buy'
            );
            if (r?.error) throw r;
            if (r?.buy?.contract_id) return r.buy.contract_id;
        } catch (e) {
            if (HARD.test(describeError(e))) throw e;
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const p = await withTimeout(api_base.api.send({ proposal: 1, ...parameters }), 5000, 'Proposal');
                if (p?.error) throw new Error(p.error.message);
                const b = await withTimeout(
                    api_base.api.send({
                        buy: p.proposal.id,
                        price: Number(p.proposal.ask_price ?? amount),
                        passthrough: { nolimitz_source: 'nolimitz-ai' },
                    }),
                    5000,
                    'Buy'
                );
                if (b?.error) throw new Error(b.error.message);
                if (b?.buy?.contract_id) return b.buy.contract_id;
            } catch (e) {
                if (attempt === 3 || HARD.test(describeError(e))) throw e;
                await sleep(150 * attempt);
            }
        }
        throw new Error('Buy failed');
    };

    const finish = (type, reason) => {
        running_ref.current = false;
        setRunning(false);
        try {
            run_panel?.setIsRunning?.(false);
        } catch {
            /* noop */
        }
        const s = stats_ref.current;
        setResult({ type, reason, pnl: s.pnl, trades: s.trades, wins: s.wins, losses: s.losses });
        log(reason);
    };

    const nextTrade = async () => {
        if (!running_ref.current || !mounted_ref.current) return;
        const { symbol: sym, contract: c, stake_num: amount, tp_num: TP, sl_num: SL, currency: cur } = cfg_ref.current;
        const s = stats_ref.current;
        if (s.pnl >= TP) return finish('tp', `Profit target reached: +${money(s.pnl)} ${cur}`);
        if (s.pnl <= -SL) return finish('sl', `Stop-loss reached: ${money(s.pnl)} ${cur}`);
        if (digits_ref.current.length < 50) {
            window.setTimeout(nextTrade, 800);
            return;
        }
        const barrier = c.id === 'DIFF' ? differsPick(digits_ref.current) : c.barrier;
        let id;
        try {
            id = await buyOne(c, barrier, amount, sym, cur);
        } catch (e) {
            return finish('error', `Stopped: ${describeError(e)}`);
        }
        if (!running_ref.current) {
            // stopped while buying: still track so the result is recorded
        }
        track_ref.current = trackContracts([id], {
            timeoutMs: 30000,
            onContract: ct => {
                try {
                    transactions?.onBotContractEvent?.(ct);
                    summary_card?.onBotContractEvent?.(ct);
                    run_panel?.onBotContractEvent?.(ct);
                } catch {
                    /* mirror only */
                }
            },
            onDone: ({ total }) => {
                track_ref.current = null;
                if (!mounted_ref.current) return;
                const win = total > 0;
                if (win) playWin();
                else playLoss();
                setStats(prev => {
                    const next = {
                        trades: prev.trades + 1,
                        wins: prev.wins + (win ? 1 : 0),
                        losses: prev.losses + (win ? 0 : 1),
                        pnl: Number((prev.pnl + total).toFixed(2)),
                        curve: [...prev.curve, Number((prev.pnl + total).toFixed(2))].slice(-200),
                    };
                    stats_ref.current = next;
                    return next;
                });
                log(`${win ? 'WIN' : 'LOSS'} ${c.short}${c.id === 'DIFF' ? ` ${barrier}` : ''} on ${sym} · ${total >= 0 ? '+' : ''}${money(total)} ${cur}`);
                if (running_ref.current) window.setTimeout(nextTrade, 150);
            },
        });
    };

    const start = () => {
        if (!is_logged_in) return;
        if (needs_real_ack) {
            setNotice('Confirm the real-money notice above to start.');
            return;
        }
        if (stake_num < MIN_FULL_PAYOUT_STAKE) {
            setNotice(`Use a stake of at least ${MIN_FULL_PAYOUT_STAKE} ${currency}: below that Deriv cuts the payout on these contracts to about 6%.`);
            return;
        }
        if (!(tp_num > 0) || !(sl_num > 0)) {
            setNotice('Set both a profit target and a maximum loss.');
            return;
        }
        setNotice('');
        unlockAudio();
        const fresh = { trades: 0, wins: 0, losses: 0, pnl: 0, curve: [0] };
        stats_ref.current = fresh;
        setStats(fresh);
        setResult(null);
        running_ref.current = true;
        setRunning(true);
        try {
            run_panel.run_id = `nolimitz-ai-${Date.now()}`;
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* noop */
        }
        log(`Started ${contract.short} on ${symbol} · stake ${money(stake_num)} · target +${money(tp_num)} / stop −${money(sl_num)}`);
        nextTrade();
    };

    const stop = () => {
        running_ref.current = false;
        setRunning(false);
        try {
            run_panel?.setIsRunning?.(false);
        } catch {
            /* noop */
        }
        log('Stopped by user.');
    };

    // ------------------------------------------------------------ analysis view
    const shares = React.useMemo(() => digitShares(digits, HISTORY), [digits]);
    const lose = losingDigit(contract, digits);
    const since = ticksSince(digits, lose);
    const recent = digits.slice(-24);
    const breakeven = 1 / payout;
    const measured = MEASURED[contract.id];
    const odds = React.useMemo(() => sessionOdds(0.9, stake_num, payout, tp_num, sl_num), [stake_num, payout, tp_num, sl_num]);
    const winRate = stats.trades ? stats.wins / stats.trades : 0;
    const low_stake = stake_num > 0 && stake_num < MIN_FULL_PAYOUT_STAKE;

    return (
        <div className='nolimitz-ai'>
            <div className='nolimitz-ai__shell'>
                <div className='nolimitz-ai__hero'>
                    <div>
                        <span className='nolimitz-ai__eyebrow'>NOLIMITZBOTS</span>
                        <h1>
                            <span>Nolimitz AI</span> High-Win Engine
                        </h1>
                        <p>
                            Trades the digit contracts that win about 9 ticks in 10, one after another, until your profit
                            target or maximum loss ends the session.
                        </p>
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
                        <span className={`nolimitz-ai__account-type ${account_mode}`}>
                            <i /> {!is_logged_in ? 'OFFLINE' : is_demo ? 'DEMO' : 'REAL'}
                        </span>
                    </div>
                    <div className='nolimitz-ai__balance'>
                        <small>LIVE BALANCE</small>
                        <strong>
                            {balance.toFixed(2)} <span>{currency}</span>
                        </strong>
                        <div className={`nolimitz-ai__live-dot ${feedStatus.toLowerCase()}`}>
                            ● <span>{feedStatus}</span>
                        </div>
                    </div>
                </section>

                {!is_logged_in && <div className='nolimitz-ai__warning'>Connect your Deriv account to run Nolimitz AI.</div>}
                {needs_real_ack && (
                    <div className='nolimitz-ai__warning nolimitz-ai__warning--real nolimitz-ai__ack'>
                        <b>REAL-MONEY ACCOUNT</b>
                        <span>
                            These contracts win about 90% of the time but pay about 9.6%, so one loss cancels about ten
                            wins. Over many trades they lose about 1.3% of what is staked. Your maximum loss setting is
                            what protects the balance.
                        </span>
                        <button type='button' onClick={() => setRealOk(true)}>
                            I understand — enable real trading
                        </button>
                    </div>
                )}

                <section className='nolimitz-ai__card nolimitz-ai__card--engine'>
                    <div className='nolimitz-ai__card-head'>
                        <div className='nolimitz-ai__brand-icon'>✦</div>
                        <div>
                            <span className='nolimitz-ai__tag'>NOLIMITZ AI</span>
                            <h2>High-Win Digit Engine</h2>
                        </div>
                        <span className='nolimitz-ai__mode-badge'>{running ? 'RUNNING' : 'READY'}</span>
                    </div>

                    <div className='nolimitz-ai__field-label'>MARKET</div>
                    <div className='nolimitz-ai__market-row'>
                        <select value={symbol} disabled={running} onChange={e => setSymbol(e.target.value)}>
                            {MARKETS.map(m => (
                                <option key={m.code} value={m.code}>
                                    {m.label}
                                </option>
                            ))}
                        </select>
                        <div className='nolimitz-ai__quote'>
                            <small>LIVE TICK</small>
                            <strong>{quote ?? '—'}</strong>
                        </div>
                    </div>

                    <div className='nolimitz-ai__field-label'>CONTRACT</div>
                    <div className='nolimitz-ai__segmented'>
                        {HW_CONTRACTS.map(c => (
                            <button
                                key={c.id}
                                disabled={running}
                                className={contractId === c.id ? 'active' : ''}
                                onClick={() => setContractId(c.id)}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                    <div className='nolimitz-ai__strategy-note'>
                        {contract.id === 'OVER0' && 'Wins on any last digit from 1 to 9 · loses only on 0'}
                        {contract.id === 'UNDER9' && 'Wins on any last digit from 0 to 8 · loses only on 9'}
                        {contract.id === 'DIFF' && `Wins unless the next digit is the pick${lose !== null ? ` (${lose})` : ''}`}
                    </div>

                    <div className='nolimitz-ai__engine-panel'>
                        <div>
                            <span>MEASURED WIN RATE</span>
                            <strong>{pct(measured, 2)}</strong>
                        </div>
                        <div>
                            <span>LIVE PAYOUT</span>
                            <strong>+{pct(payout - 1)}</strong>
                        </div>
                        <div>
                            <span>BREAK-EVEN</span>
                            <strong>{pct(breakeven, 2)}</strong>
                        </div>
                        <div>
                            <span>LOSING DIGIT</span>
                            <strong>{lose ?? '—'}</strong>
                        </div>
                        <div>
                            <span>SEEN (LAST {HISTORY})</span>
                            <strong>{lose !== null && digits.length ? pct(shares[lose]) : '—'}</strong>
                        </div>
                        <div>
                            <span>TICKS SINCE IT LANDED</span>
                            <strong>{since ?? '—'}</strong>
                        </div>
                        <p>
                            Measured on 195,000 real Deriv ticks across 13 markets. The losing digit lands about 1 tick in
                            10 no matter how long it has been away — every tick is independent.
                        </p>
                    </div>

                    <div className='nolimitz-ai__field-label'>DIGIT HEAT · LAST {HISTORY} TICKS</div>
                    <div className='nolimitz-ai__heat'>
                        {shares.map((v, d) => (
                            <div key={d} className={d === lose ? 'lose' : ''}>
                                <i style={{ height: `${Math.min(100, (v / 0.15) * 100)}%` }} />
                                <b>{d}</b>
                                <small>{digits.length ? pct(v, 0) : ''}</small>
                            </div>
                        ))}
                    </div>
                    <div className='nolimitz-ai__ribbon' aria-label='Recent digits'>
                        {recent.map((d, i) => (
                            <span key={i} className={d === lose ? 'lose' : ''}>
                                {d}
                            </span>
                        ))}
                    </div>

                    <div className='nolimitz-ai__field-label'>STAKE PER TRADE [{currency}]</div>
                    <div className='nolimitz-ai__stepper'>
                        <button
                            disabled={running}
                            onClick={() => setStake(String(Math.max(0.35, (stake_num || 2) - 1).toFixed(2)))}
                        >
                            −
                        </button>
                        <input value={stake} disabled={running} inputMode='decimal' onChange={e => setStake(e.target.value)} />
                        <button disabled={running} onClick={() => setStake(String(((stake_num || 0) + 1).toFixed(2)))}>
                            +
                        </button>
                    </div>
                    {low_stake && (
                        <div className='nolimitz-ai__hint warn'>
                            Below {MIN_FULL_PAYOUT_STAKE} {currency} Deriv rounds this payout down to about 6%. Use{' '}
                            {MIN_FULL_PAYOUT_STAKE}+ to get the full ~9.6%.
                        </div>
                    )}

                    <div className='nolimitz-ai__targets'>
                        <label>
                            <span>PROFIT TARGET</span>
                            <div>
                                <b>◎</b>
                                <input value={tp} disabled={running} inputMode='decimal' onChange={e => setTp(e.target.value)} />
                                <small>{currency}</small>
                            </div>
                        </label>
                        <label>
                            <span>MAXIMUM LOSS</span>
                            <div>
                                <b>♢</b>
                                <input value={sl} disabled={running} inputMode='decimal' onChange={e => setSl(e.target.value)} />
                                <small>{currency}</small>
                            </div>
                        </label>
                    </div>

                    <div className={`nolimitz-ai__odds ${odds === null ? '' : odds >= 0.6 ? 'good' : odds >= 0.4 ? 'mid' : 'bad'}`}>
                        <div>
                            <span>CHANCE TO HIT THE TARGET BEFORE THE MAXIMUM LOSS</span>
                            <small>
                                Each win +{money(stake_num * (payout - 1))} · each loss −{money(stake_num)} · about{' '}
                                {Math.max(1, Math.round(tp_num / Math.max(0.01, stake_num * (payout - 1))))} wins needed
                            </small>
                        </div>
                        <strong>{odds === null ? '—' : `${Math.round(odds * 100)}%`}</strong>
                    </div>

                    {notice && <div className='nolimitz-ai__hint warn'>{notice}</div>}

                    <button
                        className={`nolimitz-ai__run ${running ? 'stop' : ''}`}
                        disabled={!is_logged_in || (!running && feedStatus !== 'LIVE')}
                        onClick={running ? stop : start}
                    >
                        {running ? '■ STOP NOLIMITZ AI' : '⚡ RUN UNTIL TARGET / MAX LOSS'}
                    </button>
                </section>

                <section className='nolimitz-ai__session'>
                    <div>
                        <span>TRADES</span>
                        <strong>{stats.trades}</strong>
                    </div>
                    <div>
                        <span>WINS / LOSSES</span>
                        <strong>
                            {stats.wins}/{stats.losses}
                        </strong>
                    </div>
                    <div>
                        <span>WIN RATE</span>
                        <strong>{stats.trades ? pct(winRate) : '—'}</strong>
                    </div>
                    <div className={stats.pnl >= 0 ? 'positive' : 'negative'}>
                        <span>SESSION P/L</span>
                        <strong>
                            {stats.pnl >= 0 ? '+' : ''}
                            {money(stats.pnl)} {currency}
                        </strong>
                    </div>
                </section>

                <section className='nolimitz-ai__curve'>
                    <div className='nolimitz-ai__setups-title'>SESSION CURVE</div>
                    <Sparkline points={stats.curve} />
                    {stats.trades > 0 && (
                        <div className='nolimitz-ai__curve-legend'>
                            <span>Target +{money(tp_num)}</span>
                            <span>Max loss −{money(sl_num)}</span>
                        </div>
                    )}
                </section>

                {logs.length > 0 && (
                    <section className='nolimitz-ai__log'>
                        {logs.map((line, index) => (
                            <div key={index}>{line}</div>
                        ))}
                    </section>
                )}

                <div className='nolimitz-ai__disclaimer'>
                    Win rate and profit are different things. On real Deriv data these contracts won 90.0% of trades, but
                    Deriv&apos;s payout needs about 91.2% to break even, so over many trades they lose roughly 1.3% of what
                    is staked. Sessions end at your target or maximum loss; the chance figure above shows how often the
                    target comes first.
                </div>
            </div>

            {result && (
                <div className='nolimitz-ai__overlay'>
                    <div className={`nolimitz-ai__result ${result.pnl >= 0 ? 'win' : 'loss'}`}>
                        <button onClick={() => setResult(null)}>×</button>
                        <small>
                            {result.type === 'tp'
                                ? 'PROFIT TARGET REACHED'
                                : result.type === 'sl'
                                  ? 'MAXIMUM LOSS REACHED'
                                  : 'SESSION STOPPED'}
                        </small>
                        <h3>
                            {result.pnl >= 0 ? '+' : ''}
                            {money(result.pnl)} {currency}
                        </h3>
                        <p className='nolimitz-ai__target-message'>{result.reason}</p>
                        <div>
                            <span>
                                Trades <b>{result.trades}</b>
                            </span>
                            <span>
                                Wins <b>{result.wins}</b>
                            </span>
                            <span>
                                Losses <b>{result.losses}</b>
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default NolimitzAI;
