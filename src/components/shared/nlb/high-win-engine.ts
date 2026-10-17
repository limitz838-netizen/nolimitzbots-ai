// @ts-nocheck — Nolimitz AI high-win engine (pure functions, no imports).
//
// Contracts that win about 9 ticks in 10 by construction:
//   DIFFERS d : next digit is anything but d
//   OVER 0    : next digit is 1-9
//   UNDER 9   : next digit is 0-8
// Measured on 195,000 real Deriv ticks (13 markets): 90.05% / 90.06% / 89.99%.
// Deriv pays ~9.6% profit on these at stakes of 2+ (much less below), so the
// break-even win rate is ~91.2%. Win rate is real; long-run profit is not.

export const HW_CONTRACTS = [
    { id: 'DIFF', label: 'Differs', type: 'DIGITDIFF', short: 'DIFF', fair: 0.9 },
    { id: 'OVER0', label: 'Over 0', type: 'DIGITOVER', barrier: 0, short: 'OVER 0', fair: 0.9 },
    { id: 'UNDER9', label: 'Under 9', type: 'DIGITUNDER', barrier: 9, short: 'UNDER 9', fair: 0.9 },
];

export const MIN_FULL_PAYOUT_STAKE = 2;

export const lastDigit = (quote, decimals) => Number(Number(quote).toFixed(decimals).slice(-1));

export const digitShares = (digits, n = 500) => {
    const s = digits.slice(-Math.min(n, digits.length));
    const c = new Array(10).fill(0);
    s.forEach(d => (c[d] += 1));
    return c.map(v => v / (s.length || 1));
};

// Differs pick: least-seen digit in the last 100 ticks (ties -> lowest digit).
// Every digit carries the same ~90% chance; this gives a stable, explainable pick.
export const differsPick = digits => {
    if (!digits || digits.length < 50) return null;
    const c = new Array(10).fill(0);
    digits.slice(-100).forEach(d => (c[d] += 1));
    let pick = 0;
    for (let d = 1; d < 10; d++) if (c[d] < c[pick]) pick = d;
    return pick;
};

// The digit that would LOSE the chosen contract.
export const losingDigit = (contract, digits) => {
    if (contract.id === 'OVER0') return 0;
    if (contract.id === 'UNDER9') return 9;
    return differsPick(digits);
};

// Ticks since the losing digit last appeared.
export const ticksSince = (digits, d) => {
    if (d === null || d === undefined) return null;
    for (let i = digits.length - 1, n = 0; i >= 0; i--, n++) if (digits[i] === d) return n;
    return digits.length;
};

export const wins = (contract, barrier, digit) => {
    if (contract.id === 'OVER0') return digit > 0;
    if (contract.id === 'UNDER9') return digit < 9;
    return digit !== barrier;
};

// Chance a session reaches the profit target before the stop-loss (Monte Carlo).
export const sessionOdds = (p, stake, payout, tp, sl) => {
    if (!(stake > 0) || !(tp > 0) || !(sl > 0) || !(payout > 1)) return null;
    const win = stake * (payout - 1);
    let seed = 987654;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let reached = 0;
    const RUNS = 2000;
    for (let r = 0; r < RUNS; r++) {
        let pnl = 0;
        for (let n = 0; n < 5000 && pnl < tp && pnl > -sl; n++) pnl += rnd() < p ? win : -stake;
        if (pnl >= tp) reached += 1;
    }
    return reached / RUNS;
};
