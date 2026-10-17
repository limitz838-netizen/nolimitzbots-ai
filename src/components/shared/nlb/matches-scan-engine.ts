// @ts-nocheck — Matches Pro scanner engine (pure functions, no imports).
//
// For every market it scores all ten digits and keeps the strongest one:
//   score = 40% share in the last 60 ticks
//         + 35% share in the last 200 ticks
//         + 25% "what followed the current last digit" over the last 1000 ticks
//           (shrunk toward 10% so a thin sample cannot dominate)
//   edge  = score - 10%   (10% is the fair chance of any digit)
//
// A market+digit "arms" when its edge clears EDGE_BAR and must still clear it on
// the next sweep after fresh ticks before anything is bought.
//
// Honest note: tested on 100k+ real Deriv ticks, no digit score beats ~10%.
// The scan decides WHEN and WHERE to trade; it does not change the odds.

export const NULL_P = 0.1;
export const MIN_TICKS = 300;
export const HISTORY = 1000;
export const EDGE_BAR = 0.06; // calibrated on real ticks: a lock roughly every 15-25s across 13 markets
export const CONFIRM_TICKS = 2;

const shareOf = (digits, n) => {
    const s = digits.slice(-Math.min(n, digits.length));
    const c = new Array(10).fill(0);
    for (let i = 0; i < s.length; i++) c[s[i]] += 1;
    return c.map(v => v / (s.length || 1));
};

const transitionShare = digits => {
    const last = digits[digits.length - 1];
    const next = new Array(10).fill(0);
    let n = 0;
    const from = Math.max(0, digits.length - HISTORY);
    for (let i = from; i < digits.length - 1; i++) {
        if (digits[i] === last) {
            next[digits[i + 1]] += 1;
            n += 1;
        }
    }
    const PRIOR = 20;
    return next.map(v => (v + PRIOR * NULL_P) / (n + PRIOR));
};

// One digit filling > 25% of the window means the decimals are wrong
// (e.g. a padded trailing zero). Never score broken data.
export const looksBroken = digits => {
    const c = shareOf(digits, HISTORY);
    return Math.max(...c) > 0.25;
};

export const scoreDigits = digits => {
    const s60 = shareOf(digits, 60);
    const s200 = shareOf(digits, 200);
    const tr = transitionShare(digits);
    return s60.map((v, d) => 0.4 * v + 0.35 * s200[d] + 0.25 * tr[d]);
};

export const bestMatch = digits => {
    if (!digits || digits.length < MIN_TICKS || looksBroken(digits)) return null;
    const scores = scoreDigits(digits);
    let digit = 0;
    for (let d = 1; d < 10; d++) if (scores[d] > scores[digit]) digit = d;
    const s200 = shareOf(digits, 200);
    return {
        digit,
        score: scores[digit],
        edge: scores[digit] - NULL_P,
        hitRate: s200[digit],
        scores,
        recent: digits.slice(-4),
    };
};

// The k strongest digits for a market, strongest first. Used by "cover" mode:
// one contract per digit, so one entry hits if ANY covered digit lands.
export const topDigits = (scores, k) =>
    scores
        .map((score, digit) => ({ digit, score }))
        .sort((a, b) => b.score - a.score || a.digit - b.digit)
        .slice(0, Math.max(1, Math.min(9, k)))
        .map(x => x.digit);

export const lastDigit = (quote, decimals) => Number(Number(quote).toFixed(decimals).slice(-1));
