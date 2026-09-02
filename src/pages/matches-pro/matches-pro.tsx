// @ts-nocheck - Matches Pro (Phase 1: live tick + last-digit engine only).
//
// This phase deliberately contains NO prediction and NO trading.
// It proves the tick pipeline is correct before anything can place an order.
import React from 'react';
import { subscribeTicks, TICK_STATUS } from '@/components/shared/nlb/tick-stream';
import './matches-pro.scss';

const DEFAULT_SYMBOLS = [
    { code: 'R_100', label: 'Volatility 100 Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ10V', label: 'Volatility 10 (1s) Index' },
];

const WINDOWS = [50, 100, 250, 500, 1000];
const HISTORY = 1000;

const STATUS_TEXT = {
    [TICK_STATUS.LIVE]: 'LIVE',
    [TICK_STATUS.CONNECTING]: 'CONNECTING',
    [TICK_STATUS.RECONNECTING]: 'RECONNECTING',
    [TICK_STATUS.DISCONNECTED]: 'DISCONNECTED',
};

const MatchesPro = () => {
    const [symbol, setSymbol] = React.useState('R_100');
    const [symbols, setSymbols] = React.useState(DEFAULT_SYMBOLS);
    const [status, setStatus] = React.useState(TICK_STATUS.CONNECTING);
    const [quote, setQuote] = React.useState(null);
    const [decimals, setDecimals] = React.useState(null);
    const [digits, setDigits] = React.useState([]);
    const [window_size, setWindowSize] = React.useState(100);
    const [error, setError] = React.useState('');

    React.useEffect(() => {
        setDigits([]);
        setQuote(null);
        setError('');

        const unsubscribe = subscribeTicks({
            symbol,
            count: HISTORY,
            onStatus: setStatus,
            onError: message => setError(message),
            onSymbols: list => {
                if (list?.length) setSymbols(list.map(s => ({ code: s.code, label: s.label || s.code })));
            },
            onHistory: ({ digits: d, quote: q, decimals: dec }) => {
                setDigits(d);
                setQuote(q);
                setDecimals(dec);
            },
            onTick: ({ digit, quote: q, decimals: dec }) => {
                setDecimals(dec);
                setQuote(q);
                setDigits(prev => [...prev, digit].slice(-HISTORY));
            },
        });

        return unsubscribe;
    }, [symbol]);

    const sample = React.useMemo(() => digits.slice(-window_size), [digits, window_size]);

    const distribution = React.useMemo(() => {
        const counts = new Array(10).fill(0);
        sample.forEach(d => {
            counts[d] += 1;
        });
        const total = sample.length || 1;
        return counts.map((c, d) => ({ digit: d, count: c, pct: (c / total) * 100 }));
    }, [sample]);

    const max_pct = Math.max(10, ...distribution.map(d => d.pct));
    const current_digit = digits.length ? digits[digits.length - 1] : null;
    const status_text = STATUS_TEXT[status] || STATUS_TEXT[TICK_STATUS.DISCONNECTED];

    return (
        <div className='matches-pro'>
            <div className='matches-pro__panel'>
                <div className='matches-pro__head'>
                    <div>
                        <div className='matches-pro__title'>MATCHES PRO</div>
                        <div className='matches-pro__subtitle'>
                            Phase 1 - live tick and digit engine. No prediction, no trading yet.
                        </div>
                    </div>
                    <div className={`matches-pro__status matches-pro__status--${status}`}>
                        <i className='matches-pro__dot' />
                        {status_text}
                    </div>
                </div>

                {error && <div className='matches-pro__warn'>{error}</div>}

                <div className='matches-pro__controls'>
                    <label className='matches-pro__field'>
                        <span>Market</span>
                        <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                            {symbols.map(s => (
                                <option key={s.code} value={s.code}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>Analysis window</span>
                        <select value={window_size} onChange={e => setWindowSize(Number(e.target.value))}>
                            {WINDOWS.map(w => (
                                <option key={w} value={w}>
                                    {w} ticks
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                <div className='matches-pro__readout'>
                    <div className='matches-pro__stat'>
                        <span>Current tick</span>
                        <strong>{quote ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Current digit</span>
                        <strong className='matches-pro__digit'>{current_digit ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Decimals</span>
                        <strong>{decimals ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Sample</span>
                        <strong>
                            {sample.length}/{window_size}
                        </strong>
                    </div>
                </div>

                <div className='matches-pro__section-title'>Digit distribution - last {sample.length} ticks</div>
                <div className='matches-pro__dist'>
                    {distribution.map(d => (
                        <div key={d.digit} className='matches-pro__row'>
                            <span className='matches-pro__row-digit'>{d.digit}</span>
                            <span className='matches-pro__bar'>
                                <span style={{ width: `${(d.pct / max_pct) * 100}%` }} />
                            </span>
                            <span className='matches-pro__row-pct'>{d.pct.toFixed(1)}%</span>
                        </div>
                    ))}
                </div>

                <div className='matches-pro__section-title'>Recent digits</div>
                <div className='matches-pro__recent'>
                    {digits.slice(-40).map((d, i) => (
                        <span key={`${i}-${d}`} className='matches-pro__chip'>
                            {d}
                        </span>
                    ))}
                    {!digits.length && <span className='matches-pro__muted'>Waiting for ticks...</span>}
                </div>

                <div className='matches-pro__note'>
                    Each digit on a volatility index is independent and roughly 10% likely. Deviations you see in this
                    window are ordinary sampling noise, not a pattern. The prediction engine arrives in Phase 2, and it
                    will be scored against that 10% baseline before any trading is enabled.
                </div>
            </div>
        </div>
    );
};

export default MatchesPro;