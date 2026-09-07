// @ts-nocheck -- Deriv trade history store.
//
// Pulls the account's closed trades from profit_table, normalises them, and
// keeps them locally so the analysis can run instantly on later visits instead
// of re-downloading everything.
//
// Sync is incremental: after the first pull we only ask for trades newer than
// the newest one we already hold.
//
// Rows are stored as fixed-order arrays rather than objects. At a few thousand
// trades the key names would otherwise be most of the payload.

import { api_base } from '@/external/bot-skeleton';

const KEY = loginid => `nlb_history_v1_${loginid}`;
const PAGE = 500; // profit_table maximum per request
const MAX_PAGES = 12; // 6000 trades is plenty for personal analysis
const MAX_ROWS = 6000;
const PAGE_DELAY_MS = 350; // stay well clear of the API rate limit

const sleep = ms => new Promise(r => setTimeout(r, ms));

// [purchase_time, sell_time, symbol, contract_type, buy_price, sell_price, contract_id]
const IDX = { BUY_T: 0, SELL_T: 1, SYMBOL: 2, TYPE: 3, BUY: 4, SELL: 5, ID: 6 };

export const rowOf = r => ({
    buy_time: r[IDX.BUY_T],
    sell_time: r[IDX.SELL_T],
    symbol: r[IDX.SYMBOL],
    type: r[IDX.TYPE],
    buy: r[IDX.BUY],
    sell: r[IDX.SELL],
    id: r[IDX.ID],
    profit: Number((r[IDX.SELL] - r[IDX.BUY]).toFixed(4)),
    duration: r[IDX.SELL_T] && r[IDX.BUY_T] ? r[IDX.SELL_T] - r[IDX.BUY_T] : null,
});

// Shortcodes look like DIGITMATCH_R_100_9.3_... or CALL_R_50_19.53_...
// contract_type is present on newer responses; fall back to the shortcode.
const typeOf = tx => {
    if (tx.contract_type) return tx.contract_type;
    const code = tx.shortcode || '';
    const first = code.split('_')[0];
    return first || 'UNKNOWN';
};

const symbolOf = tx => {
    if (tx.underlying_symbol) return tx.underlying_symbol;
    if (tx.symbol) return tx.symbol;
    const parts = (tx.shortcode || '').split('_');
    // DIGITMATCH_R_100_... -> R_100 ; CALL_1HZ100V_... -> 1HZ100V
    if (parts.length >= 3 && parts[1] === 'R') return `${parts[1]}_${parts[2]}`;
    return parts[1] || 'UNKNOWN';
};

const normalise = tx => [
    Number(tx.purchase_time) || 0,
    Number(tx.sell_time) || 0,
    symbolOf(tx),
    typeOf(tx),
    Number(tx.buy_price) || 0,
    Number(tx.sell_price) || 0,
    String(tx.contract_id || tx.transaction_id || ''),
];

const empty = () => ({ rows: [], synced_at: null, newest: 0, truncated: false });

export const load = loginid => {
    try {
        const raw = window.localStorage.getItem(KEY(loginid));
        if (!raw) return empty();
        return { ...empty(), ...JSON.parse(raw) };
    } catch {
        return empty();
    }
};

const save = (loginid, state) => {
    try {
        window.localStorage.setItem(KEY(loginid), JSON.stringify(state));
        return true;
    } catch {
        return false; // quota - the data still works for this session
    }
};

export const clear = loginid => {
    try {
        window.localStorage.removeItem(KEY(loginid));
    } catch {
        /* noop */
    }
    return empty();
};

/**
 * Fetch trades from Deriv and merge them into the stored set.
 *
 * sync(loginid, { onProgress, full })
 *   full: ignore the incremental cursor and re-pull everything
 *
 * Returns the merged state. Throws with a readable message on API failure.
 */
export const sync = async (loginid, options = {}) => {
    const { onProgress, full = false } = options;
    const existing = full ? empty() : load(loginid);
    const seen = new Set(existing.rows.map(r => r[IDX.ID]));
    const collected = [];

    let offset = 0;
    let pages = 0;

    while (pages < MAX_PAGES) {
        const request = {
            profit_table: 1,
            description: 1,
            limit: PAGE,
            offset,
            sort: 'DESC',
        };
        // Incremental: only ask for trades bought after the newest one held.
        if (!full && existing.newest) request.date_from = existing.newest;

        const response = await api_base.api.send(request);
        const transactions = response?.profit_table?.transactions || [];
        if (!transactions.length) break;

        let fresh = 0;
        transactions.forEach(tx => {
            const row = normalise(tx);
            if (!row[IDX.ID] || seen.has(row[IDX.ID])) return;
            seen.add(row[IDX.ID]);
            collected.push(row);
            fresh += 1;
        });

        pages += 1;
        offset += transactions.length;
        onProgress?.({ pages, fetched: offset, added: collected.length });

        // A short page means we reached the end of the account's history.
        if (transactions.length < PAGE) break;
        // Every row on this page was already stored - nothing older to find.
        if (!fresh && !full) break;

        await sleep(PAGE_DELAY_MS);
    }

    const merged = [...collected, ...existing.rows].sort((a, b) => b[IDX.BUY_T] - a[IDX.BUY_T]);
    const truncated = merged.length > MAX_ROWS;
    const rows = truncated ? merged.slice(0, MAX_ROWS) : merged;

    const state = {
        rows,
        synced_at: Date.now(),
        newest: rows.length ? rows[0][IDX.BUY_T] : existing.newest,
        truncated: truncated || existing.truncated,
    };

    const stored = save(loginid, state);
    return { ...state, stored, added: collected.length };
};

/** Headline figures, enough to prove the pipeline before the analysis lands. */
export const overview = state => {
    const rows = state.rows || [];
    if (!rows.length) return { n: 0 };

    let profit = 0;
    let staked = 0;
    let wins = 0;
    const symbols = new Set();
    const types = new Set();

    rows.forEach(r => {
        const t = rowOf(r);
        profit += t.profit;
        staked += t.buy;
        if (t.profit > 0) wins += 1;
        symbols.add(t.symbol);
        types.add(t.type);
    });

    const oldest = rows[rows.length - 1][IDX.BUY_T];
    const newest = rows[0][IDX.BUY_T];

    return {
        n: rows.length,
        profit: Number(profit.toFixed(2)),
        staked: Number(staked.toFixed(2)),
        wins,
        losses: rows.length - wins,
        win_rate: rows.length ? wins / rows.length : 0,
        // What the account actually paid to trade, as a share of everything staked.
        cost_rate: staked ? -profit / staked : 0,
        symbols: [...symbols],
        types: [...types],
        oldest,
        newest,
        days: oldest && newest ? Math.max(1, Math.round((newest - oldest) / 86400)) : 1,
    };
};