// @ts-nocheck — follows vendored dashboard code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { FREE_BOTS } from '../free-bots';
import './market-pulse.scss';

const SYMBOLS = [
    { code: 'R_10', label: 'Vol 10' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_100', label: 'Vol 100' },
];

// Fallback pip decimals (used until active_symbols responds)
const FALLBACK_DECIMALS = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2 };
const WINDOW = 120;

const lastDigit = (quote, decimals) => Number(Number(quote).toFixed(decimals).slice(-1));

const findBot = id => FREE_BOTS.find(b => b.id === id);

const MarketPulse = observer(() => {
    const { dashboard, load_modal } = useStore();
    const [symbol, setSymbol] = React.useState('R_100');
    const [digits, setDigits] = React.useState([]);
    const [quote, setQuote] = React.useState(null);
    const [status, setStatus] = React.useState('connecting'); // connecting | live | error
    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const symbol_ref = React.useRef(symbol);
    symbol_ref.current = symbol;

    React.useEffect(() => {
        let alive = true;
        const url = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
        const ws = new WebSocket(url);
        ws_ref.current = ws;

        const subscribe = sym => {
            setDigits([]);
            setQuote(null);
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(JSON.stringify({ ticks_history: sym, count: WINDOW, end: 'latest', style: 'ticks', subscribe: 1 }));
        };

        ws.onopen = () => {
            if (!alive) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            subscribe(symbol_ref.current);
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
                        const d = `${s.pip}`.split('.')[1]?.length ?? 0;
                        decimals_ref.current[code] = d;
                    }
                });
                return;
            }
            if (data.msg_type === 'history' && data.echo_req?.ticks_history === symbol_ref.current) {
                const dec = decimals_ref.current[symbol_ref.current] ?? 2;
                const prices = data.history?.prices || [];
                setDigits(prices.slice(-WINDOW).map(p => lastDigit(p, dec)));
                if (prices.length) setQuote(Number(prices[prices.length - 1]).toFixed(dec));
                setStatus('live');
                return;
            }
            if (data.msg_type === 'tick' && data.tick?.symbol === symbol_ref.current) {
                const dec = decimals_ref.current[symbol_ref.current] ?? 2;
                setQuote(Number(data.tick.quote).toFixed(dec));
                setDigits(prev => [...prev, lastDigit(data.tick.quote, dec)].slice(-WINDOW));
                setStatus('live');
            }
        };
        ws.onerror = () => alive && setStatus('error');
        ws.onclose = () => alive && setStatus(s => (s === 'live' ? 'error' : s));

        // Resubscribe when symbol changes on the open socket
        const resub = () => {
            if (ws.readyState === WebSocket.OPEN) subscribe(symbol_ref.current);
        };
        window.addEventListener('nlb-pulse-symbol', resub);

        return () => {
            alive = false;
            window.removeEventListener('nlb-pulse-symbol', resub);
            try {
                ws.close();
            } catch {
                /* noop */
            }
        };
    }, []);

    const changeSymbol = sym => {
        setSymbol(sym);
        setStatus('connecting');
        // Defer so symbol_ref updates before the socket resubscribes
        setTimeout(() => window.dispatchEvent(new Event('nlb-pulse-symbol')), 0);
    };

    // ---- stats over the window ----
    const counts = Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const total = digits.length || 1;
    const pct = counts.map(c => (100 * c) / total);
    const max_d = pct.indexOf(Math.max(...pct));
    const min_d = pct.indexOf(Math.min(...pct));
    const even_pct = pct[0] + pct[2] + pct[4] + pct[6] + pct[8];
    const over2_pct = pct.slice(3).reduce((a, b) => a + b, 0); // 3-9 wins DIGITOVER 2
    const under7_pct = pct.slice(0, 7).reduce((a, b) => a + b, 0); // 0-6 wins DIGITUNDER 7
    const stream = digits.slice(-8);
    const has_data = digits.length >= 20;

    const eo_side = even_pct >= 50 ? 'Even' : 'Odd';
    const eo_pct = even_pct >= 50 ? even_pct : 100 - even_pct;
    const eo_bot = even_pct >= 50 ? findBot('nlb-even-flow') : findBot('nlb-odd-rush');
    const ou_side = over2_pct - 70 >= under7_pct - 70 ? 'Over 2' : 'Under 7';
    const ou_pct = ou_side === 'Over 2' ? over2_pct : under7_pct;
    const ou_bot = ou_side === 'Over 2' ? findBot('nlb-over-2') : findBot('nlb-under-7');

    const loadBot = async bot => {
        if (!bot) return;
        await load_modal.loadStrategyToBuilder({ id: bot.id, name: bot.name, save_type: 'unsaved', xml: bot.xml }, false);
        dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    return (
        <div className='market-pulse'>
            <div className='market-pulse__head'>
                <div className='market-pulse__title-wrap'>
                    <span className={`market-pulse__dot market-pulse__dot--${status}`} />
                    <span className='market-pulse__title'>Live Market Pulse</span>
                </div>
                {quote && <span className='market-pulse__quote'>{quote}</span>}
            </div>

            <div className='market-pulse__symbols'>
                {SYMBOLS.map(s => (
                    <button
                        key={s.code}
                        className={`market-pulse__symbol ${symbol === s.code ? 'market-pulse__symbol--active' : ''}`}
                        onClick={() => changeSymbol(s.code)}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            {status === 'error' && (
                <div className='market-pulse__note'>Connection lost — refresh the page to reconnect.</div>
            )}

            <div className='market-pulse__digits'>
                {pct.map((p, d) => (
                    <div
                        key={d}
                        className={`market-pulse__digit ${d === max_d && has_data ? 'market-pulse__digit--hot' : ''} ${
                            d === min_d && has_data ? 'market-pulse__digit--cold' : ''
                        }`}
                    >
                        <span className='market-pulse__digit-num'>{d}</span>
                        <span className='market-pulse__digit-pct'>{has_data ? `${p.toFixed(1)}%` : '—'}</span>
                        <span className='market-pulse__digit-bar' style={{ width: `${Math.min(100, p * 6)}%` }} />
                    </div>
                ))}
            </div>

            <div className='market-pulse__stream'>
                {stream.map((d, i) => (
                    <span key={i} className={`market-pulse__eo ${d % 2 === 0 ? 'market-pulse__eo--e' : 'market-pulse__eo--o'}`}>
                        {d % 2 === 0 ? 'E' : 'O'}
                    </span>
                ))}
            </div>

            <div className='market-pulse__signals'>
                {[
                    { tag: 'EVEN / ODD', side: eo_side, p: eo_pct, bot: eo_bot },
                    { tag: 'OVER / UNDER', side: ou_side, p: ou_pct, bot: ou_bot },
                ].map(sig => (
                    <div key={sig.tag} className='market-pulse__signal'>
                        <div className='market-pulse__signal-head'>
                            <span className='market-pulse__signal-tag'>{sig.tag}</span>
                            <span className='market-pulse__signal-side'>{sig.side}</span>
                        </div>
                        <div className='market-pulse__signal-meter'>
                            <span className='market-pulse__signal-fill' style={{ width: `${has_data ? sig.p : 0}%` }} />
                        </div>
                        <div className='market-pulse__signal-row'>
                            <span>{has_data ? `${sig.p.toFixed(1)}% of last ${digits.length} ticks` : 'Collecting ticks…'}</span>
                            <span>
                                Hot {has_data ? max_d : '—'} · Cold {has_data ? min_d : '—'}
                            </span>
                        </div>
                        <button className='market-pulse__signal-load' disabled={!has_data} onClick={() => loadBot(sig.bot)}>
                            ⚡ Load {sig.bot?.name}
                        </button>
                    </div>
                ))}
            </div>

            <div className='market-pulse__disclaimer'>
                Live statistics from recent ticks — they describe history, not future results.
            </div>
        </div>
    );
});

export default MarketPulse;
