// @ts-nocheck -- Analysis over the stored trade history.
//
// Nothing here predicts anything. Every number is a description of what the
// account already did, cut in ways Deriv's own reports do not offer.
//
// The two that matter most:
//   * cost per hour - what trading at this pace actually costs, which turns an
//     abstract loss into a rate the user can compare against their income
//   * behaviour after losses - almost every losing account raises its stake
//     after a losing run, and almost nobody knows they do it

import { rowOf } from './history-store';

const SESSION_GAP_S = 30 * 60; // a half-hour gap starts a new session

const summariseGroup = trades => {
    let profit = 0;
    let staked = 0;
    let wins = 0;
    trades.forEach(t => {
        profit += t.profit;
        staked += t.buy;
        if (t.profit > 0) wins += 1;
    });
    return {
        n: trades.length,
        profit: Number(profit.toFixed(2)),
        staked: Number(staked.toFixed(2)),
        wins,
        win_rate: trades.length ? wins / trades.length : 0,
        avg_stake: trades.length ? staked / trades.length : 0,
        cost_rate: staked ? -profit / staked : 0,
    };
};

export const decode = state => (state.rows || []).map(rowOf).sort((a, b) => a.buy_time - b.buy_time);

const groupBy = (trades, keyFn) => {
    const buckets = new Map();
    trades.forEach(t => {
        const k = keyFn(t);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(t);
    });
    return [...buckets.entries()]
        .map(([key, rows]) => ({ key, ...summariseGroup(rows) }))
        .sort((a, b) => b.n - a.n);
};

export const byMarket = trades => groupBy(trades, t => t.symbol);
export const byType = trades => groupBy(trades, t => t.type);
export const byWeekday = trades =>
    groupBy(trades, t => new Date(t.buy_time * 1000).getDay()).sort((a, b) => a.key - b.key);
export const byHour = trades =>
    groupBy(trades, t => new Date(t.buy_time * 1000).getHours()).sort((a, b) => a.key - b.key);

export const byStake = trades =>
    groupBy(trades, t => {
        const s = t.buy;
        if (s < 1) return 'under 1';
        if (s < 2) return '1 to 2';
        if (s < 5) return '2 to 5';
        if (s < 10) return '5 to 10';
        if (s < 25) return '10 to 25';
        return '25 and up';
    });

/** Split the trade list into sessions separated by a gap of inactivity. */
export const sessions = trades => {
    const out = [];
    let current = null;
    trades.forEach(t => {
        if (!current || t.buy_time - current.end > SESSION_GAP_S) {
            current = { start: t.buy_time, end: t.buy_time, trades: [t] };
            out.push(current);
        } else {
            current.end = t.buy_time;
            current.trades.push(t);
        }
    });
    return out.map(s => ({
        start: s.start,
        end: s.end,
        // A single-trade session still consumed real time; floor it at a minute.
        seconds: Math.max(60, s.end - s.start),
        ...summariseGroup(s.trades),
    }));
};

/**
 * What this account's trading costs per hour of actual screen time, and how
 * long a given balance survives at that rate.
 */
export const pace = (trades, balance) => {
    const list = sessions(trades);
    const seconds = list.reduce((sum, s) => sum + s.seconds, 0);
    const hours = seconds / 3600;
    const totals = summariseGroup(trades);

    const trades_per_hour = hours ? trades.length / hours : 0;
    const cost_per_hour = hours ? -totals.profit / hours : 0;
    const hours_left = cost_per_hour > 0 && balance > 0 ? balance / cost_per_hour : null;

    return {
        sessions: list.length,
        hours: Number(hours.toFixed(2)),
        trades_per_hour: Number(trades_per_hour.toFixed(1)),
        cost_per_hour: Number(cost_per_hour.toFixed(2)),
        hours_left: hours_left === null ? null : Number(hours_left.toFixed(1)),
        avg_session_minutes: list.length ? Math.round(seconds / list.length / 60) : 0,
        longest_session_minutes: list.length ? Math.round(Math.max(...list.map(s => s.seconds)) / 60) : 0,
    };
};

/**
 * Group every trade by how many losses came immediately before it. The stake
 * column is the point: if it climbs with the loss count, the account is
 * chasing, and that is a behaviour the user can change today.
 */
export const afterLosses = trades => {
    const buckets = { 0: [], 1: [], 2: [], '3+': [] };
    let run = 0;
    trades.forEach(t => {
        const key = run === 0 ? 0 : run === 1 ? 1 : run === 2 ? 2 : '3+';
        buckets[key].push(t);
        run = t.profit > 0 ? 0 : run + 1;
    });

    const base = summariseGroup(buckets[0]);
    return Object.entries(buckets).map(([key, rows]) => {
        const s = summariseGroup(rows);
        return {
            key,
            ...s,
            // How much bigger the stake is than after a win, as a multiple.
            stake_ratio: base.avg_stake && s.avg_stake ? s.avg_stake / base.avg_stake : 1,
        };
    });
};

/** The single sentence worth putting at the top of the page. */
export const headline = (trades, paceStats) => {
    const chase = afterLosses(trades).find(b => b.key === '3+');
    const totals = summariseGroup(trades);

    const parts = [];
    if (paceStats.cost_per_hour > 0) {
        parts.push(`Trading at this pace costs about ${paceStats.cost_per_hour.toFixed(2)} an hour.`);
    } else if (totals.profit > 0) {
        parts.push(`You are up ${totals.profit.toFixed(2)} over this history, which is unusual - check it is not one large win carrying everything.`);
    }
    if (chase && chase.n >= 20 && chase.stake_ratio > 1.25) {
        parts.push(
            `After three or more losses in a row your average stake is ${chase.stake_ratio.toFixed(1)}x bigger than after a win, across ${chase.n} trades.`
        );
    }
    return parts.join(' ');
};