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