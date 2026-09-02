// @ts-nocheck -- Matches Pro risk guard.
//
// Every condition that must hold before an order can be sent lives here, in one
// place, as data. The UI cannot bypass it: the execution path calls evaluate()
// and refuses to proceed on anything other than an explicit allow.
//
// Two of these gates are deliberate hard stops rather than warnings:
//   * demo only  - a real login id is refused outright in this phase
//   * evidence   - no auto-trading on a market until its backtest has enough
//                  graded predictions to say anything at all

import { isDemoAccount } from '@/utils/account-helpers';

const LIMITS_KEY = 'nlb_matches_limits_v1';
const DAY_KEY = symbol => `nlb_matches_day_v1_${symbol}`;

// Minimum graded predictions before auto-trading unlocks on a market.
export const MIN_EVIDENCE = 500;

// Signal qualities allowed to trade. WEAK and NO SIGNAL never trade.
export const TRADEABLE = ['STRONG', 'MEDIUM'];

export const DEFAULT_LIMITS = {
    stake: 0.35,
    max_trades: 20,
    max_consecutive_losses: 3,
    daily_profit_target: 10,
    daily_loss_limit: 5,
    cooldown_ticks: 3,
    max_open: 1,
};

const today = () => new Date().toISOString().slice(0, 10);

export const loadLimits = () => {
    try {
        const raw = window.localStorage.getItem(LIMITS_KEY);
        return raw ? { ...DEFAULT_LIMITS, ...JSON.parse(raw) } : { ...DEFAULT_LIMITS };
    } catch {
        return { ...DEFAULT_LIMITS };
    }
};

export const saveLimits = limits => {
    try {
        window.localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
    } catch {
        /* noop */
    }
};

const emptyDay = () => ({ date: today(), trades: [], pl: 0, consecutive_losses: 0, wins: 0, losses: 0 });

export const loadDay = symbol => {
    try {
        const raw = window.localStorage.getItem(DAY_KEY(symbol));
        if (!raw) return emptyDay();
        const parsed = JSON.parse(raw);
        // A new day wipes the counters. Yesterday's loss limit does not carry.
        if (parsed.date !== today()) return emptyDay();
        return { ...emptyDay(), ...parsed };
    } catch {
        return emptyDay();
    }
};

const saveDay = (symbol, day) => {
    try {
        window.localStorage.setItem(DAY_KEY(symbol), JSON.stringify(day));
    } catch {
        /* noop */
    }
};

export const resetDay = symbol => {
    const day = emptyDay();
    saveDay(symbol, day);
    return day;
};

export const recordTrade = (symbol, trade) => {
    const day = loadDay(symbol);
    const won = Number(trade.profit) > 0;

    day.trades.unshift(trade);
    if (day.trades.length > 200) day.trades = day.trades.slice(0, 200);
    day.pl = Number((day.pl + Number(trade.profit || 0)).toFixed(4));
    if (won) {
        day.wins += 1;
        day.consecutive_losses = 0;
    } else {
        day.losses += 1;
        day.consecutive_losses += 1;
    }
    saveDay(symbol, day);
    return day;
};

/**
 * The pre-trade gate. Returns { allowed, reason }.
 * Called immediately before every proposal request - never cached.
 */
export const evaluate = ctx => {
    const { limits, day, quality, is_authorized, loginid, open_count, cooldown_remaining, evidence, auto_on } = ctx;

    if (!auto_on) return { allowed: false, reason: 'Auto trade is off' };
    if (!is_authorized) return { allowed: false, reason: 'Not signed in to Deriv' };
    if (!loginid) return { allowed: false, reason: 'No account selected' };

    // Hard stop. Phase 3 is demo only, enforced here rather than in the UI.
    if (!isDemoAccount(loginid)) {
        return { allowed: false, reason: `Real account ${loginid} - demo only in this phase` };
    }

    if (evidence < MIN_EVIDENCE) {
        return {
            allowed: false,
            reason: `Only ${evidence} graded predictions on this market. Needs ${MIN_EVIDENCE} before auto trading unlocks.`,
        };
    }

    if (!TRADEABLE.includes(quality)) return { allowed: false, reason: `Signal is ${quality}` };

    if (open_count >= limits.max_open) return { allowed: false, reason: 'A contract is still open' };
    if (cooldown_remaining > 0) return { allowed: false, reason: `Cooldown: ${cooldown_remaining} ticks` };

    if (day.trades.length >= limits.max_trades) {
        return { allowed: false, reason: `Max trades reached (${limits.max_trades})` };
    }
    if (day.consecutive_losses >= limits.max_consecutive_losses) {
        return {
            allowed: false,
            reason: `${day.consecutive_losses} losses in a row - stopped at limit of ${limits.max_consecutive_losses}`,
        };
    }
    if (day.pl <= -Math.abs(limits.daily_loss_limit)) {
        return { allowed: false, reason: `Daily loss limit hit (${day.pl.toFixed(2)})` };
    }
    if (day.pl >= Math.abs(limits.daily_profit_target)) {
        return { allowed: false, reason: `Daily profit target reached (${day.pl.toFixed(2)})` };
    }

    if (!(Number(limits.stake) > 0)) return { allowed: false, reason: 'Stake must be greater than zero' };

    return { allowed: true, reason: 'All checks passed' };
};