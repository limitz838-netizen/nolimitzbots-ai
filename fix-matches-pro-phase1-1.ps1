# ==========================================================================
#  NolimitzBots - Matches Pro, Phase 1.1 fix
#  Precision now comes from pip_size on the tick/history response instead of
#  the symbol list, so digits are never dropped for unknown precision.
#  Adds a diagnostics line to the panel.
#
#  Only rewrites the three Matches Pro files. Touches nothing else.
#
#      powershell -ExecutionPolicy Bypass -File .\fix-matches-pro-phase1-1.ps1
#
#  Flags:  -SkipBuild   -NoPush
# ==========================================================================
param([switch]$SkipBuild, [switch]$NoPush)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "  FAILED: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Info($msg) { Write-Host $msg -ForegroundColor Cyan }

try { $root = (git rev-parse --show-toplevel).Trim() } catch { Fail 'Not inside a git repository.' }
Set-Location $root
if (-not (Test-Path 'src/pages/matches-pro/matches-pro.tsx')) { Fail 'Phase 1 files not found. Run the Phase 1 installer first.' }
Info "Repo: $root"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

$tickStream = @'
// @ts-nocheck - shared Deriv tick stream for NolimitzBots surfaces.
//
// One public WebSocket, shared by every subscriber, with:
//   * pip-derived decimal precision per symbol (never hard-coded)
//   * correct last-digit extraction at that precision
//   * seeded history so a window is full immediately, then live ticks
//   * automatic reconnect with backoff and honest status reporting
//   * reference-counted subscriptions (forget when nobody is listening)
//
// This replaces the pattern of every page opening its own raw socket.
// Matches Pro is the first consumer; other surfaces can migrate later.
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';

// 'connecting' | 'live' | 'reconnecting' | 'disconnected'
export const TICK_STATUS = {
    CONNECTING: 'connecting',
    LIVE: 'live',
    RECONNECTING: 'reconnecting',
    DISCONNECTED: 'disconnected',
};

const MAX_HISTORY = 5000; // Deriv ticks_history hard limit
const MAX_BACKOFF_MS = 30000;

let ws = null;
let status = TICK_STATUS.DISCONNECTED;
let attempts = 0;
let reconnect_timer = null;

const subscribers = new Set();
const decimals = {}; // symbol -> decimal places, learned from active_symbols pip
const stream_ids = {}; // symbol -> Deriv subscription id
let symbols_cache = [];

// Diagnostics - surfaced in the UI so a stalled stream is diagnosable at a
// glance instead of guessed at.
const diag = { messages: 0, last_msg_type: '-', last_error: '', symbols_seen: 0, pip_source: '-' };
export const getDiagnostics = () => ({
    ...diag,
    ready_state: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'NONE',
    known_decimals: Object.keys(decimals).length,
});

// ---------------------------------------------------------------- helpers

// Last digit at the symbol's real precision. 1234.5 with 3 decimals is
// "1234.500" -> digit 0, which is what Deriv settles against.
export const lastDigitOf = (quote, dec) => Number(Number(quote).toFixed(dec).slice(-1));

export const getDecimals = symbol => decimals[symbol];

export const getVolatilitySymbols = () => symbols_cache;

export const getStatus = () => status;

const setStatus = next => {
    if (status === next) return;
    status = next;
    subscribers.forEach(s => {
        try {
            s.onStatus?.(next);
        } catch {
            /* a bad handler must not kill the stream */
        }
    });
};

const symbolsInUse = () => [...new Set([...subscribers].map(s => s.symbol))];

const historyCountFor = symbol => {
    const wanted = [...subscribers].filter(s => s.symbol === symbol).map(s => s.count || 100);
    return Math.min(MAX_HISTORY, Math.max(100, ...wanted));
};

const send = payload => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

const requestHistory = symbol => {
    send({
        ticks_history: symbol,
        count: historyCountFor(symbol),
        end: 'latest',
        style: 'ticks',
        subscribe: 1,
    });
};

const forgetSymbol = symbol => {
    const id = stream_ids[symbol];
    if (id) {
        send({ forget: id });
        delete stream_ids[symbol];
    }
};

// ---------------------------------------------------------------- socket

const scheduleReconnect = () => {
    if (reconnect_timer || !subscribers.size) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
    attempts += 1;
    setStatus(TICK_STATUS.RECONNECTING);
    reconnect_timer = setTimeout(() => {
        reconnect_timer = null;
        connect();
    }, delay);
};

const handleMessage = raw => {
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return; // malformed frame - ignore, the stream continues
    }

    // Learn precision for every symbol before we interpret any digit.
    diag.messages += 1;
    if (data.msg_type) diag.last_msg_type = data.msg_type;

    if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
        symbols_cache = data.active_symbols
            .filter(s => /volatility/i.test(s.display_name || '') || /^(R_|1HZ)/.test(s.symbol || s.underlying_symbol || ''))
            .map(s => ({
                code: s.symbol || s.underlying_symbol,
                label: s.display_name || s.name || s.symbol || s.underlying_symbol,
                open: s.exchange_is_open !== 0,
            }))
            .filter(s => s.code);
        data.active_symbols.forEach(s => {
            const code = s.symbol || s.underlying_symbol;
            if (!code) return;
            // Field naming differs between Deriv gateways: pip is a fractional
            // value (0.01 -> 2 places), pip_size is already a place count.
            if (typeof s.pip_size === 'number') {
                decimals[code] = s.pip_size;
                diag.pip_source = 'active_symbols.pip_size';
            } else if (typeof s.pip === 'number') {
                decimals[code] = `${s.pip}`.split('.')[1]?.length ?? 0;
                diag.pip_source = 'active_symbols.pip';
            }
        });
        diag.symbols_seen = data.active_symbols.length;
        subscribers.forEach(s => s.onSymbols?.(symbols_cache));
        return;
    }

    if (data.error) {
        diag.last_error = `${data.error.code || 'error'}: ${data.error.message || 'Deriv API error'}`;
        subscribers.forEach(s => s.onError?.(data.error.message || 'Deriv API error', data.error.code));
        return;
    }

    if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
        const symbol = data.echo_req.ticks_history;
        if (data.subscription?.id) stream_ids[symbol] = data.subscription.id;
        // pip_size ships with the response and is authoritative. Prefer it over
        // anything learned from the symbol list.
        if (typeof data.pip_size === 'number') {
            decimals[symbol] = data.pip_size;
            diag.pip_source = 'history.pip_size';
        }
        const dec = decimals[symbol];
        if (dec === undefined) {
            diag.last_error = 'no precision for ' + symbol;
            return;
        }
        const prices = data.history?.prices || [];
        const digits = prices.map(p => lastDigitOf(p, dec));
        subscribers.forEach(s => {
            if (s.symbol !== symbol) return;
            s.onHistory?.({
                symbol,
                decimals: dec,
                digits: digits.slice(-(s.count || 100)),
                quote: prices.length ? Number(prices[prices.length - 1]).toFixed(dec) : null,
            });
        });
        setStatus(TICK_STATUS.LIVE);
        return;
    }

    if (data.msg_type === 'tick' && data.tick) {
        const symbol = data.tick.symbol || data.tick.underlying_symbol;
        if (data.subscription?.id) stream_ids[symbol] = data.subscription.id;
        if (typeof data.tick.pip_size === 'number') {
            decimals[symbol] = data.tick.pip_size;
            diag.pip_source = 'tick.pip_size';
        }
        const dec = decimals[symbol];
        if (dec === undefined || data.tick.quote === undefined) {
            if (dec === undefined) diag.last_error = 'no precision for ' + symbol;
            return;
        }
        const digit = lastDigitOf(data.tick.quote, dec);
        if (!Number.isFinite(digit)) return; // malformed tick - drop it
        subscribers.forEach(s => {
            if (s.symbol !== symbol) return;
            s.onTick?.({
                symbol,
                decimals: dec,
                digit,
                quote: Number(data.tick.quote).toFixed(dec),
                epoch: data.tick.epoch,
            });
        });
        setStatus(TICK_STATUS.LIVE);
    }
};

const connect = () => {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    setStatus(attempts ? TICK_STATUS.RECONNECTING : TICK_STATUS.CONNECTING);

    try {
        ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
    } catch {
        ws = null;
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        attempts = 0;
        send({ active_symbols: 'brief' });
        symbolsInUse().forEach(requestHistory);
    };
    ws.onmessage = msg => handleMessage(msg.data);
    ws.onerror = () => {
        try {
            ws?.close();
        } catch {
            /* noop */
        }
    };
    ws.onclose = () => {
        ws = null;
        Object.keys(stream_ids).forEach(k => delete stream_ids[k]);
        if (subscribers.size) scheduleReconnect();
        else setStatus(TICK_STATUS.DISCONNECTED);
    };
};

// ---------------------------------------------------------------- public API

/**
 * Subscribe to a symbol's digit stream.
 *
 * subscribeTicks({
 *   symbol: 'R_100',
 *   count: 1000,
 *   onHistory: ({ digits, quote, decimals }) => {},
 *   onTick:    ({ digit, quote, epoch }) => {},
 *   onStatus:  status => {},
 *   onSymbols: list => {},
 *   onError:   (message, code) => {},
 * })
 *
 * Returns an unsubscribe function. Always call it on unmount.
 */
export const subscribeTicks = options => {
    const sub = { count: 100, ...options };
    subscribers.add(sub);

    if (!ws) {
        connect();
    } else if (ws.readyState === WebSocket.OPEN) {
        sub.onStatus?.(status);
        if (symbols_cache.length) sub.onSymbols?.(symbols_cache);
        requestHistory(sub.symbol);
    }

    return () => {
        subscribers.delete(sub);
        const still_used = symbolsInUse().includes(sub.symbol);
        if (!still_used) forgetSymbol(sub.symbol);
        if (!subscribers.size) {
            if (reconnect_timer) {
                clearTimeout(reconnect_timer);
                reconnect_timer = null;
            }
            attempts = 0;
            try {
                ws?.close();
            } catch {
                /* noop */
            }
            ws = null;
            setStatus(TICK_STATUS.DISCONNECTED);
        }
    };
};
'@

$matchesPage = @'
// @ts-nocheck - Matches Pro (Phase 1: live tick + last-digit engine only).
//
// This phase deliberately contains NO prediction and NO trading.
// It proves the tick pipeline is correct before anything can place an order.
import React from 'react';
import { subscribeTicks, TICK_STATUS, getDiagnostics } from '@/components/shared/nlb/tick-stream';
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
    const [diag, setDiag] = React.useState(null);

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

                {diag && (
                    <div className='matches-pro__diag'>
                        socket {diag.ready_state} | messages {diag.messages} | last {diag.last_msg_type} | symbols{' '}
                        {diag.symbols_seen} | precision {diag.pip_source} ({diag.known_decimals} known)
                        {diag.last_error ? ` | ${diag.last_error}` : ''}
                    </div>
                )}

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
'@

$matchesStyles = @'
.matches-pro {
    height: var(--tab-content-height);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 1.6rem 1.6rem 14rem;
    background: radial-gradient(1200px 500px at 85% -10%, rgba(212, 175, 55, 0.12), transparent 60%),
        linear-gradient(180deg, #0a0e17 0%, #0c1120 55%, #0a0e17 100%);

    &__panel {
        max-width: 640px;
        margin: 0 auto;
        padding: 1.8rem;
        border-radius: 1.6rem;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(212, 175, 55, 0.28);
    }

    &__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
    }

    &__title {
        color: #e8cf7a;
        font-size: 2rem;
        font-weight: 800;
        letter-spacing: 0.04em;
    }

    &__subtitle {
        color: #9aa1b0;
        font-size: 1.2rem;
        margin: 0.4rem 0 1.4rem;
    }

    &__status {
        flex-shrink: 0;
        font-size: 1.1rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 0.5rem 0.9rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;

        &--live {
            color: #34d399;
            border-color: rgba(52, 211, 153, 0.4);
        }

        &--reconnecting,
        &--connecting {
            color: #fbbf24;
            border-color: rgba(245, 158, 11, 0.4);
        }

        &--disconnected {
            color: #f87171;
            border-color: rgba(248, 113, 113, 0.4);
        }
    }

    &__dot {
        width: 0.8rem;
        height: 0.8rem;
        border-radius: 50%;
        background: currentColor;
    }

    &__warn {
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.4);
        color: #fbbf24;
        border-radius: 1rem;
        padding: 1rem;
        font-size: 1.2rem;
        margin-bottom: 1.2rem;
    }

    &__controls {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 1.4rem;
    }

    &__field {
        flex: 1 1 200px;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;

        span {
            color: #9aa1b0;
            font-size: 1.1rem;
        }

        select {
            background: rgba(10, 14, 23, 0.9);
            border: 1px solid rgba(212, 175, 55, 0.3);
            color: #e8eaf0;
            border-radius: 0.8rem;
            padding: 0.9rem 1rem;
            font-size: 1.3rem;
        }
    }

    &__readout {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.8rem;
        margin-bottom: 1.6rem;

        @media (max-width: 600px) {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    &__stat {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 1rem;
        padding: 0.9rem;
        text-align: center;

        span {
            display: block;
            color: #9aa1b0;
            font-size: 1rem;
            margin-bottom: 0.3rem;
        }

        strong {
            color: #e8eaf0;
            font-size: 1.6rem;
            font-weight: 700;
        }
    }

    &__digit {
        color: #e8cf7a !important;
        font-size: 2.4rem !important;
    }

    &__section-title {
        color: #e8cf7a;
        font-size: 1.2rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        margin: 1.6rem 0 0.8rem;
    }

    &__dist {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    &__row {
        display: flex;
        align-items: center;
        gap: 0.8rem;
    }

    &__row-digit {
        width: 1.6rem;
        color: #e8eaf0;
        font-size: 1.3rem;
        font-weight: 700;
        text-align: center;
    }

    &__bar {
        flex: 1;
        height: 1.2rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 999px;
        overflow: hidden;

        span {
            display: block;
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(212, 175, 55, 0.5), #e8cf7a);
            transition: width 0.25s ease;
        }
    }

    &__row-pct {
        width: 4.6rem;
        text-align: right;
        color: #cbd5e1;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__recent {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    &__chip {
        min-width: 2.4rem;
        text-align: center;
        padding: 0.4rem 0.5rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #e8eaf0;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__muted {
        color: #6b7280;
        font-size: 1.2rem;
    }

    &__diag {
        margin-top: 1.6rem;
        padding: 0.8rem 1rem;
        border-radius: 0.8rem;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #7c8698;
        font-family: monospace;
        font-size: 1rem;
        line-height: 1.5;
        word-break: break-word;
    }

    &__note {
        margin-top: 1.8rem;
        padding: 1rem;
        border-radius: 1rem;
        background: rgba(148, 163, 184, 0.08);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: #9aa1b0;
        font-size: 1.1rem;
        line-height: 1.5;
    }
}
'@

Info ''
Info '[1/3] Rewriting Matches Pro files'
Write-File 'src/components/shared/nlb/tick-stream.ts' $tickStream
Write-File 'src/pages/matches-pro/matches-pro.tsx'    $matchesPage
Write-File 'src/pages/matches-pro/matches-pro.scss'   $matchesStyles

$ErrorActionPreference = 'Continue'

Info ''
if ($SkipBuild) {
    Info '[2/3] Build skipped (-SkipBuild)'
} else {
    Info '[2/3] Running npm run build (a few minutes)'
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host ''; Fail 'Build failed. Nothing committed. Send me the first red error block.' }
    Ok 'build succeeded'
}

Info ''
Info '[3/3] Commit and push'
git add -A
git commit -m "Matches Pro Phase 1.1: derive precision from pip_size, add stream diagnostics"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }

if ($NoPush) {
    Info 'Push skipped (-NoPush). Run: git push'
} else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}

Write-Host ''
Write-Host 'Done. Hard refresh the Matches Pro tab (Ctrl+Shift+R) once Vercel is green.' -ForegroundColor Yellow
