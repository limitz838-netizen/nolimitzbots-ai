// @ts-nocheck -- My Performance (step 1: history sync).
//
// This step only proves the data layer: pull the account's closed trades from
// Deriv, store them, and show enough to confirm the numbers are real. The
// breakdowns by market, hour, stake and streak come next.
import React from 'react';
import { useApiBase } from '@/hooks/useApiBase';
import { clear, load, overview, rowOf, sync } from '@/components/shared/nlb/history-store';
import './my-performance.scss';

const money = (v, currency) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)} ${currency}`;
const dateOf = epoch => (epoch ? new Date(epoch * 1000).toLocaleString('en-GB') : '-');

const MyPerformance = () => {
    const { isAuthorized, accountList, activeLoginid } = useApiBase();

    const [state, setState] = React.useState(() => load(activeLoginid || 'none'));
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [error, setError] = React.useState('');

    const currency = React.useMemo(() => {
        const acc = (accountList || []).find(a => a.loginid === activeLoginid);
        return acc?.currency || 'USD';
    }, [accountList, activeLoginid]);

    React.useEffect(() => {
        setState(load(activeLoginid || 'none'));
        setError('');
        setProgress(null);
    }, [activeLoginid]);

    const run = async full => {
        if (!activeLoginid || busy) return;
        setBusy(true);
        setError('');
        setProgress({ pages: 0, fetched: 0, added: 0 });
        try {
            const next = await sync(activeLoginid, { full, onProgress: setProgress });
            setState(next);
            if (next.stored === false) {
                setError('Loaded, but browser storage is full so this will not persist. Try a full resync later.');
            }
        } catch (e) {
            setError(e?.message || 'Could not reach Deriv. Check your connection and try again.');
        } finally {
            setBusy(false);
        }
    };

    const stats = React.useMemo(() => overview(state), [state]);
    const recent = React.useMemo(() => (state.rows || []).slice(0, 20).map(rowOf), [state]);

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
                            Your own closed trades from Deriv, stored on this device.
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
                        Nothing loaded yet. Press Load my history - the first pull can take up to a minute on an active
                        account, then future syncs only fetch what is new.
                    </div>
                )}

                {stats.n > 0 && (
                    <>
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
                            Across {stats.n} trades you staked {stats.staked.toFixed(2)} {currency} and kept{' '}
                            {money(stats.profit, currency)}. That is{' '}
                            <strong>{(stats.cost_rate * 100).toFixed(2)}%</strong> of everything you staked, spanning{' '}
                            {stats.days} day{stats.days === 1 ? '' : 's'}, across {stats.symbols.length} market
                            {stats.symbols.length === 1 ? '' : 's'} and {stats.types.length} contract type
                            {stats.types.length === 1 ? '' : 's'}.
                        </div>

                        <div className='my-performance__meta'>
                            Oldest {dateOf(stats.oldest)} &middot; newest {dateOf(stats.newest)} &middot; last synced{' '}
                            {state.synced_at ? new Date(state.synced_at).toLocaleString('en-GB') : 'never'}
                            {state.truncated ? ' - older trades beyond the storage cap were dropped' : ''}
                        </div>

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
                                    <span>{t.profit >= 0 ? '+' : ''}{t.profit.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                <div className='my-performance__note'>
                    This data stays on this device - it is read from your Deriv account and written to your browser,
                    not to any server. Deleting it here removes the local copy only; your Deriv records are untouched.
                </div>
            </div>
        </div>
    );
};

export default MyPerformance;