// @ts-nocheck
// Nolimitz AI measured digit engine.
//
// Design goal: every signal is deterministic and derived from real Deriv tick
// history. Nothing here returns random picks or fake probabilities. Live money
// execution is gated elsewhere by fresh forward evidence + the live proposal
// break-even rate.

export const NOLIMITZ_AI_ENGINE_VERSION = 'v1-measured';

const familyConfig = family => {
    if (family === 'even_odd') {
        return {
            sides: ['even', 'odd'],
            baseline: { even: 0.5, odd: 0.5 },
            minEdge: 0.015,
        };
    }
    return {
        sides: ['over', 'under'],
        baseline: { over: 0.7, under: 0.7 },
        minEdge: 0.01,
    };
};

export const sideWins = (family, side, digit) => {
    const d = Number(digit);
    if (!Number.isFinite(d)) return false;
    if (family === 'even_odd') return side === 'even' ? d % 2 === 0 : d % 2 === 1;
    return side === 'over' ? d > 2 : d < 7;
};

const category = (family, digit) => {
    const d = Number(digit);
    if (family === 'even_odd') return d % 2 === 0 ? 'E' : 'O';
    if (d <= 2) return 'L';
    if (d >= 7) return 'H';
    return 'M';
};

const probabilityFor = (family, side, values) => {
    if (!values.length) return 0;
    let wins = 0;
    values.forEach(d => {
        if (sideWins(family, side, d)) wins += 1;
    });
    return wins / values.length;
};

const chooseSide = (family, values, model, minSamples) => {
    if (!values || values.length < minSamples) return null;
    const cfg = familyConfig(family);
    const scored = cfg.sides
        .map(side => {
            const probability = probabilityFor(family, side, values);
            const edge = probability - cfg.baseline[side];
            return { side, probability, edge };
        })
        .sort((a, b) => b.edge - a.edge || b.probability - a.probability);

    const best = scored[0];
    if (!best || best.edge < cfg.minEdge) return null;
    return {
        model,
        side: best.side,
        probability: best.probability,
        edge: best.edge,
        samples: values.length,
    };
};

const recentModel = (digits, family) => {
    const window = digits.slice(-120);
    return chooseSide(family, window, 'recent-120', 80);
};

const exactTransitionModel = (digits, family) => {
    if (digits.length < 180) return null;
    const current = digits[digits.length - 1];
    const nextValues = [];
    for (let i = 0; i < digits.length - 2; i += 1) {
        if (digits[i] === current) nextValues.push(digits[i + 1]);
    }
    return chooseSide(family, nextValues, 'digit-transition', 25);
};

const categoryTransitionModel = (digits, family) => {
    if (digits.length < 180) return null;
    const currentContext = category(family, digits[digits.length - 1]);
    const nextValues = [];
    for (let i = 0; i < digits.length - 2; i += 1) {
        if (category(family, digits[i]) === currentContext) nextValues.push(digits[i + 1]);
    }
    return chooseSide(family, nextValues, 'regime-transition', 45);
};

const pairTransitionModel = (digits, family) => {
    if (digits.length < 240) return null;
    const a = category(family, digits[digits.length - 2]);
    const b = category(family, digits[digits.length - 1]);
    const nextValues = [];
    for (let i = 1; i < digits.length - 2; i += 1) {
        if (category(family, digits[i - 1]) === a && category(family, digits[i]) === b) {
            nextValues.push(digits[i + 1]);
        }
    }
    return chooseSide(family, nextValues, 'pair-transition', 22);
};

const strengthBucket = edge => {
    if (edge >= 0.06) return 'high';
    if (edge >= 0.03) return 'mid';
    return 'low';
};

export const analyzeDigitMarket = (digitsInput, family) => {
    const digits = (digitsInput || []).map(Number).filter(Number.isFinite);
    const cfg = familyConfig(family);

    if (digits.length < 150) {
        return {
            engineVersion: NOLIMITZ_AI_ENGINE_VERSION,
            family,
            candidate: null,
            votes: [],
            agreementTier: 0,
            fingerprint: null,
            estimate: 0,
            baseline: cfg.baseline,
            reason: `Collecting live history: ${digits.length}/150 ticks.`,
        };
    }

    const votes = [
        recentModel(digits, family),
        exactTransitionModel(digits, family),
        categoryTransitionModel(digits, family),
        pairTransitionModel(digits, family),
    ].filter(Boolean);

    const grouped = {};
    votes.forEach(vote => {
        if (!grouped[vote.side]) grouped[vote.side] = [];
        grouped[vote.side].push(vote);
    });

    const candidates = Object.entries(grouped)
        .map(([side, sideVotes]) => ({
            side,
            votes: sideVotes,
            agreementTier: sideVotes.length,
            score: sideVotes.reduce((sum, vote) => sum + vote.edge, 0),
        }))
        .sort((a, b) => b.agreementTier - a.agreementTier || b.score - a.score);

    const consensus = candidates[0];
    if (!consensus || consensus.agreementTier < 2) {
        return {
            engineVersion: NOLIMITZ_AI_ENGINE_VERSION,
            family,
            candidate: null,
            votes,
            agreementTier: consensus?.agreementTier || 0,
            fingerprint: null,
            estimate: 0,
            baseline: cfg.baseline,
            reason: 'Waiting for at least two independent empirical models to agree.',
        };
    }

    const totalWeight = consensus.votes.reduce((sum, vote) => sum + Math.sqrt(vote.samples), 0) || 1;
    const estimate =
        consensus.votes.reduce((sum, vote) => sum + vote.probability * Math.sqrt(vote.samples), 0) / totalWeight;
    const avgEdge = consensus.votes.reduce((sum, vote) => sum + vote.edge, 0) / consensus.votes.length;
    const modelIds = consensus.votes.map(v => v.model).sort();
    const context = category(family, digits[digits.length - 1]);
    const fingerprint = [
        family,
        consensus.side,
        modelIds.join('+'),
        `ctx:${context}`,
        `strength:${strengthBucket(avgEdge)}`,
    ].join('|');

    return {
        engineVersion: NOLIMITZ_AI_ENGINE_VERSION,
        family,
        candidate: consensus.side,
        votes,
        consensusVotes: consensus.votes,
        agreementTier: consensus.agreementTier,
        agreementModels: modelIds,
        fingerprint,
        estimate,
        averageEdge: avgEdge,
        baseline: cfg.baseline,
        reason: `${consensus.agreementTier} models agree on ${consensus.side.toUpperCase()} from real tick history.`,
    };
};

export const candidateToContract = (family, side) => {
    if (family === 'even_odd') {
        return side === 'odd'
            ? { type: 'DIGITODD', label: 'Odd' }
            : { type: 'DIGITEVEN', label: 'Even' };
    }
    return side === 'under'
        ? { type: 'DIGITUNDER', label: 'Under 7', barrier: 7 }
        : { type: 'DIGITOVER', label: 'Over 2', barrier: 2 };
};
