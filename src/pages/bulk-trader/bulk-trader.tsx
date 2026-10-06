// @ts-nocheck — follows vendored page code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import AiScanner from './ai-scanner';
import Guide, { GuideButton } from '@/components/shared/nlb/guide';
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

const MAX_BATCH_COUNT = 20;
const DEFAULT_MAX_EXPOSURE = 10;
const MAX_MART_STEPS = 4;

const BulkTrader = observer(() => {
    const { client, run_panel, transactions, summary_card } = useStore();
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
    const [max_exposure, setMaxExposure] = React.useState(String(DEFAULT_MAX_EXPOSURE));
    const [martingale, setMartingale] = React.useState(false);
    const [mult, setMult] = React.useState('2.0');
    const [next_stake, setNextStake] = React.useState(null); // martingale-adjusted stake for next batch
    const mart_steps_ref = React.useRef(0);

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
    const [scanner_open, setScannerOpen] = React.useState(false);
    const [guide_open, setGuideOpen] = React.useState(false);

    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const cfg_ref = React.useRef({});
    const effective_stake = next_stake ?? (parseFloat(stake) || 0);
    cfg_ref.current = {
        symbol,
        window_size,
        pair,
        over_digit,
        under_digit,
        duration,
        stake: effective_stake,
        currency,
    };
    const batch_ref = React.useRef(null);

    const stake_num = parseFloat(stake) || 0;
    const max_exposure_num = Math.max(0, parseFloat(max_exposure) || 0);
    const effective_stake_num = next_stake ?? stake_num;
    const batch_exposure = effective_stake_num * count;
    const exposure_ok =
        effective_stake_num >= 0.35 &&
        count >= 1 &&
        count <= MAX_BATCH_COUNT &&
        max_exposure_num >= 0.35 &&
        batch_exposure <= max_exposure_num + 1e-9;
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
            const amount = Number(c.stake) || 0;
            if (!amount || amount < 0.35) return;
            const base = {
                proposal: 1,
                amount,
                basis: 'stake',
                currency: c.currency || 'USD',
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
    }, [stake, next_stake, currency, duration, pair, over_digit, under_digit]);

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

    // ---- settlement tracking via shared hardened tracker ----
    const trackBatch = (ids, side_label, batch_symbol) => {
        setSettling({ settled: 0, total: ids.length });
        batch_ref.current = trackContracts(ids, {
            onUpdate: ({ settled, total }) => setSettling({ settled, total }),
            onContract: contract => {
                try {
                    transactions?.onBotContractEvent?.(contract);
                    summary_card?.onBotContractEvent?.(contract);
                } catch {
                    /* display mirroring must never interrupt settlement */
                }
            },
            onDone: ({ total, wins, settled, count }) => {
                setSettling(null);
                try { run_panel?.setIsRunning?.(false); } catch { /* noop */ }
                if (total >= 0) playWin();
                else playLoss();
                // Optional martingale: bump next batch stake after a losing batch.
                if (martingale) {
                    const base = parseFloat(stake) || 0.5;
                    const m = Math.max(1, parseFloat(mult) || 1);
                    if (total < 0) {
                        mart_steps_ref.current += 1;
                        const perTradeCap = Math.max(0.35, max_exposure_num / Math.max(1, count));
                        if (mart_steps_ref.current > MAX_MART_STEPS) {
                            mart_steps_ref.current = 0;
                            setNextStake(null);
                        } else {
                            const requested = (next_stake ?? base) * m;
                            const bumped = Math.min(requested, perTradeCap);
                            if (bumped <= (next_stake ?? base) + 0.0001) {
                                mart_steps_ref.current = 0;
                                setNextStake(null);
                            } else {
                                setNextStake(Number(bumped.toFixed(2)));
                            }
                        }
                    } else {
                        mart_steps_ref.current = 0;
                        setNextStake(null);
                    }
                }
                setResult({
                    total,
                    wins,
                    settled,
                    count,
                    market: MARKETS.find(m => m.code === batch_symbol)?.label || batch_symbol,
                    side: side_label,
                });
                batch_ref.current = null;
            },
        });
    };

    // Clean teardown on unmount — silent, no popup.
    React.useEffect(() => () => batch_ref.current?.cancel(), []);

    // ---- fire a batch ----
    const fire = async side => {
        const fire_stake = next_stake ?? stake_num;
        const exposure = fire_stake * count;
        if (
            !api_base?.api ||
            is_busy ||
            !is_logged_in ||
            fire_stake < 0.35 ||
            count < 1 ||
            count > MAX_BATCH_COUNT ||
            max_exposure_num < 0.35 ||
            exposure > max_exposure_num + 1e-9
        ) {
            return;
        }

        unlockAudio();
        try {
            run_panel.run_id = `bulk-${Date.now()}`;
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* run panel unavailable */
        }

        setIsBusy(true);
        setResult(null);
        setReceipts([]);

        const baseProposal = {
            proposal: 1,
            amount: fire_stake,
            basis: 'stake',
            contract_type: side.contract_type,
            currency,
            duration,
            duration_unit: 't',
            underlying_symbol: symbol,
            ...(side.barrier !== undefined ? { barrier: String(side.barrier) } : {}),
        };

        try {
            // Stage 1: pre-price every contract concurrently. This avoids the old
            // proposal -> buy -> 300ms wait loop and gets the full batch ready
            // before any buy is sent.
            const proposalResults = await Promise.allSettled(
                Array.from({ length: count }, () => api_base.api.send(baseProposal))
            );

            const prepared = proposalResults
                .map((result, index) => {
                    if (result.status !== 'fulfilled') {
                        return { index, error: describeError(result.reason) };
                    }
                    const proposal = result.value?.proposal;
                    if (!proposal?.id) return { index, error: 'No proposal returned' };
                    return {
                        index,
                        proposal_id: proposal.id,
                        ask_price: Number(proposal.ask_price ?? fire_stake),
                    };
                });

            const proposalFailures = prepared.filter(x => x.error);
            const ready = prepared.filter(x => !x.error);

            if (proposalFailures.length) {
                setReceipts(
                    proposalFailures.map(x => ({
                        ok: false,
                        msg: `#${x.index + 1} proposal failed — ${x.error}`,
                    }))
                );
            }

            if (!ready.length) return;

            // Stage 2: dispatch all buys together. Network/server scheduling means
            // "same tick" can never be guaranteed, but this is the tightest batch
            // launch we can make without serial delays.
            const launchedAt = performance.now();
            const buyResults = await Promise.allSettled(
                ready.map(item => api_base.api.send({ buy: item.proposal_id, price: item.ask_price }))
            );
            const launchMs = performance.now() - launchedAt;

            const ids = [];
            const out = [...proposalFailures.map(x => ({
                ok: false,
                msg: `#${x.index + 1} proposal failed — ${x.error}`,
            }))];

            buyResults.forEach((result, idx) => {
                const item = ready[idx];
                if (result.status === 'fulfilled') {
                    const res = result.value;
                    const cid = res?.buy?.contract_id;
                    if (cid) ids.push(cid);
                    out.push({
                        ok: Boolean(cid),
                        msg: cid
                            ? `#${item.index + 1} bought — ${currency} ${Number(res?.buy?.buy_price ?? fire_stake).toFixed(2)}`
                            : `#${item.index + 1} failed — no contract id returned`,
                    });
                } else {
                    out.push({
                        ok: false,
                        msg: `#${item.index + 1} buy failed — ${describeError(result.reason)}`,
                    });
                }
            });

            out.sort((a, b) => {
                const ai = Number((a.msg.match(/#(\d+)/) || [])[1] || 0);
                const bi = Number((b.msg.match(/#(\d+)/) || [])[1] || 0);
                return ai - bi;
            });
            out.unshift({
                ok: true,
                msg: `Parallel batch dispatched: ${ready.length} buys in ${launchMs.toFixed(0)} ms request window · exposure ${currency} ${exposure.toFixed(2)}`,
            });
            setReceipts(out);

            if (ids.length) trackBatch(ids, side.label, symbol);
            else {
                try { run_panel?.setIsRunning?.(false); } catch { /* noop */ }
            }
        } catch (e) {
            setReceipts([{ ok: false, msg: `Batch failed — ${describeError(e)}` }]);
            try { run_panel?.setIsRunning?.(false); } catch { /* noop */ }
        } finally {
            setIsBusy(false);
        }
    };

    return (
        <div className='bulk-trader'>
            <div className='bulk-trader__panel'>
                <div className='bulk-trader__titlerow'>
                    <div className='bulk-trader__title'>Bulk Trader</div>
                    <GuideButton onClick={() => setGuideOpen(true)} />
                </div>
                <Guide tool='bulk-trader' open={guide_open} onClose={() => setGuideOpen(false)} />
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

                <button className='bulk-trader__scanner-btn' onClick={() => setScannerOpen(true)}>
                    <span className='bulk-trader__scanner-chip'>⚙</span> AI SCANNER — find strongest market
                </button>

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
                            max={MAX_BATCH_COUNT}
                            value={count}
                            onChange={e => setCount(clamp(parseInt(e.target.value || 1, 10), 1, MAX_BATCH_COUNT))}
                        />
                    </div>
                    <div className='bulk-trader__field'>
                        <span>Max batch exposure ({currency})</span>
                        <input
                            type='number'
                            min='0.35'
                            step='0.5'
                            value={max_exposure}
                            onChange={e => setMaxExposure(e.target.value)}
                        />
                    </div>
                </div>

                <div className={`bulk-trader__risk-preview ${exposure_ok ? 'ok' : 'blocked'}`}>
                    <div><span>Effective stake</span><strong>{currency} {effective_stake_num.toFixed(2)}</strong></div>
                    <div><span>Contracts</span><strong>{count}</strong></div>
                    <div><span>Total exposure</span><strong>{currency} {batch_exposure.toFixed(2)}</strong></div>
                    <div><span>Exposure limit</span><strong>{currency} {max_exposure_num.toFixed(2)}</strong></div>
                    <p>
                        {exposure_ok
                            ? 'READY — proposals will be prepared first, then the buys will be dispatched as one parallel batch.'
                            : 'BLOCKED — reduce stake/trade count or increase the batch exposure limit before buying.'}
                    </p>
                </div>

                <label className='bulk-trader__toggle'>
                    <span>Enable Martingale (raise stake after a losing batch)</span>
                    <input type='checkbox' checked={martingale} disabled={is_busy || !!settling} onChange={e => {
                        setMartingale(e.target.checked);
                        if (!e.target.checked) { setNextStake(null); mart_steps_ref.current = 0; }
                    }} />
                    <i />
                </label>
                {martingale && (
                    <>
                        <div className='bulk-trader__field bulk-trader__field--inline'>
                            <span>Multiplier</span>
                            <input type='number' min='1' max='5' step='0.05' value={mult} disabled={is_busy || !!settling} onChange={e => setMult(e.target.value)} />
                        </div>
                        {next_stake && (
                            <div className='bulk-trader__mart-next'>
                                Next batch stake: {currency} {next_stake.toFixed(2)} (recovering) · resets on a winning batch
                            </div>
                        )}
                        <div className='bulk-trader__mart-warn'>
                            After a losing batch the next batch's stake is multiplied to recover. Capped at {MAX_MART_STEPS} steps and by your maximum batch exposure, then resets. Losing streaks grow stake fast — keep the multiplier low and test on demo.
                        </div>
                    </>
                )}

                <div className='bulk-trader__sides'>
                    {sides.map(side => {
                        const p = sidePct(side);
                        return (
                            <button
                                key={side.key}
                                className={`bulk-trader__side bulk-trader__side--${side.accent}`}
                                disabled={!is_logged_in || is_busy || !!settling || !exposure_ok}
                                onClick={() => fire(side)}
                            >
                                <span className='bulk-trader__side-name'>{side.label}</span>
                                <span className='bulk-trader__side-payout'>
                                    {payouts[side.key] ? `Payout ${currency} ${payouts[side.key].toFixed(2)}` : '—'}
                                </span>
                                <span className='bulk-trader__side-pct'>{p !== null ? `${p.toFixed(2)}%` : '…'}</span>
                                <span className='bulk-trader__side-action'>
                                    ⚡ Parallel buy {count} × {effective_stake_num.toFixed(2)}
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

            <AiScanner open={scanner_open} onClose={() => setScannerOpen(false)} stake={stake} count={count} currency={currency} isLoggedIn={is_logged_in} maxExposure={max_exposure_num} />

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
