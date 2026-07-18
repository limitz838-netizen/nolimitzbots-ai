// @ts-nocheck — follows vendored page code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './bulk-trader.scss';

const MARKETS = [
    { code: 'R_10', label: 'Vol 10' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_100', label: 'Vol 100' },
];

const TRADE_TYPES = [
    { code: 'DIGITEVEN', label: 'Even' },
    { code: 'DIGITODD', label: 'Odd' },
    { code: 'DIGITOVER', label: 'Over' },
    { code: 'DIGITUNDER', label: 'Under' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const BulkTrader = observer(() => {
    const { client } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const currency = client?.currency || 'USD';

    const [symbol, setSymbol] = React.useState('R_100');
    const [trade_type, setTradeType] = React.useState('DIGITEVEN');
    const [barrier, setBarrier] = React.useState(2);
    const [ticks, setTicks] = React.useState(1);
    const [stake, setStake] = React.useState('0.5');
    const [count, setCount] = React.useState(5);
    const [is_busy, setIsBusy] = React.useState(false);
    const [results, setResults] = React.useState([]);

    const needs_barrier = trade_type === 'DIGITOVER' || trade_type === 'DIGITUNDER';
    const stake_num = parseFloat(stake) || 0;
    const total = (stake_num * count).toFixed(2);

    const onTradeType = code => {
        setTradeType(code);
        if (code === 'DIGITOVER') setBarrier(2);
        if (code === 'DIGITUNDER') setBarrier(7);
    };

    const fire = async () => {
        if (!api_base?.api || is_busy) return;
        setIsBusy(true);
        setResults([]);
        const out = [];
        for (let i = 0; i < count; i++) {
            try {
                const req = {
                    buy: '1',
                    price: stake_num,
                    parameters: {
                        amount: stake_num,
                        basis: 'stake',
                        contract_type: trade_type,
                        currency,
                        duration: ticks,
                        duration_unit: 't',
                        symbol,
                        ...(needs_barrier ? { barrier: String(barrier) } : {}),
                    },
                };
                // eslint-disable-next-line no-await-in-loop
                const res = await api_base.api.send(req);
                out.push({
                    ok: true,
                    id: res?.buy?.contract_id,
                    msg: `#${i + 1} bought — ${currency} ${Number(res?.buy?.buy_price ?? stake_num).toFixed(2)}`,
                });
            } catch (e) {
                out.push({ ok: false, msg: `#${i + 1} failed — ${e?.error?.message || e?.message || 'error'}` });
            }
            setResults([...out]);
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 350));
        }
        setIsBusy(false);
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
                            onClick={() => setSymbol(m.code)}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>

                <div className='bulk-trader__label'>Trade type</div>
                <div className='bulk-trader__pills'>
                    {TRADE_TYPES.map(t => (
                        <button
                            key={t.code}
                            className={`bulk-trader__pill ${trade_type === t.code ? 'bulk-trader__pill--active' : ''}`}
                            onClick={() => onTradeType(t.code)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {needs_barrier && (
                    <div className='bulk-trader__field'>
                        <span>Digit ({trade_type === 'DIGITOVER' ? 'wins above' : 'wins below'})</span>
                        <input
                            type='number'
                            min={trade_type === 'DIGITOVER' ? 0 : 1}
                            max={trade_type === 'DIGITOVER' ? 8 : 9}
                            value={barrier}
                            onChange={e =>
                                setBarrier(
                                    clamp(
                                        parseInt(e.target.value || 0, 10),
                                        trade_type === 'DIGITOVER' ? 0 : 1,
                                        trade_type === 'DIGITOVER' ? 8 : 9
                                    )
                                )
                            }
                        />
                    </div>
                )}

                <div className='bulk-trader__row'>
                    <div className='bulk-trader__field'>
                        <span>Ticks</span>
                        <input
                            type='number'
                            min={1}
                            max={10}
                            value={ticks}
                            onChange={e => setTicks(clamp(parseInt(e.target.value || 1, 10), 1, 10))}
                        />
                    </div>
                    <div className='bulk-trader__field'>
                        <span>Stake ({currency})</span>
                        <input
                            type='number'
                            min='0.35'
                            step='0.01'
                            value={stake}
                            onChange={e => setStake(e.target.value)}
                        />
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

                <button
                    className='bulk-trader__fire'
                    disabled={!is_logged_in || is_busy || stake_num < 0.35}
                    onClick={fire}
                >
                    {is_busy ? 'Placing trades…' : `⚡ Buy ${count} × ${currency} ${stake_num.toFixed(2)} (total ${total})`}
                </button>

                {results.length > 0 && (
                    <div className='bulk-trader__results'>
                        {results.map((r, i) => (
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
        </div>
    );
});

export default BulkTrader;
