// @ts-nocheck -- Matches Pro V2 walk-forward ensemble.
//
// Every model below only sees ticks that existed BEFORE the digit being scored.
// A model may abstain. Abstention is preferable to manufacturing confidence.

export const WINDOWS = [50, 100, 250, 500, 1000];
const NULL_P = 0.1;
const MIN_SAMPLE = 100;
const MIN_MODEL_TRIALS = 60;
const MIN_EDGE = 0.015;
const PRIOR = 100;

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

const frequencyModel = (digits, window = 250) => {
    if (digits.length < Math.min(window, MIN_SAMPLE)) return null;
    const { out, n } = counts(digits, window);
    const digit = topDigit(out);
    return { digit, strength: out[digit] / n - NULL_P, detail: `frequency/${Math.min(window, n)}` };
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
    return { digit, strength: next[digit] / n - NULL_P, detail: `transition-after-${last}/${n}` };
};

const momentumModel = digits => {
    if (digits.length < 250) return null;
    const short = counts(digits, 50);
    const long = counts(digits, 250);
    const scores = short.out.map((v, d) => v / short.n - long.out[d] / long.n);
    const digit = topDigit(scores);
    return { digit, strength: scores[digit], detail: 'short-vs-long' };
};

const reversionModel = digits => {
    if (digits.length < 250) return null;
    const short = counts(digits, 50);
    const long = counts(digits, 250);
    const scores = short.out.map((v, d) => long.out[d] / long.n - v / short.n);
    const digit = topDigit(scores);
    return { digit, strength: scores[digit], detail: 'distribution-reversion' };
};

const MODELS = [
    { id: 'frequency', run: d => frequencyModel(d, 250) },
    { id: 'transition', run: transitionModel },
    { id: 'momentum', run: momentumModel },
    { id: 'reversion', run: reversionModel },
];

const evaluateModel = (model, digits, horizon = 500) => {
    const start = Math.max(MIN_SAMPLE, digits.length - horizon);
    let trials = 0;
    let hits = 0;
    for (let i = start; i < digits.length; i++) {
        const pick = model.run(digits.slice(0, i));
        if (!pick) continue;
        trials++;
        if (pick.digit === digits[i]) hits++;
    }
    const accuracy = trials ? hits / trials : 0;
    // Beta-style shrinkage toward the 10% null so small samples cannot win selection.
    const validated = (hits + PRIOR * NULL_P) / (trials + PRIOR);
    return { id: model.id, trials, hits, accuracy, validated };
};

export const evaluateModels = digits =>
    MODELS.map(model => evaluateModel(model, digits))
        .sort((a, b) => b.validated - a.validated);

export const predict = (digits, options = {}) => {
    const payout = Number(options.payout) || 9.3;
    const breakeven = 1 / payout;
    if (!digits || digits.length < MIN_SAMPLE) {
        return {
            predictedDigit: null, score: 0, probabilityEstimate: NULL_P,
            sampleSize: digits?.length || 0, signalQuality: 'NO SIGNAL', breakeven,
            reason: `Need at least ${MIN_SAMPLE} real ticks before analysis.`, factors: [], modelResults: [],
        };
    }

    const modelResults = evaluateModels(digits);
    const bestStats = modelResults[0];
    const model = MODELS.find(m => m.id === bestStats.id);
    const livePick = model?.run(digits);
    const enoughEvidence = bestStats.trials >= MIN_MODEL_TRIALS;
    const measuredEdge = bestStats.validated - NULL_P;
    const clearsBaseline = enoughEvidence && measuredEdge >= MIN_EDGE;
    const clearsEconomics = bestStats.validated > breakeven;
    const shouldPredict = Boolean(livePick && clearsBaseline && clearsEconomics);

    let reason;
    if (!enoughEvidence) reason = `No prediction: best model has only ${bestStats.trials} walk-forward trials; need ${MIN_MODEL_TRIALS}.`;
    else if (!clearsBaseline) reason = `No prediction: ${bestStats.id} validates at ${(bestStats.validated * 100).toFixed(2)}%, not enough above the 10% random baseline.`;
    else if (!clearsEconomics) reason = `No prediction: ${bestStats.id} validates at ${(bestStats.validated * 100).toFixed(2)}%, below the ${(breakeven * 100).toFixed(2)}% break-even implied by the live payout.`;
    else reason = `${bestStats.id} is the current best walk-forward model: ${bestStats.hits}/${bestStats.trials} correct, shrunk validation ${(bestStats.validated * 100).toFixed(2)}%.`;

    const score = Math.max(0, Math.min(100, Math.round((measuredEdge / 0.05) * 100)));
    return {
        predictedDigit: shouldPredict ? livePick.digit : null,
        candidateDigit: livePick?.digit ?? null,
        score,
        probabilityEstimate: bestStats.validated,
        observedRate: bestStats.accuracy,
        sampleSize: digits.length,
        signalQuality: shouldPredict ? (bestStats.validated >= breakeven + 0.02 ? 'STRONG' : 'MEDIUM') : 'NO SIGNAL',
        breakeven, payout, reason,
        selectedModel: bestStats.id,
        modelResults,
        factors: modelResults.map(m => ({
            label: m.id,
            value: m.validated,
            note: `${m.hits}/${m.trials} walk-forward; raw ${(m.accuracy * 100).toFixed(2)}%`,
        })),
    };
};
