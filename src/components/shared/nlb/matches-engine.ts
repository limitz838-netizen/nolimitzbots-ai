// @ts-nocheck -- Matches Pro statistical prediction engine.
//
// Design rule: this engine is allowed to say "there is nothing here".
// It does NOT pick the most frequent digit and dress it up as a signal.
//
// What it does:
//   1. Measures each digit's deviation from the 10% null across five windows.
//   2. Adds recency-weighted frequency and a first-order transition term.
//   3. Corrects for multiple comparisons - we test 10 digits across 5 windows
//      on every tick, so an uncorrected "2 sigma" result is noise we would see
//      constantly by chance.
//   4. Shrinks the raw frequency toward 10% with a Bayesian prior, because a
//      13% reading on 100 ticks is not a 13% probability.
//   5. Compares the shrunk probability against the break-even probability
//      implied by the payout. A digit can be genuinely elevated and still be a
//      losing bet.
//
// Only if BOTH the statistical bar and the break-even bar are cleared does a
// signal get emitted.

export const WINDOWS = [50, 100, 250, 500, 1000];

const NULL_P = 0.1; // every digit on a volatility index
const NULL_SD_FACTOR = Math.sqrt(NULL_P * (1 - NULL_P)); // sqrt(0.09)

// Bonferroni-style critical value. 10 digits x 5 windows = 50 simultaneous
// tests per tick, two-sided alpha 0.05 -> alpha' = 0.001 -> z ~ 3.29.
export const Z_CRITICAL = 3.29;

// Dirichlet prior: 500 pseudo-observations spread evenly. Strong on purpose.
const PRIOR_STRENGTH = 500;
const PRIOR_PER_DIGIT = PRIOR_STRENGTH * NULL_P;

const RECENCY_LAMBDA = 0.99;
const RECENCY_SPAN = 300;
const MIN_SAMPLE = 100;
const MIN_TRANSITION_SAMPLE = 50;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const zScore = (count, n) => {
    if (!n) return 0;
    return (count - n * NULL_P) / (Math.sqrt(n) * NULL_SD_FACTOR);
};

// Counts for each digit over the last n ticks.
const countsOver = (digits, n) => {
    const c = new Array(10).fill(0);
    const start = Math.max(0, digits.length - n);
    for (let i = start; i < digits.length; i += 1) c[digits[i]] += 1;
    return { counts: c, n: digits.length - start };
};

// Exponentially recency-weighted frequency, with an effective sample size so
// the deviation can still be expressed as a z-score.
const recencyScores = digits => {
    const span = Math.min(RECENCY_SPAN, digits.length);
    const weights = new Array(10).fill(0);
    let sum_w = 0;
    let sum_w2 = 0;
    for (let i = 0; i < span; i += 1) {
        const digit = digits[digits.length - 1 - i];
        const w = RECENCY_LAMBDA ** i;
        weights[digit] += w;
        sum_w += w;
        sum_w2 += w * w;
    }
    const n_eff = sum_w2 ? (sum_w * sum_w) / sum_w2 : 0;
    return weights.map(w => {
        const p = sum_w ? w / sum_w : NULL_P;
        return n_eff ? (p - NULL_P) / (NULL_SD_FACTOR / Math.sqrt(n_eff)) : 0;
    });
};

// First-order transition: given the digit that just printed, how often does
// each digit follow it historically?
const transitionScores = (digits, last_digit) => {
    const counts = new Array(10).fill(0);
    let n = 0;
    for (let i = 0; i < digits.length - 1; i += 1) {
        if (digits[i] === last_digit) {
            counts[digits[i + 1]] += 1;
            n += 1;
        }
    }
    if (n < MIN_TRANSITION_SAMPLE) return { scores: new Array(10).fill(0), n };
    return { scores: counts.map(c => zScore(c, n)), n };
};

/**
 * predict(digits, { payout })
 *   digits: array of last digits, oldest first
 *   payout: DIGITMATCH payout multiplier (e.g. 9.3 means $1 returns $9.30)
 */
export const predict = (digits, options = {}) => {
    const payout = Number(options.payout) || 9.3;
    const breakeven = 1 / payout;

    if (!digits || digits.length < MIN_SAMPLE) {
        return {
            predictedDigit: null,
            score: 0,
            probabilityEstimate: NULL_P,
            sampleSize: digits ? digits.length : 0,
            signalQuality: 'NO SIGNAL',
            breakeven,
            reason: `Need ${MIN_SAMPLE} ticks before any inference. Have ${digits ? digits.length : 0}.`,
            factors: [],
            candidates: [],
        };
    }

    const usable = WINDOWS.filter(w => digits.length >= w);
    const per_window = usable.map(w => ({ w, ...countsOver(digits, w) }));
    const recency = recencyScores(digits);
    const transition = transitionScores(digits, digits[digits.length - 1]);

    // Pooled evidence over the largest available window.
    const largest = per_window[per_window.length - 1];

    const candidates = [];
    for (let d = 0; d < 10; d += 1) {
        const window_z = per_window.map(pw => ({ w: pw.w, z: zScore(pw.counts[d], pw.n) }));

        // The significance test uses the frequency z-score on the largest
        // window and nothing else. That quantity is a genuine z, so the 3.29
        // bar means what it says.
        //
        // Recency and transition are NOT added into it. Summing z-scores does
        // not produce a z-score - the terms overlap and the total is inflated,
        // which manufactures significance out of noise. They act as corroborating
        // evidence that can downgrade a signal, never as a way to reach the bar.
        const primary_z = zScore(largest.counts[d], largest.n);
        const agreement = window_z.filter(x => x.z > 0).length / window_z.length;
        const corroborated = recency[d] > 0 && transition.scores[d] > 0;

        // Shrunk probability: raw frequency pulled hard toward 0.1.
        const p_hat = (largest.counts[d] + PRIOR_PER_DIGIT) / (largest.n + PRIOR_STRENGTH);

        candidates.push({
            digit: d,
            primary_z,
            corroborated,
            agreement,
            p_hat,
            window_z,
            recency_z: recency[d],
            transition_z: transition.scores[d],
            observed: largest.counts[d] / largest.n,
        });
    }

    candidates.sort((a, b) => b.primary_z - a.primary_z);
    const best = candidates[0];

    const clears_stats = best.primary_z >= Z_CRITICAL;
    const clears_breakeven = best.p_hat > breakeven;

    let quality = 'NO SIGNAL';
    if (clears_stats && clears_breakeven) {
        quality = best.agreement >= 0.6 && best.corroborated ? 'STRONG' : 'MEDIUM';
    } else if (clears_stats || best.primary_z >= Z_CRITICAL * 0.75) {
        quality = 'WEAK';
    }

    // Score is progress toward the significance bar, not a win probability.
    const score = Math.round(100 * clamp(best.primary_z / Z_CRITICAL, 0, 1));

    let reason;
    if (!clears_stats && !clears_breakeven) {
        reason = `Digit ${best.digit} is the strongest candidate at ${best.primary_z.toFixed(2)} sigma, below the ${Z_CRITICAL} needed once you correct for testing 10 digits across ${usable.length} windows every tick. Its shrunk probability of ${(best.p_hat * 100).toFixed(2)}% is also under the ${(breakeven * 100).toFixed(2)}% needed to break even at ${payout}x.`;
    } else if (!clears_breakeven) {
        reason = `Digit ${best.digit} clears the statistical bar at ${best.primary_z.toFixed(2)} sigma, but its shrunk probability of ${(best.p_hat * 100).toFixed(2)}% is still below the ${(breakeven * 100).toFixed(2)}% break-even at ${payout}x. Real but not profitable.`;
    } else if (!clears_stats) {
        reason = `Digit ${best.digit} is above break-even on the point estimate but only ${best.primary_z.toFixed(2)} sigma, short of the ${Z_CRITICAL} bar. Likely noise.`;
    } else {
        reason = `Digit ${best.digit} clears both bars: ${best.primary_z.toFixed(2)} sigma and a shrunk probability of ${(best.p_hat * 100).toFixed(2)}% against ${(breakeven * 100).toFixed(2)}% break-even. Treat with suspicion until the backtest confirms it over hundreds of predictions.`;
    }

    return {
        predictedDigit: best.digit,
        score,
        probabilityEstimate: best.p_hat,
        observedRate: best.observed,
        sampleSize: largest.n,
        signalQuality: quality,
        breakeven,
        payout,
        reason,
        factors: [
            ...best.window_z.map(x => ({ label: `Frequency ${x.w} ticks`, value: x.z })),
            { label: 'Recency weighted', value: best.recency_z },
            {
                label: `Transition after ${digits[digits.length - 1]}`,
                value: best.transition_z,
                note: transition.n < MIN_TRANSITION_SAMPLE ? `only ${transition.n} samples` : `${transition.n} samples`,
            },
            { label: 'Test statistic (largest window)', value: best.primary_z, note: `bar is ${Z_CRITICAL}` },
        ],
        candidates: candidates.slice(0, 3),
    };
};