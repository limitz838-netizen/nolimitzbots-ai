// @ts-nocheck -- Tally for the Analyse button.
//
// Every completed analysis window is recorded: how many ticks it covered and
// how many of them showed the suggested digit. The button therefore keeps its
// own scorecard, visible to whoever is pressing it.

const KEY = symbol => `nlb_analyse_v1_${symbol}`;
const NULL_P = 0.1;

const empty = () => ({ analyses: 0, ticks: 0, hits: 0, windows_with_hit: 0, recent: [] });

export const read = symbol => {
    try {
        const raw = window.localStorage.getItem(KEY(symbol));
        return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
    } catch {
        return empty();
    }
};

const save = (symbol, state) => {
    try {
        window.localStorage.setItem(KEY(symbol), JSON.stringify(state));
    } catch {
        /* noop */
    }
};

export const reset = symbol => {
    const s = empty();
    save(symbol, s);
    return s;
};

export const record = (symbol, entry) => {
    const state = read(symbol);
    state.analyses += 1;
    state.ticks += entry.ticks;
    state.hits += entry.hits;
    if (entry.hits > 0) state.windows_with_hit += 1;
    state.recent.unshift({ t: entry.t, digit: entry.digit, ticks: entry.ticks, hits: entry.hits });
    if (state.recent.length > 40) state.recent = state.recent.slice(0, 40);
    save(symbol, state);
    return state;
};

export const summarise = state => {
    const n = state.ticks;
    const rate = n ? state.hits / n : 0;
    const sd = Math.sqrt(n * NULL_P * (1 - NULL_P));
    const z = n && sd ? (state.hits - n * NULL_P) / sd : 0;

    let verdict;
    if (state.analyses < 20) {
        verdict = `${state.analyses} analyses so far. Not enough to judge the button yet.`;
    } else if (Math.abs(z) < 2) {
        verdict = `The suggested digit has shown up on ${state.hits} of ${n} ticks (${(rate * 100).toFixed(1)}%), against the 10% you would get by picking at random. z ${z.toFixed(2)} - no difference worth acting on.`;
    } else if (z > 0) {
        verdict = `${(rate * 100).toFixed(1)}% across ${n} ticks versus 10% at random (z ${z.toFixed(2)}). Keep going before reading anything into it.`;
    } else {
        verdict = `${(rate * 100).toFixed(1)}% across ${n} ticks, below the 10% random baseline (z ${z.toFixed(2)}).`;
    }

    return { n, hits: state.hits, rate, z, verdict, analyses: state.analyses };
};