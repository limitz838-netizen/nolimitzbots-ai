// @ts-nocheck -- My Performance (step 2: analysis).
//
// Everything on this page describes trades that already happened. There is no
// prediction and no recommendation dressed up as one.
import React from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { clear, load, overview, rowOf, sync } from '@/components/shared/nlb/history-store';
import {
    afterLosses,
    byHour,
    byMarket,
    byStake,
    byType,
    byWeekday,
    decode,
    headline,
    pace,
} from '@/components/shared/nlb/history-analytics';
import './my-performance.scss';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = [
    { key: 'market', label: 'Market' },
    { key: 'type', label: 'Contract' },
    { key: 'stake', label: 'Stake size' },
    { key: 'hour', label: 'Hour of day' },
    { key: 'weekday', label: 'Day of week' },
];

const money = (v, currency) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)} ${currency}`;
const dateOf = epoch => (epoch ? new Date(epoch * 1000).toLocaleString('en-GB') : '-');

const MyPerformance = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();

    const [state, setState] = React.useState(() => load(activeLoginid || 'none'));
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [error, setError] = React.useState('');
    const [view, setView] = React.useState('market');
    const [balance, setBalance] = React.useState(0);

    const account = React.useMemo(
        () => (accountList || []).find(a => a.loginid === activeLoginid),
        [accountList, activeLoginid]
    );
    const currency = account?.currency || 'USD';

    React.useEffect(() => {
        setState(load(activeLoginid || 'none'));
        setError('');
        setProgress(null);
    }, [activeLoginid]);

    React.useEffect(() => {
        const b = Number(account?.balance);
        if (b > 0) setBalance(b);
    }, [account]);

    const run = async full => {
        if (!activeLoginid || busy) return;
        setBusy(true);
        setError('');
        setProgress({ pages: 0, fetched: 0, added: 0 });
        try {
            const next = await sync(activeLoginid, { full, onProgress: setProgress });
            setState(next);
            if (next.stored === false) {
                setError('Loaded, but browser storage is full so this will not persist.');
            }
        } catch (e) {
            setError(e?.message || 'Could not reach Deriv. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const stats = React.useMemo(() => overview(state), [state]);
    const trades = React.useMemo(() => decode(state), [state]);
    const paceStats = React.useMemo(() => pace(trades, Number(balance) || 0), [trades, balance]);
    const chase = React.useMemo(() => afterLosses(trades), [trades]);
    const lede = React.useMemo(() => headline(trades, paceStats), [trades, paceStats]);
    const recent = React.useMemo(() => (state.rows || []).slice(0, 15).map(rowOf), [state]);

    const groups = React.useMemo(() => {
        if (!trades.length) return [];
        if (view === 'market') return byMarket(trades);
        if (view === 'type') return byType(trades);
        if (view === 'stake') return byStake(trades);
        if (view === 'hour') return byHour(trades).map(g => ({ ...g, key: `${String(g.key).padStart(2, '0')}:00` }));
        return byWeekday(trades).map(g => ({ ...g, key: DAY_NAMES[g.key] }));
    }, [trades, view]);

    const worst = Math.max(1, ...groups.map(g => Math.abs(g.profit)));

    if (!isAuthorized) {
        return (
            <div className='my-performance'>
                <div className='my-performance__panel'>
                    <div className='my-performance__title'>MY PERFORMANCE</div>
                    <div className='my-performance__note'>Sign in to your Deriv account to load your trade history.</div>
                </div>
            </div>
        );
    }

    return (
        <div className='my-performance'>
            <div className='my-performance__panel'>
                <div className='my-performance__head'>
                    <div>
                        <div className='my-performance__title'>MY PERFORMANCE</div>
                        <div className='my-performance__subtitle'>
                            Your own closed trades from Deriv, analysed on this device.
                        </div>
                    </div>
                    <div className='my-performance__account'>{activeLoginid}</div>
                </div>

                {error && <div className='my-performance__warn'>{error}</div>}

                <div className='my-performance__actions'>
                    <button type='button' className='my-performance__primary' disabled={busy} onClick={() => run(false)}>
                        {busy ? 'Loading...' : state.synced_at ? 'Sync new trades' : 'Load my history'}
                    </button>
                    <button type='button' className='my-performance__link' disabled={busy} onClick={() => run(true)}>
                        Full resync
                    </button>
                    <button
                        type='button'
                        className='my-performance__link'
                        disabled={busy}
                        onClick={() => setState(clear(activeLoginid))}
                    >
                        Delete stored data
                    </button>
                </div>

                {busy && progress && (
                    <div className='my-performance__progress'>
                        Page {progress.pages}, {progress.fetched} trades scanned, {progress.added} new
                    </div>
                )}

                {stats.n === 0 && !busy && (
                    <div className='my-performance__note'>
                        Nothing loaded yet. Press Load my history - the first pull can take up to a minute, then future
                        syncs only fetch what is new.
                    </div>
                )}

                {stats.n > 0 && (
                    <>
                        {lede && <div className='my-performance__lede'>{lede}</div>}

                        <div className='my-performance__readout'>
                            <div className='my-performance__stat'>
                                <span>Trades</span>
                                <strong>{stats.n}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Win rate</span>
                                <strong>{(stats.win_rate * 100).toFixed(1)}%</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Total staked</span>
                                <strong>
                                    {stats.staked.toFixed(2)} {currency}
                                </strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Net profit / loss</span>
                                <strong className={stats.profit >= 0 ? 'pos' : 'neg'}>
                                    {money(stats.profit, currency)}
                                </strong>
                            </div>
                        </div>

                        <div className='my-performance__headline'>
                            You staked {stats.staked.toFixed(2)} {currency} across {stats.n} trades and kept{' '}
                            {money(stats.profit, currency)}. That is{' '}
                            <strong>{(stats.cost_rate * 100).toFixed(2)}%</strong> of everything you staked, over{' '}
                            {stats.days} day{stats.days === 1 ? '' : 's'}.
                        </div>

                        <div className='my-performance__meta'>
                            Oldest {dateOf(stats.oldest)} &middot; newest {dateOf(stats.newest)} &middot; synced{' '}
                            {state.synced_at ? new Date(state.synced_at).toLocaleString('en-GB') : 'never'}
                            {state.truncated ? ' - older trades beyond the storage cap were dropped' : ''}
                        </div>

                        {/* ------------------------------- pace ------------------------------- */}
                        <div className='my-performance__section-title'>What your pace costs</div>
                        <div className='my-performance__readout'>
                            <div className='my-performance__stat'>
                                <span>Cost per hour</span>
                                <strong className={paceStats.cost_per_hour > 0 ? 'neg' : 'pos'}>
                                    {paceStats.cost_per_hour.toFixed(2)} {currency}
                                </strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Trades per hour</span>
                                <strong>{paceStats.trades_per_hour}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Sessions</span>
                                <strong>{paceStats.sessions}</strong>
                            </div>
                            <div className='my-performance__stat'>
                                <span>Avg session</span>
                                <strong>{paceStats.avg_session_minutes} min</strong>
                            </div>
                        </div>

                        <div className='my-performance__balance'>
                            <label className='my-performance__field'>
                                <span>Balance to project from</span>
                                <input
                                    type='number'
                                    min='0'
                                    step='1'
                                    value={balance}
                                    onChange={e => setBalance(Number(e.target.value) || 0)}
                                />
                            </label>
                            <div className='my-performance__projection'>
                                {paceStats.hours_left === null ? (
                                    <>Enter a balance to see how long it lasts at this rate.</>
                                ) : (
                                    <>
                                        At {paceStats.cost_per_hour.toFixed(2)} {currency} an hour, a balance of{' '}
                                        {Number(balance).toFixed(2)} lasts about{' '}
                                        <strong>{paceStats.hours_left} hours</strong> of screen time - roughly{' '}
                                        {Math.max(1, Math.round(paceStats.hours_left / (paceStats.avg_session_minutes / 60 || 1)))}{' '}
                                        more sessions at your usual length. Halving your trades per hour roughly
                                        doubles that.
                                    </>
                                )}
                            </div>
                        </div>

                        {/* --------------------------- after losses --------------------------- */}
                        <div className='my-performance__section-title'>What you do after losses</div>
                        <div className='my-performance__table'>
                            <div className='my-performance__row head five'>
                                <span>Losses before</span>
                                <span>Trades</span>
                                <span>Avg stake</span>
                                <span>Win rate</span>
                                <span>P/L</span>
                            </div>
                            {chase.map(b => (
                                <div key={b.key} className={`my-performance__row five ${b.profit >= 0 ? 'win' : 'loss'}`}>
                                    <span>{b.key}</span>
                                    <span>{b.n}</span>
                                    <span>
                                        {b.avg_stake.toFixed(2)}
                                        {b.stake_ratio > 1.1 ? ` (${b.stake_ratio.toFixed(1)}x)` : ''}
                                    </span>
                                    <span>{(b.win_rate * 100).toFixed(1)}%</span>
                                    <span>
                                        {b.profit >= 0 ? '+' : ''}
                                        {b.profit.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className='my-performance__note-inline'>
                            Win rate should be roughly the same across every row - the market has no memory of your
                            losing run. If the stake column climbs, that is you, and it is the one thing on this page
                            you can change today.
                        </div>

                        {/* ---------------------------- breakdowns ---------------------------- */}
                        <div className='my-performance__section-title'>Breakdown</div>
                        <div className='my-performance__tabs'>
                            {VIEWS.map(v => (
                                <button
                                    key={v.key}
                                    type='button'
                                    className={`my-performance__tab ${view === v.key ? 'on' : ''}`}
                                    onClick={() => setView(v.key)}
                                >
                                    {v.label}
                                </button>
                            ))}
                        </div>
                        <div className='my-performance__bars'>
                            {groups.map(g => (
                                <div key={g.key} className='my-performance__bar-row'>
                                    <span className='my-performance__bar-label'>{g.key}</span>
                                    <span className='my-performance__bar-track'>
                                        <span
                                            className={g.profit >= 0 ? 'pos' : 'neg'}
                                            style={{ width: `${(Math.abs(g.profit) / worst) * 100}%` }}
                                        />
                                    </span>
                                    <span className='my-performance__bar-value'>
                                        <strong className={g.profit >= 0 ? 'pos' : 'neg'}>
                                            {g.profit >= 0 ? '+' : ''}
                                            {g.profit.toFixed(2)}
                                        </strong>
                                        <em>
                                            {g.n} trades, {(g.win_rate * 100).toFixed(0)}% win
                                        </em>
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* ------------------------------ recent ------------------------------ */}
                        <div className='my-performance__section-title'>Most recent trades</div>
                        <div className='my-performance__table'>
                            <div className='my-performance__row head'>
                                <span>Bought</span>
                                <span>Market</span>
                                <span>Type</span>
                                <span>Stake</span>
                                <span>P/L</span>
                            </div>
                            {recent.map(t => (
                                <div key={t.id} className={`my-performance__row ${t.profit > 0 ? 'win' : 'loss'}`}>
                                    <span>{dateOf(t.buy_time)}</span>
                                    <span>{t.symbol}</span>
                                    <span>{t.type}</span>
                                    <span>{t.buy.toFixed(2)}</span>
                                    <span>
                                        {t.profit >= 0 ? '+' : ''}
                                        {t.profit.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                <div className='my-performance__note'>
                    This data stays on this device - read from your Deriv account, written to your browser, never to a
                    server. Deleting it here removes the local copy only.
                </div>
            </div>
        </div>
    );
};

export default MyPerformance;