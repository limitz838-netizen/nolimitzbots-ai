// @ts-nocheck -- Matches Pro V3 consensus engine.
//
// Goal: predict the exact next last digit for a 1-tick DIGITMATCH contract.
// Every historical score is walk-forward: only ticks that existed before the
// scored tick may influence a prediction. The engine is allowed to abstain.

export const ENGINE_VERSION = 'v3-consensus';
export const WINDOWS = [50, 100, 250, 500, 1000];

const NULL_P = 0.1;
const MIN_SAMPLE = 250;
const HORIZON = 500;
const PRIOR = 100;
const MIN_CONSENSUS_TRIALS = 60;
const MIN_VOTES = 2;
const ECONOMIC_MARGIN = 0.005; // 0.5 percentage-point cushion over live break-even.

const counts = (digits, n) => {
    const out = new Array(10).fill(0);
    const slice = digits.slice(-Math.min(n, digits.length));
    slice.forEach(d => out[d]++);
    return { out, n: slice.length };
};

const topDigit = scores => {
    let digit = 0;
    for (let i = 1; i < 10; i++) if (scores[i] > scores[digit]) digit = i;
    return digit;
};

const frequencyModel = digits => {
    if (digits.length < 250) return null;
    const { out, n } = counts(digits, 250);
    const digit = topDigit(out);
    return { digit, strength: Math.max(0, out[digit] / n - NULL_P), detail: 'frequency/250' };
};

const transitionModel = digits => {
    if (digits.length < MIN_SAMPLE) return null;
    const last = digits[digits.length - 1];
    const next = new Array(10).fill(0);
    let n = 0;
    for (let i = 0; i < digits.length - 1; i++) {
        if (digits[i] === last) {
            next[digits[i + 1]]++;
            n++;
        }
    }
    if (n < 20) return null;
    const digit = topDigit(next);
    return { digit, strength: Math.max(0, next[digit] / n - NULL_P), detail: `transition-after-${last}/${n}` };
};

const momentumModel = digits => {
    if (digits.length < MIN_SAMPLE) return null;
    const short = counts(digits, 50);
    const long = counts(digits, 250);
    const scores = short.out.map((v, d) => v / short.n - long.out[d] / long.n);
    const digit = topDigit(scores);
    return { digit, strength: Math.max(0, scores[digit]), detail: 'short-vs-long' };
};

const reversionModel = digits => {
    if (digits.length < MIN_SAMPLE) return null;
    const short = counts(digits, 50);
    const long = counts(digits, 250);
    const scores = short.out.map((v, d) => long.out[d] / long.n - v / short.n);
    const digit = topDigit(scores);
    return { digit, strength: Math.max(0, scores[digit]), detail: 'distribution-reversion' };
};

const MODELS = [
    { id: 'frequency', run: frequencyModel },
    { id: 'transition', run: transitionModel },
    { id: 'momentum', run: momentumModel },
    { id: 'reversion', run: reversionModel },
];

const consensusFromPicks = picks => {
    const groups = new Map();
    picks.forEach(p => {
        if (!p || p.pick?.digit === null || p.pick?.digit === undefined) return;
        const row = groups.get(p.pick.digit) || { digit: p.pick.digit, votes: 0, strength: 0, models: [] };
        row.votes += 1;
        row.strength += Number(p.pick.strength) || 0;
        row.models.push(p.id);
        groups.set(row.digit, row);
    });
    const ranked = [...groups.values()].sort((a, b) => b.votes - a.votes || b.strength - a.strength || a.digit - b.digit);
    const best = ranked[0] || null;
    if (!best || best.votes < MIN_VOTES) return null;
    return best;
};

const shrink = (hits, trials) => (hits + PRIOR * NULL_P) / (trials + PRIOR);

// Wilson lower bound. 1.645 ~= one-sided 95% / two-sided 90%.
const wilsonLower = (hits, trials, z = 1.645) => {
    if (!trials) return 0;
    const p = hits / trials;
    const z2 = z * z;
    const den = 1 + z2 / trials;
    const centre = p + z2 / (2 * trials);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
    return Math.max(0, (centre - spread) / den);
};

const evaluateAll = digits => {
    const modelStats = Object.fromEntries(MODELS.map(m => [m.id, { id: m.id, trials: 0, hits: 0 }]));
    const consensus = { id: 'consensus', trials: 0, hits: 0, by_digit: Array.from({ length: 10 }, () => ({ n: 0, hits: 0 })) };
    const start = Math.max(MIN_SAMPLE, digits.length - HORIZON);

    for (let i = start; i < digits.length; i++) {
        const history = digits.slice(0, i);
        const picks = MODELS.map(model => ({ id: model.id, pick: model.run(history) }));
        const actual = digits[i];

        picks.forEach(({ id, pick }) => {
            if (!pick) return;
            const row = modelStats[id];
            row.trials++;
            if (pick.digit === actual) row.hits++;
        });

        const agreed = consensusFromPicks(picks);
        if (agreed) {
            consensus.trials++;
            consensus.by_digit[agreed.digit].n++;
            if (agreed.digit === actual) {
                consensus.hits++;
                consensus.by_digit[agreed.digit].hits++;
            }
        }
    }

    const modelResults = Object.values(modelStats)
        .map(row => ({
            ...row,
            accuracy: row.trials ? row.hits / row.trials : 0,
            validated: shrink(row.hits, row.trials),
        }))
        .sort((a, b) => b.validated - a.validated);

    consensus.accuracy = consensus.trials ? consensus.hits / consensus.trials : 0;
    consensus.validated = shrink(consensus.hits, consensus.trials);
    consensus.lowerBound = wilsonLower(consensus.hits, consensus.trials);
    consensus.coverage = Math.max(0, digits.length - start) ? consensus.trials / Math.max(1, digits.length - start) : 0;

    return { modelResults, consensus };
};

export const evaluateModels = digits => evaluateAll(digits);

export const predict = (digits, options = {}) => {
    const fallbackPayout = Number(options.payout) || 9.3;
    if (!digits || digits.length < MIN_SAMPLE) {
        return {
            engineVersion: ENGINE_VERSION,
            predictedDigit: null,
            candidateDigit: null,
            score: 0,
            probabilityEstimate: NULL_P,
            sampleSize: digits?.length || 0,
            signalQuality: 'NO SIGNAL',
            breakeven: 1 / fallbackPayout,
            payout: fallbackPayout,
            reason: `Need at least ${MIN_SAMPLE} real ticks before Matches analysis.`,
            modelResults: [],
            consensus: null,
            liveVotes: [],
        };
    }

    const livePicks = MODELS.map(model => ({ id: model.id, pick: model.run(digits) }));
    const liveConsensus = consensusFromPicks(livePicks);
    const { modelResults, consensus } = evaluateAll(digits);

    const candidate = liveConsensus?.digit ?? null;
    const exactLive = candidate !== null ? options.payoutByDigit?.[candidate] : null;
    const payout = Number(exactLive) > 0 ? Number(exactLive) : fallbackPayout;
    const breakeven = 1 / payout;

    const enoughEvidence = consensus.trials >= MIN_CONSENSUS_TRIALS;
    const aboveChance = consensus.lowerBound > NULL_P;
    const clearsEconomics = consensus.validated >= breakeven + ECONOMIC_MARGIN;
    const shouldPredict = Boolean(liveConsensus && enoughEvidence && aboveChance && clearsEconomics);

    let reason;
    if (!liveConsensus) {
        reason = 'No prediction: fewer than two independent Matches models agree on the same next digit.';
    } else if (!enoughEvidence) {
        reason = `No prediction: consensus has only ${consensus.trials} walk-forward trials; need ${MIN_CONSENSUS_TRIALS}.`;
    } else if (!aboveChance) {
        reason = `No prediction: consensus lower-bound accuracy is ${(consensus.lowerBound * 100).toFixed(2)}%, not yet above the 10% random baseline.`;
    } else if (!clearsEconomics) {
        reason = `No prediction: consensus validates at ${(consensus.validated * 100).toFixed(2)}%, below the ${((breakeven + ECONOMIC_MARGIN) * 100).toFixed(2)}% Matches safety threshold for digit ${candidate}.`;
    } else {
        reason = `MATCH ${candidate}: ${liveConsensus.votes} models agree (${liveConsensus.models.join(', ')}). Consensus walk-forward accuracy is ${(consensus.accuracy * 100).toFixed(2)}% across ${consensus.trials} emitted predictions; live digit-${candidate} break-even is ${(breakeven * 100).toFixed(2)}%.`;
    }

    const economicEdge = consensus.validated - breakeven;
    const score = Math.max(0, Math.min(100, Math.round((economicEdge / 0.05) * 100)));

    return {
        engineVersion: ENGINE_VERSION,
        predictedDigit: shouldPredict ? candidate : null,
        candidateDigit: candidate,
        score,
        probabilityEstimate: consensus.validated,
        observedRate: consensus.accuracy,
        sampleSize: digits.length,
        signalQuality: shouldPredict ? (consensus.lowerBound > breakeven ? 'STRONG' : 'MEDIUM') : 'NO SIGNAL',
        breakeven,
        payout,
        reason,
        selectedModel: shouldPredict ? 'consensus' : 'consensus-watch',
        modelResults,
        consensus,
        liveVotes: livePicks.map(({ id, pick }) => ({
            model: id,
            digit: pick?.digit ?? null,
            strength: pick?.strength ?? 0,
            agrees: candidate !== null && pick?.digit === candidate,
        })),
        factors: [
            ...modelResults.map(m => ({
                label: m.id,
                value: m.validated,
                note: `${m.hits}/${m.trials} walk-forward; raw ${(m.accuracy * 100).toFixed(2)}%`,
            })),
            {
                label: 'consensus',
                value: consensus.validated,
                note: `${consensus.hits}/${consensus.trials}; lower bound ${(consensus.lowerBound * 100).toFixed(2)}%`,
            },
        ],
    };
};
