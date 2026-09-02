// @ts-nocheck -- Matches Pro backtest store.
//
// Every prediction the engine makes gets graded against the tick that actually
// followed. No prediction is exempt, including the ones the engine labelled
// NO SIGNAL - that is the control group, and without it we cannot tell whether
// the signal filter is doing anything at all.
//
// Persisted per symbol so a run survives a refresh.

const KEY = symbol => `nlb_matches_backtest_v2_${symbol}`;
const MAX_RECENT = 300;

const NULL_P = 0.1;

const empty = () => ({
    total: 0,
    correct: 0,
    by_digit: Array.from({ length: 10 }, () => ({ n: 0, correct: 0 })),
    by_quality: {},
    longest_win: 0,
    longest_loss: 0,
    current_win: 0,
    current_loss: 0,
    recent: [], // newest last: { t, predicted, actual, hit, quality, score }
});

const load = symbol => {
    try {
        const raw = window.localStorage.getItem(KEY(symbol));
        if (!raw) return empty();
        const parsed = JSON.parse(raw);
        return { ...empty(), ...parsed };
    } catch {
        return empty();
    }
};

const save = (symbol, state) => {
    try {
        window.localStorage.setItem(KEY(symbol), JSON.stringify(state));
    } catch {
        /* storage full or blocked - stats stay in memory for this session */
    }
};

export const record = (symbol, entry) => {
    const state = load(symbol);
    const hit = entry.predicted === entry.actual;

    state.total += 1;
    if (hit) state.correct += 1;

    const bd = state.by_digit[entry.predicted];
    if (bd) {
        bd.n += 1;
        if (hit) bd.correct += 1;
    }

    const q = entry.quality || 'NO SIGNAL';
    if (!state.by_quality[q]) state.by_quality[q] = { n: 0, correct: 0 };
    state.by_quality[q].n += 1;
    if (hit) state.by_quality[q].correct += 1;

    if (hit) {
        state.current_win += 1;
        state.current_loss = 0;
        if (state.current_win > state.longest_win) state.longest_win = state.current_win;
    } else {
        state.current_loss += 1;
        state.current_win = 0;
        if (state.current_loss > state.longest_loss) state.longest_loss = state.current_loss;
    }

    state.recent.push({
        t: entry.t,
        predicted: entry.predicted,
        actual: entry.actual,
        hit,
        quality: q,
        score: entry.score,
    });
    if (state.recent.length > MAX_RECENT) state.recent = state.recent.slice(-MAX_RECENT);

    save(symbol, state);
    return state;
};

export const read = symbol => load(symbol);

export const reset = symbol => {
    const state = empty();
    save(symbol, state);
    return state;
};

// Normal approximation to the binomial, two-sided. Tells us whether the hit
// rate is distinguishable from 10% at all.
export const summarise = state => {
    const n = state.total;
    const k = state.correct;
    const accuracy = n ? k / n : 0;
    const sd = Math.sqrt(n * NULL_P * (1 - NULL_P));
    const z = n && sd ? (k - n * NULL_P) / sd : 0;

    // Two-sided p from z, Abramowitz-Stegun 7.1.26 error function.
    const erf = x => {
        const s = x < 0 ? -1 : 1;
        const a = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * a);
        const y =
            1 -
            ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
                t *
                Math.exp(-a * a);
        return s * y;
    };
    const p_value = n ? 1 - erf(Math.abs(z) / Math.SQRT2) : 1;

    const recent100 = state.recent.slice(-100);
    const recent_accuracy = recent100.length ? recent100.filter(r => r.hit).length / recent100.length : 0;

    let verdict;
    if (n < 200) verdict = `Only ${n} graded predictions. Far too few to conclude anything.`;
    else if (Math.abs(z) < 2)
        verdict = `Indistinguishable from chance (z ${z.toFixed(2)}, p ${p_value.toFixed(3)}). This is the expected result.`;
    else if (z >= 2)
        verdict = `Running above chance (z ${z.toFixed(2)}, p ${p_value.toFixed(3)}). Keep collecting - at this sample size a run like this still appears by luck fairly often.`;
    else verdict = `Running below chance (z ${z.toFixed(2)}, p ${p_value.toFixed(3)}).`;

    return { n, k, accuracy, z, p_value, recent_accuracy, verdict };
};