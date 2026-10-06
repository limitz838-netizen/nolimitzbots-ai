// @ts-nocheck
import { sideWins } from './nolimitz-ai-engine';

const VERSION = 'v1';
const key = (symbol, family) => `nlb_nolimitz_ai_evidence_${VERSION}_${symbol}_${family}`;

const blank = () => ({
    total: 0,
    correct: 0,
    by_setup: {},
    by_tier: {},
    recent: [],
});

export const readAiEvidence = (symbol, family) => {
    try {
        const raw = localStorage.getItem(key(symbol, family));
        if (!raw) return blank();
        const parsed = JSON.parse(raw);
        return {
            ...blank(),
            ...parsed,
            by_setup: parsed?.by_setup || {},
            by_tier: parsed?.by_tier || {},
            recent: parsed?.recent || [],
        };
    } catch {
        return blank();
    }
};

const save = (symbol, family, state) => {
    try {
        localStorage.setItem(key(symbol, family), JSON.stringify(state));
    } catch {
        /* local evidence should never crash trading UI */
    }
};

export const wilsonLower = (hits, trials, z = 1.645) => {
    if (!trials) return 0;
    const p = hits / trials;
    const z2 = z * z;
    const den = 1 + z2 / trials;
    const centre = p + z2 / (2 * trials);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
    return Math.max(0, (centre - spread) / den);
};

export const setupEvidence = (state, fingerprint) => {
    const row = state?.by_setup?.[fingerprint];
    if (!row) return { n: 0, correct: 0, accuracy: 0, lowerBound: 0, row: null };
    const n = Number(row.n) || 0;
    const correct = Number(row.correct) || 0;
    return {
        n,
        correct,
        accuracy: n ? correct / n : 0,
        lowerBound: wilsonLower(correct, n),
        row,
    };
};

export const recordAiEvidence = (symbol, family, entry) => {
    if (!entry?.fingerprint || entry?.side == null || entry?.actual == null) return readAiEvidence(symbol, family);
    const state = readAiEvidence(symbol, family);
    const hit = sideWins(family, entry.side, entry.actual);

    state.total += 1;
    if (hit) state.correct += 1;

    if (!state.by_setup[entry.fingerprint]) {
        state.by_setup[entry.fingerprint] = {
            n: 0,
            correct: 0,
            side: entry.side,
            models: entry.models || [],
            tier: Number(entry.tier) || 0,
            last_t: 0,
        };
    }

    const row = state.by_setup[entry.fingerprint];
    row.n += 1;
    row.last_t = entry.t || Date.now();
    if (hit) row.correct += 1;

    const tierKey = String(Number(entry.tier) || 0);
    if (!state.by_tier[tierKey]) state.by_tier[tierKey] = { n: 0, correct: 0 };
    state.by_tier[tierKey].n += 1;
    if (hit) state.by_tier[tierKey].correct += 1;

    state.recent.unshift({
        t: entry.t || Date.now(),
        side: entry.side,
        actual: entry.actual,
        hit,
        fingerprint: entry.fingerprint,
        tier: Number(entry.tier) || 0,
        estimate: Number(entry.estimate) || 0,
    });
    state.recent = state.recent.slice(0, 30);

    save(symbol, family, state);
    return state;
};

export const resetAiEvidence = (symbol, family) => {
    const state = blank();
    save(symbol, family, state);
    return state;
};

export const topAiSetups = (state, limit = 6) =>
    Object.entries(state?.by_setup || {})
        .map(([fingerprint, row]) => {
            const n = Number(row.n) || 0;
            const correct = Number(row.correct) || 0;
            return {
                fingerprint,
                ...row,
                accuracy: n ? correct / n : 0,
                lowerBound: wilsonLower(correct, n),
            };
        })
        .sort((a, b) => b.n - a.n || b.accuracy - a.accuracy)
        .slice(0, limit);
