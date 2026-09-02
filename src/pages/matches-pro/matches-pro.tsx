// @ts-nocheck -- Matches Pro (Phase 2: prediction engine + live backtest).
//
// Still no trading. Every prediction is graded against the next tick so the
// engine's real accuracy is visible before a single order can be placed.
import React from 'react';
import { subscribeTicks, TICK_STATUS, getDiagnostics } from '@/components/shared/nlb/tick-stream';
import { predict, Z_CRITICAL } from '@/components/shared/nlb/matches-engine';
import { record, read, reset, summarise } from '@/components/shared/nlb/backtest-store';
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

const WINDOW_CHOICES = [50, 100, 250, 500, 1000];
const HISTORY = 1000;

const STATUS_TEXT = {
    [TICK_STATUS.LIVE]: 'LIVE',
    [TICK_STATUS.CONNECTING]: 'CONNECTING',
    [TICK_STATUS.RECONNECTING]: 'RECONNECTING',
    [TICK_STATUS.DISCONNECTED]: 'DISCONNECTED',
};

const pct = v => `${(v * 100).toFixed(2)}%`;
const clockOf = ts => new Date(ts).toLocaleTimeString('en-GB');

const MatchesPro = () => {
    const [symbol, setSymbol] = React.useState('R_100');
    const [symbols, setSymbols] = React.useState(DEFAULT_SYMBOLS);
    const [status, setStatus] = React.useState(TICK_STATUS.CONNECTING);
    const [quote, setQuote] = React.useState(null);
    const [decimals, setDecimals] = React.useState(null);
    const [digits, setDigits] = React.useState([]);
    const [window_size, setWindowSize] = React.useState(100);
    const [payout, setPayout] = React.useState(9.3);
    const [error, setError] = React.useState('');
    const [diag, setDiag] = React.useState(null);
    const [prediction, setPrediction] = React.useState(null);
    const [stats, setStats] = React.useState(null);
    const [feed, setFeed] = React.useState([]);
    const [show_why, setShowWhy] = React.useState(false);

    const digits_ref = React.useRef([]);
    const pending_ref = React.useRef(null);
    const payout_ref = React.useRef(payout);
    payout_ref.current = payout;

    const refreshStats = React.useCallback(sym => {
        const state = read(sym);
        setStats({ state, summary: summarise(state) });
    }, []);

    // One prediction per tick, graded against the tick that follows it.
    const step = React.useCallback(
        (sym, actual_digit, ts) => {
            const pending = pending_ref.current;
            if (pending && pending.predicted !== null && pending.symbol === sym) {
                record(sym, {
                    t: ts,
                    predicted: pending.predicted,
                    actual: actual_digit,
                    quality: pending.quality,
                    score: pending.score,
                });
                setFeed(prev =>
                    [
                        {
                            t: ts,
                            predicted: pending.predicted,
                            actual: actual_digit,
                            hit: pending.predicted === actual_digit,
                            quality: pending.quality,
                            score: pending.score,
                        },
                        ...prev,
                    ].slice(0, 12)
                );
            }

            const next = predict(digits_ref.current, { payout: payout_ref.current });
            setPrediction(next);
            pending_ref.current = {
                symbol: sym,
                predicted: next.predictedDigit,
                quality: next.signalQuality,
                score: next.score,
            };
            refreshStats(sym);
        },
        [refreshStats]
    );

    React.useEffect(() => {
        digits_ref.current = [];
        pending_ref.current = null;
        setDigits([]);
        setQuote(null);
        setError('');
        setFeed([]);
        setPrediction(null);
        refreshStats(symbol);

        const unsubscribe = subscribeTicks({
            symbol,
            count: HISTORY,
            onStatus: setStatus,
            onError: message => setError(message),
            onSymbols: list => {
                if (!list?.length) return;
                const known = Object.fromEntries(DEFAULT_SYMBOLS.map(s => [s.code, s.label]));
                setSymbols(
                    list.map(s => ({
                        code: s.code,
                        label: s.label && s.label !== s.code ? s.label : known[s.code] || s.code,
                    }))
                );
            },
            onHistory: ({ digits: d, quote: q, decimals: dec }) => {
                digits_ref.current = [...d];
                setDigits(d);
                setQuote(q);
                setDecimals(dec);
                // Seed a first prediction, but do not grade the seeded history.
                const seeded = predict(digits_ref.current, { payout: payout_ref.current });
                setPrediction(seeded);
                pending_ref.current = {
                    symbol,
                    predicted: seeded.predictedDigit,
                    quality: seeded.signalQuality,
                    score: seeded.score,
                };
            },
            onTick: ({ digit, quote: q, decimals: dec }) => {
                setDecimals(dec);
                setQuote(q);
                digits_ref.current = [...digits_ref.current, digit].slice(-HISTORY);
                setDigits(digits_ref.current);
                step(symbol, digit, Date.now());
            },
        });

        return unsubscribe;
    }, [symbol, step, refreshStats]);

    React.useEffect(() => {
        const id = setInterval(() => setDiag(getDiagnostics()), 1000);
        return () => clearInterval(id);
    }, []);

    const sample = React.useMemo(() => digits.slice(-window_size), [digits, window_size]);

    const distribution = React.useMemo(() => {
        const counts = new Array(10).fill(0);
        sample.forEach(d => {
            counts[d] += 1;
        });
        const total = sample.length || 1;
        return counts.map((c, d) => ({ digit: d, count: c, p: (c / total) * 100 }));
    }, [sample]);

    const max_pct = Math.max(10, ...distribution.map(d => d.p));
    const current_digit = digits.length ? digits[digits.length - 1] : null;
    const status_text = STATUS_TEXT[status] || STATUS_TEXT[TICK_STATUS.DISCONNECTED];
    const predicted = prediction?.predictedDigit;
    const quality = prediction?.signalQuality || 'NO SIGNAL';

    const onReset = () => {
        reset(symbol);
        setFeed([]);
        refreshStats(symbol);
    };

    return (
        <div className='matches-pro'>
            <div className='matches-pro__panel'>
                <div className='matches-pro__head'>
                    <div>
                        <div className='matches-pro__title'>MATCHES PRO</div>
                        <div className='matches-pro__subtitle'>
                            Phase 2 - prediction engine with live scoring. No trading yet.
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
                        <span>Distribution window</span>
                        <select value={window_size} onChange={e => setWindowSize(Number(e.target.value))}>
                            {WINDOW_CHOICES.map(w => (
                                <option key={w} value={w}>
                                    {w} ticks
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>Match payout multiplier</span>
                        <input
                            type='number'
                            step='0.1'
                            min='1.1'
                            value={payout}
                            onChange={e => setPayout(Number(e.target.value) || 9.3)}
                        />
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
                        <span>History</span>
                        <strong>{digits.length}</strong>
                    </div>
                </div>

                <div className='matches-pro__section-title'>Statistical analysis</div>
                <div className={`matches-pro__signal matches-pro__signal--${quality.replace(' ', '-').toLowerCase()}`}>
                    <div className='matches-pro__signal-main'>
                        <div className='matches-pro__signal-digit'>{predicted ?? '-'}</div>
                        <div>
                            <div className='matches-pro__signal-quality'>{quality}</div>
                            <div className='matches-pro__signal-sub'>
                                Score {prediction?.score ?? 0}/100, sample {prediction?.sampleSize ?? 0}
                            </div>
                        </div>
                    </div>
                    <div className='matches-pro__signal-nums'>
                        <div>
                            <span>Estimated probability</span>
                            <strong>{prediction ? pct(prediction.probabilityEstimate) : '-'}</strong>
                        </div>
                        <div>
                            <span>Break-even needed</span>
                            <strong>{prediction ? pct(prediction.breakeven) : '-'}</strong>
                        </div>
                    </div>
                </div>

                {prediction && (
                    <>
                        <button type='button' className='matches-pro__link' onClick={() => setShowWhy(v => !v)}>
                            {show_why ? 'Hide reasoning' : 'Why?'}
                        </button>
                        {show_why && (
                            <div className='matches-pro__why'>
                                <p>{prediction.reason}</p>
                                <table>
                                    <tbody>
                                        {prediction.factors.map(f => (
                                            <tr key={f.label}>
                                                <td>{f.label}</td>
                                                <td className={f.value >= 0 ? 'pos' : 'neg'}>
                                                    {f.value >= 0 ? '+' : ''}
                                                    {f.value.toFixed(2)} sigma
                                                </td>
                                                <td className='note'>{f.note || ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <p className='matches-pro__why-foot'>
                                    Significance bar is {Z_CRITICAL} sigma, corrected for testing 10 digits across 5
                                    windows on every tick. Probability is shrunk toward 10% with a 500-observation
                                    prior, so a lucky run inside the window does not become a claimed edge.
                                </p>
                            </div>
                        )}
                    </>
                )}

                <div className='matches-pro__section-title'>
                    Backtest
                    <button type='button' className='matches-pro__reset' onClick={onReset}>
                        Reset
                    </button>
                </div>
                {stats && (
                    <>
                        <div className='matches-pro__readout'>
                            <div className='matches-pro__stat'>
                                <span>Predictions</span>
                                <strong>{stats.summary.n}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Correct</span>
                                <strong>{stats.summary.k}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Accuracy</span>
                                <strong>{stats.summary.n ? pct(stats.summary.accuracy) : '-'}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Baseline</span>
                                <strong>10.00%</strong>
                            </div>
                        </div>
                        <div className='matches-pro__verdict'>{stats.summary.verdict}</div>
                        <div className='matches-pro__mini'>
                            Last 100: {pct(stats.summary.recent_accuracy)}, longest hit streak{' '}
                            {stats.state.longest_win}, longest miss streak {stats.state.longest_loss}
                        </div>
                        {Object.keys(stats.state.by_quality).length > 0 && (
                            <div className='matches-pro__mini'>
                                {Object.entries(stats.state.by_quality).map(([q, v]) => (
                                    <span key={q} className='matches-pro__tag'>
                                        {q}: {v.correct}/{v.n} ({v.n ? ((v.correct / v.n) * 100).toFixed(1) : '0.0'}%)
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}

                <div className='matches-pro__section-title'>Signal feed</div>
                <div className='matches-pro__feed'>
                    {feed.map(f => (
                        <div key={f.t} className={`matches-pro__feed-row ${f.hit ? 'hit' : 'miss'}`}>
                            <span>{clockOf(f.t)}</span>
                            <span>MATCH {f.predicted}</span>
                            <span>actual {f.actual}</span>
                            <span>{f.quality}</span>
                            <span>{f.hit ? 'HIT' : 'miss'}</span>
                        </div>
                    ))}
                    {!feed.length && <span className='matches-pro__muted'>Waiting for the next tick...</span>}
                </div>

                <div className='matches-pro__section-title'>Digit distribution - last {sample.length} ticks</div>
                <div className='matches-pro__dist'>
                    {distribution.map(d => (
                        <div key={d.digit} className='matches-pro__row'>
                            <span className={`matches-pro__row-digit ${d.digit === predicted ? 'is-predicted' : ''}`}>
                                {d.digit}
                            </span>
                            <span className='matches-pro__bar'>
                                <span style={{ width: `${(d.p / max_pct) * 100}%` }} />
                            </span>
                            <span className='matches-pro__row-pct'>{d.p.toFixed(1)}%</span>
                        </div>
                    ))}
                </div>

                {diag && (
                    <div className='matches-pro__diag'>
                        socket {diag.ready_state} | messages {diag.messages} | last {diag.last_msg_type} | symbols{' '}
                        {diag.symbols_seen} | precision {diag.pip_source} ({diag.known_decimals} known)
                        {diag.last_error ? ` | ${diag.last_error}` : ''}
                    </div>
                )}

                <div className='matches-pro__note'>
                    The engine grades every prediction it makes, including the ones it labels NO SIGNAL. Expect the
                    accuracy to converge on 10%. At a {payout}x payout you need {pct(1 / payout)} just to break even,
                    so a strategy can be genuinely above 10% and still lose money. Trading stays disabled until this
                    panel has hundreds of graded predictions behind it.
                </div>
            </div>
        </div>
    );
};

export default MatchesPro;