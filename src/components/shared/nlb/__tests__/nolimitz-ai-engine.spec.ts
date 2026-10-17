import {
    analyzeDigitMarket,
    candidateToContract,
    sideWins,
} from '../nolimitz-ai-engine';
import {
    readAiEvidence,
    recordAiEvidence,
    resetAiEvidence,
    setupEvidence,
} from '../nolimitz-ai-evidence';

describe('Nolimitz AI measured engine', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('is deterministic for identical real tick history', () => {
        const digits = Array.from({ length: 500 }, () => 2);
        const a = analyzeDigitMarket(digits, 'even_odd');
        const b = analyzeDigitMarket(digits, 'even_odd');

        expect(a).toEqual(b);
        expect(a.candidate).toBe('even');
        expect(a.agreementTier).toBeGreaterThanOrEqual(2);
        expect(a.fingerprint).toBeTruthy();
    });

    it('derives Over/Under candidates from tick outcomes rather than random picks', () => {
        const digits = Array.from({ length: 500 }, () => 9);
        const result = analyzeDigitMarket(digits, 'over_under');

        expect(result.candidate).toBe('over');
        expect(result.estimate).toBeGreaterThan(0.7);
        expect(candidateToContract('over_under', result.candidate)).toEqual({
            type: 'DIGITOVER',
            label: 'Over 2',
            barrier: 2,
        });
    });

    it('grades contract outcomes correctly', () => {
        expect(sideWins('even_odd', 'even', 4)).toBe(true);
        expect(sideWins('even_odd', 'even', 5)).toBe(false);
        expect(sideWins('over_under', 'over', 8)).toBe(true);
        expect(sideWins('over_under', 'over', 2)).toBe(false);
        expect(sideWins('over_under', 'under', 1)).toBe(true);
        expect(sideWins('over_under', 'under', 8)).toBe(false);
    });

    it('records fresh forward evidence from the actual next digit', () => {
        const symbol = '1HZ100V';
        const family = 'even_odd';
        const fingerprint = 'even_odd|even|model-a+model-b|ctx:E|strength:mid';

        resetAiEvidence(symbol, family);

        recordAiEvidence(symbol, family, {
            fingerprint,
            side: 'even',
            actual: 4,
            tier: 2,
            models: ['model-a', 'model-b'],
            estimate: 0.56,
            t: 1,
        });

        recordAiEvidence(symbol, family, {
            fingerprint,
            side: 'even',
            actual: 5,
            tier: 2,
            models: ['model-a', 'model-b'],
            estimate: 0.56,
            t: 2,
        });

        const state = readAiEvidence(symbol, family);
        const exact = setupEvidence(state, fingerprint);

        expect(state.total).toBe(2);
        expect(state.correct).toBe(1);
        expect(exact.n).toBe(2);
        expect(exact.correct).toBe(1);
        expect(exact.accuracy).toBe(0.5);
        expect(exact.lowerBound).toBeGreaterThanOrEqual(0);
        expect(exact.lowerBound).toBeLessThanOrEqual(exact.accuracy);
    });
});
