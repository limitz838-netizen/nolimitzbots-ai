// @ts-nocheck — follows vendored page code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import './bulk-trader.scss';

const MARKETS = [
    { code: 'R_10', label: 'Vol 10' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_100', label: 'Vol 100' },
];

const FALLBACK_DECIMALS = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lastDigit = (quote, decimals) => Number(Number(quote).toFixed(decimals).slice(-1));

const BulkTrader = observer(() => {
    const { client } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const currency = client?.currency || 'USD';

    // config
    const [symbol, setSymbol] = React.useState('R_100');
    const [pair, setPair] = React.useState('EO'); // EO | OU
    const [over_digit, setOverDigit] = React.useState(2);
    const [under_digit, setUnderDigit] = React.useState(7);
    const [window_size, setWindowSize] = React.useState(120);
    const [duration, setDuration] = React.useState(1);
    const [stake, setStake] = React.useState('0.5');
    const [count, setCount] = React.useState(5);

    // live data
    const [digits, setDigits] = React.useState([]);
    const [quote, setQuote] = React.useState(null);
    const [status, setStatus] = React.useState('connecting');
    const [payouts, setPayouts] = React.useState({ A: null, B: null });

    // batch state
    const [is_busy, setIsBusy] = React.useState(false);
    const [receipts, setReceipts] = React.useState([]);
    const [settling, setSettling] = React.useState(null); // {settled, total}
    const [result, setResult] = React.useState(null); // popup

    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const cfg_ref = React.useRef({});
    cfg_ref.current = { symbol, window_size, pair, over_digit, under_digit, duration, stake };
    const batch_ref = React.useRef(null);

    const stake_num = parseFloat(stake) || 0;
    const sides =
        pair === 'EO'
            ? [
                  { key: 'A', label: 'Even', contract_type: 'DIGITEVEN', accent: 'teal' },
                  { key: 'B', label: 'Odd', contract_type: 'DIGITODD', accent: 'red' },
              ]
            : [
                  { key: 'A', label: `Over ${over_digit}`, contract_type: 'DIGITOVER', barrier: over_digit, accent: 'teal' },
                  { key: 'B', label: `Under ${under_digit}`, contract_type: 'DIGITUNDER', barrier: under_digit, accent: 'red' },
              ];

    // ---- dedicated public socket: ticks + display payouts ----
    React.useEffect(() => {
        let alive = true;
        const url = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
        const ws = new WebSocket(url);
        ws_ref.current = ws;

        const subscribeTicks = () => {
            const { symbol: sym, window_size: win } = cfg_ref.current;
            setDigits([]);
            setQuote(null);
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(JSON.stringify({ ticks_history: sym, count: win, end: 'latest', style: 'ticks', subscribe: 1 }));
        };

        const requestPayouts = () => {
            const c = cfg_ref.current;
            const amount = parseFloat(c.stake) || 0;
            if (!amount || amount < 0.35) return;
            const base = {
                proposal: 1,
                amount,
                basis: 'stake',
                currency: 'USD',
                duration: c.duration,
                duration_unit: 't',
                underlying_symbol: c.symbol,
            };
            const reqs =
                c.pair === 'EO'
                    ? [
                          { ...base, contract_type: 'DIGITEVEN', passthrough: { nlb_side: 'A' } },
                          { ...base, contract_type: 'DIGITODD', passthrough: { nlb_side: 'B' } },
                      ]
                    : [
                          { ...base, contract_type: 'DIGITOVER', barrier: String(c.over_digit), passthrough: { nlb_side: 'A' } },
                          { ...base, contract_type: 'DIGITUNDER', barrier: String(c.under_digit), passthrough: { nlb_side: 'B' } },
                      ];
            reqs.forEach(r => ws.send(JSON.stringify(r)));
        };

        ws.onopen = () => {
            if (!alive) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            subscribeTicks();
            requestPayouts();
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
            if (data.msg_type === 'history' && data.echo_req?.ticks_history === cfg_ref.current.symbol) {
                const dec = decimals_ref.current[cfg_ref.current.symbol] ?? 2;
                const prices = data.history?.prices || [];
                setDigits(prices.map(p => lastDigit(p, dec)));
                if (prices.length) setQuote(Number(prices[prices.length - 1]).toFixed(dec));
                setStatus('live');
                return;
            }
            if (data.msg_type === 'tick' && data.tick?.symbol === cfg_ref.current.symbol) {
                const dec = decimals_ref.current[cfg_ref.current.symbol] ?? 2;
                setQuote(Number(data.tick.quote).toFixed(dec));
                setDigits(prev => [...prev, lastDigit(data.tick.quote, dec)].slice(-cfg_ref.current.window_size));
                setStatus('live');
                return;
            }
            if (data.msg_type === 'proposal' && data.echo_req?.passthrough?.nlb_side) {
                const side = data.echo_req.passthrough.nlb_side;
                const payout = data.proposal?.payout;
                if (payout) setPayouts(prev => ({ ...prev, [side]: Number(payout) }));
            }
        };
        ws.onerror = () => alive && setStatus('error');

        const onCfg = e => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (e.detail === 'ticks') subscribeTicks();
            requestPayouts();
        };
        window.addEventListener('nlb-bulk-cfg', onCfg);

        return () => {
            alive = false;
            window.removeEventListener('nlb-bulk-cfg', onCfg);
            try {
                ws.close();
            } catch {
                /* noop */
            }
        };
    }, []);

    const notifyCfg = detail => setTimeout(() => window.dispatchEvent(new CustomEvent('nlb-bulk-cfg', { detail })), 0);

    // Debounced payout refresh on input changes
    React.useEffect(() => {
        const t = setTimeout(() => notifyCfg('payouts'), 400);
        return () => clearTimeout(t);
    }, [stake, duration, pair, over_digit, under_digit]);

    // ---- stats ----
    const counts = Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const total_ticks = digits.length || 1;
    const pct = counts.map(c => (100 * c) / total_ticks);
    const max_d = pct.indexOf(Math.max(...pct));
    const min_d = pct.indexOf(Math.min(...pct));
    const cur_digit = digits.length ? digits[digits.length - 1] : null;
    const even_pct = pct[0] + pct[2] + pct[4] + pct[6] + pct[8];
    const has_data = digits.length >= 20;
    const stream = digits.slice(-8);

    const sidePct = side => {
        if (!has_data) return null;
        if (pair === 'EO') return side.key === 'A' ? even_pct : 100 - even_pct;
        if (side.contract_type === 'DIGITOVER') return pct.slice(over_digit + 1).reduce((a, b) => a + b, 0);
        return pct.slice(0, under_digit).reduce((a, b) => a + b, 0);
    };

    // ---- settlement tracking (global poc stream on the authorized connection) ----
    const finalizeBatch = () => {
        const b = batch_ref.current;
        if (!b || b.finalized) return;
        b.finalized = true;
        if (b.sub) b.sub.unsubscribe();
        if (b.poll) clearInterval(b.poll);
        if (b.timeout) clearTimeout(b.timeout);
        const profits = Object.values(b.profits);
        const total = profits.reduce((a, p) => a + p, 0);
        const wins = profits.filter(p => p > 0).length;
        setSettling(null);
        if (total >= 0) playWin();
        else playLoss();
        setResult({
            total,
            wins,
            settled: profits.length,
            count: b.count,
            market: MARKETS.find(m => m.code === b.symbol)?.label || b.symbol,
            side: b.side_label,
        });
        batch_ref.current = null;
    };

    const trackBatch = (ids, side_label) => {
        const b = {
            pending: new Set(ids),
            profits: {},
            count: ids.length,
            symbol,
            side_label,
            finalized: false,
        };
        batch_ref.current = b;
        setSettling({ settled: 0, total: ids.length });

        const handle = contract => {
            if (!contract || !b.pending.has(contract.contract_id)) return;
            if (contract.is_sold) {
                b.pending.delete(contract.contract_id);
                b.profits[contract.contract_id] = Number(contract.profit ?? 0);
                setSettling({ settled: Object.keys(b.profits).length, total: b.count });
                if (b.pending.size === 0) finalizeBatch();
            }
        };

        b.sub = api_base.api.onMessage().subscribe(({ data }) => {
            if (data?.msg_type === 'proposal_open_contract') handle(data.proposal_open_contract);
        });
        // Poll fallback in case stream misses an update
        b.poll = setInterval(() => {
            b.pending.forEach(id => {
                try {
                    api_base.api.send({ proposal_open_contract: 1, contract_id: id });
                } catch {
                    /* noop */
                }
            });
        }, 4000);
        // Safety net: never hang forever
        b.timeout = setTimeout(finalizeBatch, 120000);
    };

    React.useEffect(() => () => finalizeBatch(), []);

    // ---- fire a batch ----
    const fire = async side => {
        if (!api_base?.api || is_busy || !is_logged_in || stake_num < 0.35) return;
        unlockAudio();
        setIsBusy(true);
        setResult(null);
        setReceipts([]);
        const out = [];
        const ids = [];
        for (let i = 0; i < count; i++) {
            try {
                const proposal_req = {
                    proposal: 1,
                    amount: stake_num,
                    basis: 'stake',
                    contract_type: side.contract_type,
                    currency,
                    duration,
                    duration_unit: 't',
                    underlying_symbol: symbol,
                    ...(side.barrier !== undefined ? { barrier: String(side.barrier) } : {}),
                };
                // eslint-disable-next-line no-await-in-loop
                const prop = await api_base.api.send(proposal_req);
                const proposal_id = prop?.proposal?.id;
                const ask_price = Number(prop?.proposal?.ask_price ?? stake_num);
                if (!proposal_id) throw new Error('No proposal returned');
                // eslint-disable-next-line no-await-in-loop
                const res = await api_base.api.send({ buy: proposal_id, price: ask_price });
                const cid = res?.buy?.contract_id;
                if (cid) ids.push(cid);
                out.push({ ok: true, msg: `#${i + 1} bought — ${currency} ${Number(res?.buy?.buy_price ?? stake_num).toFixed(2)}` });
            } catch (e) {
                out.push({ ok: false, msg: `#${i + 1} failed — ${e?.error?.message || e?.message || 'error'}` });
            }
            setReceipts([...out]);
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 300));
        }
        setIsBusy(false);
        if (ids.length) trackBatch(ids, side.label);
    };

    return (
        <div className='bulk-trader'>
            <div className='bulk-trader__panel'>
                <div className='bulk-trader__title'>Bulk Trader</div>
                <div className='bulk-trader__subtitle'>
                    Fire multiple digit contracts in one tap. Test on your demo account first.
                </div>

                {!is_logged_in && (
                    <div className='bulk-trader__warn'>Sign in with your Deriv account to place trades.</div>
                )}

                <div className='bulk-trader__label'>Market</div>
                <div className='bulk-trader__pills'>
                    {MARKETS.map(m => (
                        <button
                            key={m.code}
                            className={`bulk-trader__pill ${symbol === m.code ? 'bulk-trader__pill--active' : ''}`}
                            onClick={() => {
                                setSymbol(m.code);
                                setStatus('connecting');
                                notifyCfg('ticks');
                            }}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>

                <div className='bulk-trader__label'>Trade type</div>
                <div className='bulk-trader__pills'>
                    <button
                        className={`bulk-trader__pill ${pair === 'EO' ? 'bulk-trader__pill--active' : ''}`}
                        onClick={() => setPair('EO')}
                    >
                        Even / Odd
                    </button>
                    <button
                        className={`bulk-trader__pill ${pair === 'OU' ? 'bulk-trader__pill--active' : ''}`}
                        onClick={() => setPair('OU')}
                    >
                        Over / Under
                    </button>
                </div>

                {pair === 'OU' && (
                    <div className='bulk-trader__row bulk-trader__row--two'>
                        <div className='bulk-trader__field'>
                            <span>Over digit (wins above)</span>
                            <input
                                type='number'
                                min={0}
                                max={8}
                                value={over_digit}
                                onChange={e => setOverDigit(clamp(parseInt(e.target.value || 0, 10), 0, 8))}
                            />
                        </div>
                        <div className='bulk-trader__field'>
                            <span>Under digit (wins below)</span>
                            <input
                                type='number'
                                min={1}
                                max={9}
                                value={under_digit}
                                onChange={e => setUnderDigit(clamp(parseInt(e.target.value || 1, 10), 1, 9))}
                            />
                        </div>
                    </div>
                )}

                <div className='bulk-trader__tickbar'>
                    <div className='bulk-trader__field bulk-trader__field--window'>
                        <span>Analysis ticks</span>
                        <input
                            type='number'
                            min={20}
                            max={500}
                            value={window_size}
                            onChange={e => {
                                setWindowSize(clamp(parseInt(e.target.value || 120, 10), 20, 500));
                                notifyCfg('ticks');
                            }}
                        />
                    </div>
                    <div className='bulk-trader__current'>
                        <span className='bulk-trader__current-label'>
                            <span className={`bulk-trader__dot bulk-trader__dot--${status}`} /> Current tick
                        </span>
                        <span className='bulk-trader__current-value'>{quote ?? '—'}</span>
                    </div>
                </div>

                <div className='bulk-trader__digits'>
                    {pct.map((p, d) => (
                        <div
                            key={d}
                            className={`bulk-trader__digit ${d === max_d && has_data ? 'bulk-trader__digit--hot' : ''} ${
                                d === min_d && has_data ? 'bulk-trader__digit--cold' : ''
                            } ${d === cur_digit ? 'bulk-trader__digit--current' : ''}`}
                        >
                            <span className='bulk-trader__digit-num'>{d}</span>
                            <span className='bulk-trader__digit-pct'>{has_data ? `${p.toFixed(1)}%` : '—'}</span>
                            <span className='bulk-trader__digit-bar' style={{ width: `${Math.min(100, p * 6)}%` }} />
                            {d === cur_digit && <span className='bulk-trader__digit-marker'>▲</span>}
                        </div>
                    ))}
                </div>

                <div className='bulk-trader__stream'>
                    {stream.map((d, i) => (
                        <span key={i} className={`bulk-trader__eo ${d % 2 === 0 ? 'bulk-trader__eo--e' : 'bulk-trader__eo--o'}`}>
                            {d % 2 === 0 ? 'E' : 'O'}
                        </span>
                    ))}
                </div>

                <div className='bulk-trader__row'>
                    <div className='bulk-trader__field'>
                        <span>Ticks</span>
                        <input
                            type='number'
                            min={1}
                            max={10}
                            value={duration}
                            onChange={e => setDuration(clamp(parseInt(e.target.value || 1, 10), 1, 10))}
                        />
                    </div>
                    <div className='bulk-trader__field'>
                        <span>Stake ({currency})</span>
                        <input type='number' min='0.35' step='0.01' value={stake} onChange={e => setStake(e.target.value)} />
                    </div>
                    <div className='bulk-trader__field'>
                        <span>No. of trades</span>
                        <input
                            type='number'
                            min={1}
                            max={20}
                            value={count}
                            onChange={e => setCount(clamp(parseInt(e.target.value || 1, 10), 1, 20))}
                        />
                    </div>
                </div>

                <div className='bulk-trader__sides'>
                    {sides.map(side => {
                        const p = sidePct(side);
                        return (
                            <button
                                key={side.key}
                                className={`bulk-trader__side bulk-trader__side--${side.accent}`}
                                disabled={!is_logged_in || is_busy || !!settling || stake_num < 0.35}
                                onClick={() => fire(side)}
                            >
                                <span className='bulk-trader__side-name'>{side.label}</span>
                                <span className='bulk-trader__side-payout'>
                                    {payouts[side.key] ? `Payout ${currency} ${payouts[side.key].toFixed(2)}` : '—'}
                                </span>
                                <span className='bulk-trader__side-pct'>{p !== null ? `${p.toFixed(2)}%` : '…'}</span>
                                <span className='bulk-trader__side-action'>
                                    ⚡ Buy {count} × {stake_num.toFixed(2)}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {settling && (
                    <div className='bulk-trader__settling'>
                        Settling contracts… {settling.settled}/{settling.total}
                    </div>
                )}

                {receipts.length > 0 && (
                    <div className='bulk-trader__results'>
                        {receipts.map((r, i) => (
                            <div key={i} className={`bulk-trader__result ${r.ok ? 'ok' : 'fail'}`}>
                                {r.msg}
                            </div>
                        ))}
                    </div>
                )}

                <div className='bulk-trader__disclaimer'>
                    Digit contracts settle on random tick outcomes — bulk buying multiplies stake, not odds.
                </div>
            </div>

            {result && (
                <div className='bulk-trader__overlay' role='dialog' aria-modal='true'>
                    <div className={`bulk-trader__popup ${result.total >= 0 ? 'bulk-trader__popup--win' : 'bulk-trader__popup--loss'}`}>
                        <button className='bulk-trader__popup-close' onClick={() => setResult(null)}>
                            ✕
                        </button>
                        <div className='bulk-trader__popup-tag'>Total profit</div>
                        <div className='bulk-trader__popup-headline'>
                            {result.total > 0 ? 'Batch won' : result.total < 0 ? 'Batch lost' : 'Break even'}
                        </div>
                        <div className='bulk-trader__popup-amount'>
                            {result.total >= 0 ? '+' : ''}
                            {result.total.toFixed(2)}
                        </div>
                        <div className='bulk-trader__popup-grid'>
                            <div>
                                <span>Market</span>
                                {result.market}
                            </div>
                            <div>
                                <span>Contract</span>
                                {result.side}
                            </div>
                            <div>
                                <span>Trades</span>
                                {result.settled}/{result.count}
                            </div>
                            <div>
                                <span>Wins</span>
                                {result.wins}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default BulkTrader;
