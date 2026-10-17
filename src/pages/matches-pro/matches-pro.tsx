// @ts-nocheck — Matches Pro v3: scan -> lock -> fire (DIGITMATCH only).
//
// Flow: tap SCAN -> 13 volatility markets stream live -> every sweep each market's
// strongest digit is scored (matches-scan-engine) -> the leader must clear the bar
// and hold it on the next sweep after fresh ticks -> one MATCH contract is bought
// on each of the market's top-K digits ("cover"), all in parallel on one tick ->
// settlement -> result sheet.
//
// Cover mode, measured on 130k real ticks (495 entries): covering 1/2/3/4/5 digits
// hit 8.7/21/30/39/50% of entries and cut the longest losing streak from 62 to
// 23/17/11/11. Average loss stays ~10% of risk either way (Deriv's margin).
//
// Demo accounts only. Real accounts can scan but cannot trade from this page.
import React from 'react';
import { api_base } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { isDemoAccount } from '@/utils/account-helpers';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import {
    bestMatch,
    lastDigit,
    topDigits,
    CONFIRM_TICKS,
    EDGE_BAR,
    HISTORY,
    MIN_TICKS,
    NULL_P,
} from '@/components/shared/nlb/matches-scan-engine';
import PageBoundary from '@/components/shared/nlb/page-boundary';
import './matches-pro.scss';

const MARKETS = [
    { code: '1HZ10V', name: 'Vol 10 (1s)' },
    { code: '1HZ15V', name: 'Vol 15 (1s)' },
    { code: '1HZ25V', name: 'Vol 25 (1s)' },
    { code: '1HZ30V', name: 'Vol 30 (1s)' },
    { code: '1HZ50V', name: 'Vol 50 (1s)' },
    { code: '1HZ75V', name: 'Vol 75 (1s)' },
    { code: '1HZ90V', name: 'Vol 90 (1s)' },
    { code: '1HZ100V', name: 'Vol 100 (1s)' },
    { code: 'R_10', name: 'Vol 10' },
    { code: 'R_25', name: 'Vol 25' },
    { code: 'R_50', name: 'Vol 50' },
    { code: 'R_75', name: 'Vol 75' },
    { code: 'R_100', name: 'Vol 100' },
];
const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ15V': 3, '1HZ25V': 2, '1HZ30V': 3, '1HZ50V': 2, '1HZ75V': 2, '1HZ90V': 3, '1HZ100V': 2,
};

const SWEEP_MS = 2500;
const MAX_COVER = 8;
const AUTO_GAP_MS = 1500;
const DEFAULT_PAYOUT = 8.93; // payout per 1 staked; replaced by a live quote
const SETTINGS_KEY = 'nlb_matches_pro_v3';
const STEPS = ['Scan', 'Confirm', 'Fire', 'Result'];

const loadSettings = () => {
    try {
        const s = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
        return {
            stake: Number(s.stake) >= 0.35 ? Number(s.stake) : 1,
            cover: Math.min(MAX_COVER, Math.max(1, parseInt(s.cover, 10) || 3)),
            stop_loss: Number(s.stop_loss) > 0 ? Number(s.stop_loss) : 20,
            take_profit: Number(s.take_profit) > 0 ? Number(s.take_profit) : 10,
        };
    } catch {
        return { stake: 1, cover: 3, stop_loss: 20, take_profit: 10 };
    }
};
const saveSettings = s => {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
        /* per-viewer convenience only */
    }
};

// Chance a session reaches the profit target before the stop-loss, by Monte Carlo
// on fair odds (each covered digit = 10%, which real Deriv ticks matched).
const sessionOdds = (cover, stake, payout, tp, sl) => {
    if (!(stake > 0) || !(tp > 0) || !(sl > 0)) return null;
    const p = cover / 10;
    const win = stake * (payout - cover);
    const loss = stake * cover;
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let reached = 0;
    const RUNS = 2000;
    for (let r = 0; r < RUNS; r++) {
        let pnl = 0;
        for (let n = 0; n < 2000 && pnl < tp && pnl > -sl; n++) pnl += rnd() < p ? win : -loss;
        if (pnl >= tp) reached += 1;
    }
    return reached / RUNS;
};

const pct = v => `${(v * 100).toFixed(1)}%`;
const signedPct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const money = v => (Math.round(v * 100) / 100).toFixed(2);
const sleep = ms => new Promise(r => window.setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
    Promise.race([
        Promise.resolve(p),
        new Promise((_, rej) => window.setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

const MatchesPro = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();
    const { run_panel, transactions, summary_card } = useStore();

    const account = React.useMemo(
        () => (accountList || []).find(a => a.loginid === activeLoginid),
        [accountList, activeLoginid]
    );
    const currency = account?.currency || 'USD';
    const is_demo = isDemoAccount(activeLoginid || '');
    const can_trade = Boolean(isAuthorized && activeLoginid && is_demo);

    const [settings, setSettings] = React.useState(loadSettings);
    const [phase, setPhase] = React.useState('idle'); // idle | scanning | confirming | firing | settling | done
    const [rows, setRows] = React.useState({});
    const [leader, setLeader] = React.useState(null);
    const [armed, setArmed] = React.useState(null);
    const [sweep, setSweep] = React.useState(0);
    const [feed, setFeed] = React.useState([]);
    const [payout, setPayout] = React.useState(DEFAULT_PAYOUT);
    const [batch, setBatch] = React.useState(null);
    const [result, setResult] = React.useState(null);
    const [session, setSession] = React.useState({ batches: 0, hits: 0, pnl: 0 });
    const [notice, setNotice] = React.useState('');
    const [auto, setAuto] = React.useState(false);
    const [lastEntry, setLastEntry] = React.useState(null);

    const ws_ref = React.useRef(null);
    const timer_ref = React.useRef(null);
    const reconnect_ref = React.useRef(null);
    const active_ref = React.useRef(false);
    const digits_ref = React.useRef({});
    const ticks_ref = React.useRef({});
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const armed_ref = React.useRef(null);
    const sweep_ref = React.useRef(0);
    const track_ref = React.useRef(null);
    const mounted_ref = React.useRef(true);
    const cfg_ref = React.useRef({});
    cfg_ref.current = { settings, currency, can_trade, payout };
    const session_ref = React.useRef(session);
    session_ref.current = session;
    const auto_ref = React.useRef(auto);
    auto_ref.current = auto;
    const auto_timer_ref = React.useRef(null);

    const say = line => setFeed(prev => [{ t: Date.now() + Math.random(), line }, ...prev].slice(0, 8));

    const updateSettings = patch => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            return next;
        });
    };

    // ------------------------------------------------------------ socket
    const stopSweeps = () => {
        if (timer_ref.current) {
            window.clearTimeout(timer_ref.current);
            timer_ref.current = null;
        }
    };
    const closeSocket = () => {
        if (reconnect_ref.current) {
            window.clearTimeout(reconnect_ref.current);
            reconnect_ref.current = null;
        }
        const ws = ws_ref.current;
        ws_ref.current = null;
        if (ws) {
            ws.onclose = null;
            ws.onmessage = null;
            ws.onerror = null;
            try {
                ws.close();
            } catch {
                /* noop */
            }
        }
    };
    const stopAll = () => {
        active_ref.current = false;
        stopSweeps();
        closeSocket();
    };

    React.useEffect(() => {
        mounted_ref.current = true;
        return () => {
            mounted_ref.current = false;
            if (auto_timer_ref.current) window.clearTimeout(auto_timer_ref.current);
            stopAll();
            track_ref.current?.cancel?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Live payout quote for the current stake (public socket, no login needed).
    React.useEffect(() => {
        const stake = Number(settings.stake);
        if (!(stake >= 0.35)) return undefined;
        let ws;
        let done = false;
        const t = window.setTimeout(() => {
            try {
                ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
                ws.onopen = () =>
                    ws.send(
                        JSON.stringify({
                            proposal: 1,
                            amount: stake,
                            basis: 'stake',
                            contract_type: 'DIGITMATCH',
                            currency,
                            duration: 1,
                            duration_unit: 't',
                            underlying_symbol: 'R_100',
                            barrier: '5',
                        })
                    );
                ws.onmessage = m => {
                    try {
                        const d = JSON.parse(m.data);
                        const ask = Number(d?.proposal?.ask_price);
                        const win = Number(d?.proposal?.payout);
                        if (!done && ask > 0 && win > 0 && mounted_ref.current) setPayout(win / ask);
                    } catch {
                        /* noop */
                    }
                    done = true;
                    try {
                        ws.close();
                    } catch {
                        /* noop */
                    }
                };
            } catch {
                /* keep the default estimate */
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
    }, [settings.stake, currency]);

    // ------------------------------------------------------------ execution
    const fire = async (code, digits, edge) => {
        const { settings: s, currency: cur, can_trade: allowed } = cfg_ref.current;
        const n = digits.length;
        const digit = digits[0];
        const amount = Math.max(0.35, Number(s.stake) || 0.35);
        const list = digits.join(', ');

        if (!allowed) {
            setPhase('done');
            setNotice('Entry found. Sign in with a Deriv demo account to open contracts.');
            say(`Entry found on ${code}: digits ${list}. Not traded (demo account required).`);
            return;
        }

        setPhase('firing');
        setBatch({ code, digit, digits, opened: 0, settled: 0, requested: n });
        say(`Opening MATCH on ${code} for digit${n > 1 ? 's' : ''} ${list}…`);
        unlockAudio();
        try {
            run_panel.run_id = `matches-pro-${Date.now()}`;
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* run panel is a mirror only */
        }

        const paramsFor = d => ({
            amount,
            basis: 'stake',
            contract_type: 'DIGITMATCH',
            currency: cur,
            duration: 1,
            duration_unit: 't',
            underlying_symbol: code,
            barrier: String(d),
        });
        const HARD = /Insufficient balance|Market closed|Session expired/;
        const openOne = async slot => {
            const parameters = paramsFor(digits[slot - 1]);
            try {
                const r = await withTimeout(
                    api_base.api.send({
                        buy: '1',
                        price: amount,
                        parameters,
                        passthrough: { nolimitz_source: 'matches-pro', slot },
                    }),
                    5000,
                    `Buy #${slot}`
                );
                if (r?.error) throw r;
                if (r?.buy?.contract_id) return r.buy.contract_id;
            } catch (e) {
                if (HARD.test(describeError(e))) {
                    say(`Contract ${slot} not opened: ${describeError(e)}`);
                    return null;
                }
            }
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    const p = await withTimeout(api_base.api.send({ proposal: 1, ...parameters }), 5000, 'Proposal');
                    if (p?.error) throw new Error(p.error.message);
                    const b = await withTimeout(
                        api_base.api.send({
                            buy: p.proposal.id,
                            price: Number(p.proposal.ask_price ?? amount),
                            passthrough: { nolimitz_source: 'matches-pro', slot },
                        }),
                        5000,
                        'Buy'
                    );
                    if (b?.error) throw new Error(b.error.message);
                    if (b?.buy?.contract_id) return b.buy.contract_id;
                } catch (e) {
                    if (attempt === 3 || HARD.test(describeError(e))) {
                        say(`Contract ${slot} not opened: ${describeError(e)}`);
                        return null;
                    }
                    await sleep(120 + slot * 40);
                }
            }
            return null;
        };

        const t0 = performance.now();
        const ids = (await Promise.all(Array.from({ length: n }, (_, i) => openOne(i + 1)))).filter(Boolean);
        const ms = Math.round(performance.now() - t0);
        if (!mounted_ref.current) return;

        if (!ids.length) {
            try {
                run_panel?.setIsRunning?.(false);
            } catch {
                /* noop */
            }
            setPhase('done');
            setNotice('No contracts were accepted. Check your balance and try again.');
            return;
        }

        say(`${ids.length}/${n} contract${n > 1 ? 's' : ''} opened together in ${ms}ms.`);
        setBatch(b => ({ ...b, opened: ids.length }));
        setPhase('settling');

        let exitDigit = null;
        track_ref.current = trackContracts(ids, {
            timeoutMs: 60000,
            onUpdate: ({ settled }) => mounted_ref.current && setBatch(b => (b ? { ...b, settled } : b)),
            onContract: c => {
                try {
                    transactions?.onBotContractEvent?.(c);
                    summary_card?.onBotContractEvent?.(c);
                    run_panel?.onBotContractEvent?.(c);
                } catch {
                    /* mirror only */
                }
                if (!c?.is_sold) return;
                // A winning MATCH contract's barrier IS the landed digit.
                if (Number(c.profit) > 0 && c.barrier !== undefined && c.barrier !== null) {
                    exitDigit = Number(c.barrier);
                    return;
                }
                if (exitDigit !== null) return;
                const shown =
                    c.exit_tick_display_value ?? c.exit_spot_display_value ?? c.exit_tick ?? c.exit_spot ?? c.current_spot;
                if (shown === undefined || shown === null) return;
                const dec = decimals_ref.current[code] ?? 2;
                const str = typeof shown === 'number' ? shown.toFixed(dec) : String(shown);
                const ch = str.slice(-1);
                if (/\d/.test(ch)) exitDigit = Number(ch);
            },
            onDone: ({ total, wins, count }) => {
                try {
                    run_panel?.setIsRunning?.(false);
                } catch {
                    /* noop */
                }
                track_ref.current = null;
                if (!mounted_ref.current) return;
                const hit = total > 0;
                if (hit) playWin();
                else playLoss();
                setSession(prev => ({
                    batches: prev.batches + 1,
                    hits: prev.hits + (hit ? 1 : 0),
                    pnl: Number((prev.pnl + total).toFixed(2)),
                }));
                const entry = { code, digit, digits, edge, total, wins, count, exitDigit, currency: cur };
                const lim = cfg_ref.current.settings;
                const nextPnl = session_ref.current.pnl + total;
                const willStop =
                    nextPnl <= -Math.abs(Number(lim.stop_loss) || Infinity) ||
                    nextPnl >= Math.abs(Number(lim.take_profit) || Infinity);
                setLastEntry(entry);
                if (auto_ref.current && !willStop) {
                    // Auto mode: no sheet, short pause, then hunt the next entry.
                    auto_timer_ref.current = window.setTimeout(() => {
                        auto_timer_ref.current = null;
                        if (auto_ref.current && mounted_ref.current) startScan();
                    }, AUTO_GAP_MS);
                } else {
                    if (willStop && auto_ref.current) {
                        setAuto(false);
                        auto_ref.current = false;
                    }
                    setResult(entry);
                }
                say(
                    hit
                        ? `HIT on ${code}: digit ${exitDigit ?? '?'} landed in ${list}. +${money(total)} ${cur}`
                        : `Missed on ${code} (landed ${exitDigit ?? '?'}). ${money(total)} ${cur}`
                );
                setPhase('done');
            },
        });
    };

    // ------------------------------------------------------------ scanning
    const runSweep = () => {
        if (!active_ref.current) return;
        sweep_ref.current += 1;
        setSweep(sweep_ref.current);

        const next = {};
        let best = null;
        MARKETS.forEach(m => {
            const r = bestMatch(digits_ref.current[m.code]);
            if (!r) return;
            next[m.code] = r;
            if (!best || r.edge > best.edge) best = { code: m.code, ...r };
        });
        setRows(next);
        setLeader(best);

        if (!best) {
            timer_ref.current = window.setTimeout(runSweep, SWEEP_MS);
            return;
        }

        const a = armed_ref.current;
        if (a) {
            const fresh = (ticks_ref.current[a.code] || 0) - a.at;
            const again = next[a.code];
            if (fresh < CONFIRM_TICKS) {
                timer_ref.current = window.setTimeout(runSweep, 800);
                return;
            }
            if (again && again.digit === a.digit && again.edge >= EDGE_BAR) {
                stopAll();
                armed_ref.current = null;
                setArmed({ ...a, confirmed: true });
                const cover = topDigits(again.scores, cfg_ref.current.settings.cover);
                setArmed({ ...a, confirmed: true, digits: cover });
                say(`Locked: ${a.code} digit ${a.digit} held the bar (${signedPct(again.edge)}).`);
                fire(a.code, cover, again.edge);
                return;
            }
            say(`${a.code} digit ${a.digit} faded. Back to scanning.`);
            armed_ref.current = null;
            setArmed(null);
            setPhase('scanning');
        }

        if (best.edge >= EDGE_BAR) {
            armed_ref.current = { code: best.code, digit: best.digit, at: ticks_ref.current[best.code] || 0 };
            setArmed({ ...armed_ref.current, confirmed: false });
            setPhase('confirming');
            say(`${best.code} digit ${best.digit} cleared the bar (${signedPct(best.edge)}). Confirming…`);
        }
        timer_ref.current = window.setTimeout(runSweep, SWEEP_MS);
    };

    const openSocket = () => {
        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            MARKETS.forEach(m =>
                ws.send(JSON.stringify({ ticks_history: m.code, count: HISTORY, end: 'latest', style: 'ticks', subscribe: 1 }))
            );
        };
        ws.onmessage = ev => {
            if (!active_ref.current) return;
            let d;
            try {
                d = JSON.parse(ev.data);
            } catch {
                return;
            }
            if (d.msg_type === 'active_symbols' && Array.isArray(d.active_symbols)) {
                d.active_symbols.forEach(s => {
                    const c = s.symbol || s.underlying_symbol;
                    if (c && typeof s.pip_size === 'number') decimals_ref.current[c] = s.pip_size;
                    else if (c && typeof s.pip === 'number') decimals_ref.current[c] = `${s.pip}`.split('.')[1]?.length ?? 0;
                });
                return;
            }
            if (d.msg_type === 'history' && d.echo_req?.ticks_history) {
                const c = d.echo_req.ticks_history;
                if (typeof d.pip_size === 'number') decimals_ref.current[c] = d.pip_size;
                const dec = decimals_ref.current[c] ?? 2;
                digits_ref.current[c] = (d.history?.prices || []).map(p => lastDigit(p, dec)).slice(-HISTORY);
                return;
            }
            if (d.msg_type === 'tick' && d.tick?.symbol) {
                const c = d.tick.symbol;
                if (typeof d.tick.pip_size === 'number') decimals_ref.current[c] = d.tick.pip_size;
                const dec = decimals_ref.current[c] ?? 2;
                digits_ref.current[c] = [...(digits_ref.current[c] || []), lastDigit(d.tick.quote, dec)].slice(-HISTORY);
                ticks_ref.current[c] = (ticks_ref.current[c] || 0) + 1;
            }
        };
        ws.onclose = () => {
            if (!active_ref.current || ws_ref.current !== ws) return;
            say('Market stream dropped. Reconnecting…');
            reconnect_ref.current = window.setTimeout(() => {
                if (active_ref.current) openSocket();
            }, 1000);
        };
        ws.onerror = () => {
            /* onclose handles recovery */
        };
    };

    const limitHit = () => {
        const lim = cfg_ref.current.settings;
        const pnl = session_ref.current.pnl;
        if (pnl <= -Math.abs(Number(lim.stop_loss) || Infinity)) return 'loss';
        if (pnl >= Math.abs(Number(lim.take_profit) || Infinity)) return 'profit';
        return null;
    };

    const startScan = () => {
        const hitLimit = limitHit();
        if (hitLimit) {
            setNotice(
                hitLimit === 'loss'
                    ? 'Session stop-loss reached. Reset the session to keep scanning.'
                    : 'Session take-profit reached. Reset the session to keep scanning.'
            );
            setPhase('done');
            return;
        }
        stopAll();
        track_ref.current?.cancel?.();
        track_ref.current = null;
        digits_ref.current = {};
        ticks_ref.current = {};
        armed_ref.current = null;
        sweep_ref.current = 0;
        setRows({});
        setLeader(null);
        setArmed(null);
        setSweep(0);
        setBatch(null);
        setResult(null);
        setNotice('');
        setPhase('scanning');
        active_ref.current = true;
        say(`Scanning ${MARKETS.length} markets for the strongest Matches digit…`);
        openSocket();
        timer_ref.current = window.setTimeout(runSweep, 1200);
    };

    const stopScan = () => {
        if (auto_timer_ref.current) {
            window.clearTimeout(auto_timer_ref.current);
            auto_timer_ref.current = null;
        }
        setAuto(false);
        auto_ref.current = false;
        stopAll();
        armed_ref.current = null;
        setArmed(null);
        setPhase('idle');
        say('Scan stopped.');
    };

    // ------------------------------------------------------------ view
    const stake = Number(settings.stake) || 0;
    const cover = settings.cover;
    const win_amount = stake * (payout - cover);
    const breakeven = cover / payout;
    const odds = React.useMemo(
        () =>
            sessionOdds(
                cover,
                stake,
                payout,
                Math.abs(Number(settings.take_profit) || 0),
                Math.abs(Number(settings.stop_loss) || 0)
            ),
        [cover, stake, payout, settings.take_profit, settings.stop_loss]
    );
    const limit_state =
        session.pnl <= -Math.abs(Number(settings.stop_loss) || Infinity)
            ? 'loss'
            : session.pnl >= Math.abs(Number(settings.take_profit) || Infinity)
              ? 'profit'
              : null;
    const busy = phase === 'firing' || phase === 'settling';
    const scanning = phase === 'scanning' || phase === 'confirming';
    const stepIndex = { idle: -1, scanning: 0, confirming: 1, firing: 2, settling: 2, done: 3 }[phase];
    const focus = armed || (leader ? { code: leader.code, digit: leader.digit } : null);
    const focusScores = focus ? rows[focus.code]?.scores : null;
    const covered = result?.digits || armed?.digits || (focusScores ? topDigits(focusScores, cover) : []);
    const ranked = MARKETS.map(m => ({ ...m, r: rows[m.code] }))
        .filter(m => m.r)
        .sort((a, b) => b.r.edge - a.r.edge);

    const waitingAuto = auto && phase === 'done' && !result && !limit_state;
    const coreLabel = (() => {
        if (phase === 'idle') return { big: 'SCAN', small: 'tap to find an entry' };
        if (phase === 'scanning')
            return {
                big: leader ? leader.digit : '…',
                small: sweep ? `sweep ${sweep} · ${leader?.code || 'loading'}` : 'loading ticks',
            };
        if (phase === 'confirming') return { big: armed?.digit ?? '…', small: `confirming ${armed?.code || ''}` };
        if (phase === 'firing') return { big: batch?.digit ?? '…', small: 'opening contracts' };
        if (phase === 'settling') return { big: batch?.digit ?? '…', small: `settling ${batch?.settled || 0}/${batch?.opened || 0}` };
        if (limit_state) return { big: 'STOP', small: limit_state === 'loss' ? 'stop-loss reached' : 'target reached' };
        if (waitingAuto) return { big: lastEntry ? (lastEntry.total > 0 ? 'HIT' : 'MISS') : '…', small: 'auto · next scan…' };
        return { big: result ? (result.exitDigit ?? result.digit) : (batch?.digit ?? '—'), small: 'tap to scan again' };
    })();

    const onCore = () => {
        if (waitingAuto) {
            stopScan();
            return;
        }
        if (busy || (limit_state && !scanning)) return;
        if (scanning) stopScan();
        else startScan();
    };

    return (
        <div className='mpro'>
            <header className='mpro__head'>
                <div>
                    <div className='mpro__eyebrow'>MATCHES PRO</div>
                    <h1 className='mpro__title'>Digit Hunter</h1>
                    <p className='mpro__lede'>
                        One tap scans every volatility market, confirms the strongest setup, then covers its top digits
                        with Matches contracts on the same tick.
                    </p>
                </div>
                <span className={`mpro__acct ${can_trade ? 'ok' : 'bad'}`}>
                    {!activeLoginid ? 'NOT SIGNED IN' : is_demo ? 'DEMO' : 'REAL · SCAN ONLY'}
                </span>
            </header>

            <section className='mpro__setup' aria-label='Trade settings'>
                <div className='mpro__stepper'>
                    <span className='mpro__label'>Stake per contract</span>
                    <div className='mpro__stepper-row'>
                        <button
                            type='button'
                            disabled={scanning || busy}
                            onClick={() => updateSettings({ stake: Math.max(0.35, Number((stake - 0.5).toFixed(2))) })}
                            aria-label='Lower stake'
                        >
                            −
                        </button>
                        <input
                            type='number'
                            inputMode='decimal'
                            min='0.35'
                            step='0.5'
                            value={settings.stake}
                            disabled={scanning || busy}
                            onChange={e => updateSettings({ stake: e.target.value })}
                            onBlur={e => updateSettings({ stake: Math.max(0.35, Number(e.target.value) || 0.35) })}
                        />
                        <button
                            type='button'
                            disabled={scanning || busy}
                            onClick={() => updateSettings({ stake: Number((stake + 0.5).toFixed(2)) })}
                            aria-label='Raise stake'
                        >
                            +
                        </button>
                    </div>
                </div>
                <div className='mpro__stepper'>
                    <span className='mpro__label'>Digits to cover</span>
                    <div className='mpro__stepper-row'>
                        <button
                            type='button'
                            disabled={scanning || busy || cover <= 1}
                            onClick={() => updateSettings({ cover: cover - 1 })}
                            aria-label='Cover fewer digits'
                        >
                            −
                        </button>
                        <output>{cover}</output>
                        <button
                            type='button'
                            disabled={scanning || busy || cover >= MAX_COVER}
                            onClick={() => updateSettings({ cover: cover + 1 })}
                            aria-label='Cover more digits'
                        >
                            +
                        </button>
                    </div>
                </div>
                <div className='mpro__cover-meter' aria-hidden='true'>
                    {Array.from({ length: 10 }, (_, i) => (
                        <i key={i} className={i < cover ? 'on' : ''} />
                    ))}
                    <span>
                        Hits about <b>{cover * 10}%</b> of entries · one contract on each of the top {cover} digit
                        {cover > 1 ? 's' : ''}
                    </span>
                </div>
                <div className='mpro__payline'>
                    <span>
                        Risk <b>{money(stake * cover)} {currency}</b>
                    </span>
                    <span>
                        If it hits <b className='gold'>+{money(win_amount)} {currency}</b>
                    </span>
                    <span>
                        Break-even <b>{pct(breakeven)}</b> hits
                    </span>
                </div>
                <div className={`mpro__odds ${odds === null ? '' : odds >= 0.45 ? 'good' : odds >= 0.3 ? 'mid' : 'bad'}`}>
                    <span>Chance this session reaches the profit target before the stop-loss</span>
                    <b>{odds === null ? '—' : `${Math.round(odds * 100)}%`}</b>
                </div>
                <div className='mpro__limits'>
                    <label>
                        <span>Stop session at loss</span>
                        <input
                            type='number'
                            inputMode='decimal'
                            min='1'
                            value={settings.stop_loss}
                            disabled={scanning || busy}
                            onChange={e => updateSettings({ stop_loss: e.target.value })}
                        />
                    </label>
                    <label>
                        <span>Stop session at profit</span>
                        <input
                            type='number'
                            inputMode='decimal'
                            min='1'
                            value={settings.take_profit}
                            disabled={scanning || busy}
                            onChange={e => updateSettings({ take_profit: e.target.value })}
                        />
                    </label>
                </div>
                <label className={`mpro__auto ${auto ? 'on' : ''}`}>
                    <input
                        type='checkbox'
                        checked={auto}
                        disabled={!can_trade || Boolean(limit_state)}
                        onChange={e => {
                            const on = e.target.checked;
                            setAuto(on);
                            auto_ref.current = on;
                            if (!on && auto_timer_ref.current) {
                                window.clearTimeout(auto_timer_ref.current);
                                auto_timer_ref.current = null;
                                setPhase('done');
                            }
                        }}
                    />
                    <i />
                    <span>
                        <b>Auto</b> keeps scanning and firing until the stop-loss or profit target ends the session
                    </span>
                </label>
            </section>

            <ol className='mpro__steps'>
                {STEPS.map((s, i) => (
                    <li key={s} className={i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}>
                        <i>{i + 1}</i>
                        {s}
                    </li>
                ))}
            </ol>

            <section className={`mpro__radar mpro__radar--${phase}`}>
                <div className='mpro__ring'>
                    {Array.from({ length: 10 }, (_, d) => {
                        const angle = (d / 10) * Math.PI * 2 - Math.PI / 2;
                        const score = focusScores ? focusScores[d] : null;
                        const heat = score === null ? 0 : Math.max(0, Math.min(1, (score - 0.06) / 0.1));
                        const isPick = covered.includes(d);
                        const isExit = result && result.exitDigit === d;
                        return (
                            <div
                                key={d}
                                className={`mpro__node ${isPick ? 'pick' : ''} ${isExit ? 'exit' : ''}`}
                                style={{
                                    left: `${50 + 41 * Math.cos(angle)}%`,
                                    top: `${50 + 41 * Math.sin(angle)}%`,
                                    '--heat': heat,
                                }}
                            >
                                <b>{d}</b>
                                <small>{score === null ? '' : pct(score)}</small>
                            </div>
                        );
                    })}
                    <button
                        type='button'
                        className='mpro__core'
                        onClick={onCore}
                        disabled={busy}
                        aria-label={scanning ? 'Stop scanning' : 'Start scan'}
                    >
                        <span className='mpro__core-big'>{coreLabel.big}</span>
                        <span className='mpro__core-small'>{coreLabel.small}</span>
                        {scanning && <span className='mpro__core-stop'>tap to stop</span>}
                    </button>
                </div>
                <div className='mpro__focus'>
                    {focus ? (
                        <>
                            <span>{armed ? (armed.confirmed ? 'Locked entry' : 'Confirming') : 'Strongest right now'}</span>
                            <b>
                                {focus.code} · {covered.length > 1 ? `digits ${covered.join(' ')}` : `digit ${focus.digit}`}
                            </b>
                            <small>
                                edge {signedPct(rows[focus.code]?.edge ?? 0)} · bar {signedPct(EDGE_BAR)} · seen{' '}
                                {pct(rows[focus.code]?.hitRate ?? NULL_P)} of last 200
                            </small>
                        </>
                    ) : (
                        <>
                            <span>Ready</span>
                            <b>{MARKETS.length} markets · Digit Match · 1 tick</b>
                            <small>Needs {MIN_TICKS}+ ticks per market before scoring</small>
                        </>
                    )}
                </div>
                {auto && lastEntry && (
                    <div className={`mpro__last-entry ${lastEntry.total > 0 ? 'hit' : 'miss'}`}>
                        Last: {lastEntry.total > 0 ? 'HIT' : 'MISS'} on {lastEntry.code} · landed {lastEntry.exitDigit ?? '?'} ·{' '}
                        {lastEntry.total >= 0 ? '+' : ''}
                        {money(lastEntry.total)} {lastEntry.currency}
                    </div>
                )}
                {notice && <div className='mpro__notice'>{notice}</div>}
            </section>

            <section className='mpro__board' aria-label='Market board'>
                <div className='mpro__board-head'>
                    <span>Market</span>
                    <span>Digit</span>
                    <span>Edge</span>
                    <span>Last 4</span>
                </div>
                {(ranked.length ? ranked : MARKETS.map(m => ({ ...m, r: null }))).map((m, i) => {
                    const r = m.r;
                    const isArmed = armed?.code === m.code;
                    const width = r ? Math.max(4, Math.min(100, (r.edge / (EDGE_BAR * 1.5)) * 100)) : 0;
                    return (
                        <div key={m.code} className={`mpro__row ${i === 0 && r ? 'lead' : ''} ${isArmed ? 'armed' : ''}`}>
                            <span className='mpro__mkt'>
                                <b>{m.code}</b>
                                <small>{m.name}</small>
                            </span>
                            <span className='mpro__digit'>{r ? r.digit : '·'}</span>
                            <span className='mpro__edge'>
                                <span className='mpro__track'>
                                    <i style={{ width: `${width}%` }} className={r && r.edge >= EDGE_BAR ? 'over' : ''} />
                                </span>
                                <em>{r ? signedPct(r.edge) : '—'}</em>
                            </span>
                            <span className='mpro__last'>{r ? r.recent.join(' ') : '— — — —'}</span>
                        </div>
                    );
                })}
            </section>

            <section className='mpro__bottom'>
                <div className='mpro__session'>
                    <div>
                        <span>Entries</span>
                        <b>{session.batches}</b>
                    </div>
                    <div>
                        <span>Hits</span>
                        <b>{session.hits}</b>
                    </div>
                    <div className={limit_state ? `limit ${limit_state}` : ''}>
                        <span>Session P/L</span>
                        <b className={session.pnl >= 0 ? 'pos' : 'neg'}>
                            {session.pnl >= 0 ? '+' : ''}
                            {money(session.pnl)}
                        </b>
                    </div>
                </div>
                {(session.batches > 0 || limit_state) && (
                    <button
                        type='button'
                        className='mpro__reset'
                        disabled={scanning || busy}
                        onClick={() => {
                            setSession({ batches: 0, hits: 0, pnl: 0 });
                            setNotice('');
                            setResult(null);
                            setPhase('idle');
                            say('Session reset.');
                        }}
                    >
                        {limit_state ? 'Session stopped · reset to continue' : 'Reset session'}
                    </button>
                )}
                <ul className='mpro__feed'>
                    {feed.length ? (
                        feed.map(f => <li key={f.t}>{f.line}</li>)
                    ) : (
                        <li className='muted'>Activity shows here once you scan.</li>
                    )}
                </ul>
                <p className='mpro__fine'>
                    Demo accounts only. Each covered digit adds about 10% hit chance, but each hit pays less and Deriv&apos;s
                    margin stays: on 130,000 real ticks every cover setting lost about 10% of what was risked over time.
                    Winning more entries is not the same as finishing more sessions in profit. With a +10 / −20 session,
                    covering 3 digits reached the target 48% of the time, 8 digits only 15%. Use the session chance above to
                    compare settings.
                </p>
            </section>

            {result && (
                <div className='mpro__sheet-wrap' role='dialog' aria-modal='true' onClick={() => setResult(null)}>
                    <div className={`mpro__sheet ${result.total > 0 ? 'hit' : 'miss'}`} onClick={e => e.stopPropagation()}>
                        <div className='mpro__sheet-tag'>{result.total > 0 ? 'HIT' : 'MISSED'}</div>
                        <div className='mpro__sheet-amt'>
                            {result.total >= 0 ? '+' : ''}
                            {money(result.total)} <small>{result.currency}</small>
                        </div>
                        <div className='mpro__sheet-digits'>
                            <div>
                                <span>Covered</span>
                                <b className={result.digits.length > 2 ? 'sm' : ''}>{result.digits.join(' ')}</b>
                            </div>
                            <div>
                                <span>Landed</span>
                                <b>{result.exitDigit ?? '?'}</b>
                            </div>
                            <div>
                                <span>Market</span>
                                <b className='sm'>{result.code}</b>
                            </div>
                        </div>
                        <div className='mpro__sheet-sub'>
                            {result.wins}/{result.count} contracts won
                            {limit_state && (
                                <strong className='mpro__sheet-stop'>
                                    {limit_state === 'loss'
                                        ? ' · Session stop-loss reached'
                                        : ' · Session profit target reached'}
                                </strong>
                            )}
                        </div>
                        <div className='mpro__sheet-actions'>
                            <button type='button' className='ghost' onClick={() => setResult(null)}>
                                Close
                            </button>
                            <button
                                type='button'
                                disabled={Boolean(limit_state)}
                                onClick={() => {
                                    setResult(null);
                                    startScan();
                                }}
                            >
                                {limit_state ? 'Session stopped' : 'Scan again'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const MatchesProPage = () => (
    <PageBoundary name='Matches Pro'>
        <MatchesPro />
    </PageBoundary>
);

export default MatchesProPage;
