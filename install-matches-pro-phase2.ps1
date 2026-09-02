# ==========================================================================
#  NolimitzBots - Matches Pro, Phase 2
#  Statistical prediction engine + live backtest. Still no trading.
#
#      powershell -ExecutionPolicy Bypass -File .\install-matches-pro-phase2.ps1
#
#  Flags:  -SkipBuild   -NoPush
# ==========================================================================
param([switch]$SkipBuild, [switch]$NoPush)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "  FAILED: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Info($msg) { Write-Host $msg -ForegroundColor Cyan }

try { $root = (git rev-parse --show-toplevel).Trim() } catch { Fail 'Not inside a git repository.' }
Set-Location $root
if (-not (Test-Path 'src/components/shared/nlb/tick-stream.ts')) { Fail 'Phase 1 not installed. Run the Phase 1 installer first.' }
Info "Repo: $root"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-File($relPath, $text) {
    $full = Join-Path $root $relPath
    $dir  = Split-Path -Parent $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($full, $text.Replace("`r`n", "`n"), $utf8NoBom)
    Ok "wrote $relPath"
}

$engineSrc = @'
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
'@

$storeSrc = @'
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
'@

$pageSrc = @'
// @ts-nocheck -- Matches Pro (Phase 2: prediction engine + live backtest).
//
// Still no trading. Every prediction is graded against the next tick so the
// engine's real accuracy is visible before a single order can be placed.
import React from 'react';
import { subscribeTicks, TICK_STATUS, getDiagnostics } from '@/components/shared/nlb/tick-stream';
import { predict, Z_CRITICAL } from '@/components/shared/nlb/matches-engine';
import { record, read, reset, summarise } from '@/components/shared/nlb/backtest-store';
import './matches-pro.scss';

const DEFAULT_SYMBOLS = [
    { code: 'R_100', label: 'Volatility 100 Index' },
    { code: 'R_75', label: 'Volatility 75 Index' },
    { code: 'R_50', label: 'Volatility 50 Index' },
    { code: 'R_25', label: 'Volatility 25 Index' },
    { code: 'R_10', label: 'Volatility 10 Index' },
    { code: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { code: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { code: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { code: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { code: '1HZ10V', label: 'Volatility 10 (1s) Index' },
];

const WINDOW_CHOICES = [50, 100, 250, 500, 1000];
const HISTORY = 1000;

const STATUS_TEXT = {
    [TICK_STATUS.LIVE]: 'LIVE',
    [TICK_STATUS.CONNECTING]: 'CONNECTING',
    [TICK_STATUS.RECONNECTING]: 'RECONNECTING',
    [TICK_STATUS.DISCONNECTED]: 'DISCONNECTED',
};

const pct = v => `${(v * 100).toFixed(2)}%`;
const clockOf = ts => new Date(ts).toLocaleTimeString('en-GB');

const MatchesPro = () => {
    const [symbol, setSymbol] = React.useState('R_100');
    const [symbols, setSymbols] = React.useState(DEFAULT_SYMBOLS);
    const [status, setStatus] = React.useState(TICK_STATUS.CONNECTING);
    const [quote, setQuote] = React.useState(null);
    const [decimals, setDecimals] = React.useState(null);
    const [digits, setDigits] = React.useState([]);
    const [window_size, setWindowSize] = React.useState(100);
    const [payout, setPayout] = React.useState(9.3);
    const [error, setError] = React.useState('');
    const [diag, setDiag] = React.useState(null);
    const [prediction, setPrediction] = React.useState(null);
    const [stats, setStats] = React.useState(null);
    const [feed, setFeed] = React.useState([]);
    const [show_why, setShowWhy] = React.useState(false);

    const digits_ref = React.useRef([]);
    const pending_ref = React.useRef(null);
    const payout_ref = React.useRef(payout);
    payout_ref.current = payout;

    const refreshStats = React.useCallback(sym => {
        const state = read(sym);
        setStats({ state, summary: summarise(state) });
    }, []);

    // One prediction per tick, graded against the tick that follows it.
    const step = React.useCallback(
        (sym, actual_digit, ts) => {
            const pending = pending_ref.current;
            if (pending && pending.predicted !== null && pending.symbol === sym) {
                record(sym, {
                    t: ts,
                    predicted: pending.predicted,
                    actual: actual_digit,
                    quality: pending.quality,
                    score: pending.score,
                });
                setFeed(prev =>
                    [
                        {
                            t: ts,
                            predicted: pending.predicted,
                            actual: actual_digit,
                            hit: pending.predicted === actual_digit,
                            quality: pending.quality,
                            score: pending.score,
                        },
                        ...prev,
                    ].slice(0, 12)
                );
            }

            const next = predict(digits_ref.current, { payout: payout_ref.current });
            setPrediction(next);
            pending_ref.current = {
                symbol: sym,
                predicted: next.predictedDigit,
                quality: next.signalQuality,
                score: next.score,
            };
            refreshStats(sym);
        },
        [refreshStats]
    );

    React.useEffect(() => {
        digits_ref.current = [];
        pending_ref.current = null;
        setDigits([]);
        setQuote(null);
        setError('');
        setFeed([]);
        setPrediction(null);
        refreshStats(symbol);

        const unsubscribe = subscribeTicks({
            symbol,
            count: HISTORY,
            onStatus: setStatus,
            onError: message => setError(message),
            onSymbols: list => {
                if (!list?.length) return;
                const known = Object.fromEntries(DEFAULT_SYMBOLS.map(s => [s.code, s.label]));
                setSymbols(
                    list.map(s => ({
                        code: s.code,
                        label: s.label && s.label !== s.code ? s.label : known[s.code] || s.code,
                    }))
                );
            },
            onHistory: ({ digits: d, quote: q, decimals: dec }) => {
                digits_ref.current = [...d];
                setDigits(d);
                setQuote(q);
                setDecimals(dec);
                // Seed a first prediction, but do not grade the seeded history.
                const seeded = predict(digits_ref.current, { payout: payout_ref.current });
                setPrediction(seeded);
                pending_ref.current = {
                    symbol,
                    predicted: seeded.predictedDigit,
                    quality: seeded.signalQuality,
                    score: seeded.score,
                };
            },
            onTick: ({ digit, quote: q, decimals: dec }) => {
                setDecimals(dec);
                setQuote(q);
                digits_ref.current = [...digits_ref.current, digit].slice(-HISTORY);
                setDigits(digits_ref.current);
                step(symbol, digit, Date.now());
            },
        });

        return unsubscribe;
    }, [symbol, step, refreshStats]);

    React.useEffect(() => {
        const id = setInterval(() => setDiag(getDiagnostics()), 1000);
        return () => clearInterval(id);
    }, []);

    const sample = React.useMemo(() => digits.slice(-window_size), [digits, window_size]);

    const distribution = React.useMemo(() => {
        const counts = new Array(10).fill(0);
        sample.forEach(d => {
            counts[d] += 1;
        });
        const total = sample.length || 1;
        return counts.map((c, d) => ({ digit: d, count: c, p: (c / total) * 100 }));
    }, [sample]);

    const max_pct = Math.max(10, ...distribution.map(d => d.p));
    const current_digit = digits.length ? digits[digits.length - 1] : null;
    const status_text = STATUS_TEXT[status] || STATUS_TEXT[TICK_STATUS.DISCONNECTED];
    const predicted = prediction?.predictedDigit;
    const quality = prediction?.signalQuality || 'NO SIGNAL';

    const onReset = () => {
        reset(symbol);
        setFeed([]);
        refreshStats(symbol);
    };

    return (
        <div className='matches-pro'>
            <div className='matches-pro__panel'>
                <div className='matches-pro__head'>
                    <div>
                        <div className='matches-pro__title'>MATCHES PRO</div>
                        <div className='matches-pro__subtitle'>
                            Phase 2 - prediction engine with live scoring. No trading yet.
                        </div>
                    </div>
                    <div className={`matches-pro__status matches-pro__status--${status}`}>
                        <i className='matches-pro__dot' />
                        {status_text}
                    </div>
                </div>

                {error && <div className='matches-pro__warn'>{error}</div>}

                <div className='matches-pro__controls'>
                    <label className='matches-pro__field'>
                        <span>Market</span>
                        <select value={symbol} onChange={e => setSymbol(e.target.value)}>
                            {symbols.map(s => (
                                <option key={s.code} value={s.code}>
                                    {s.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>Distribution window</span>
                        <select value={window_size} onChange={e => setWindowSize(Number(e.target.value))}>
                            {WINDOW_CHOICES.map(w => (
                                <option key={w} value={w}>
                                    {w} ticks
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='matches-pro__field'>
                        <span>Match payout multiplier</span>
                        <input
                            type='number'
                            step='0.1'
                            min='1.1'
                            value={payout}
                            onChange={e => setPayout(Number(e.target.value) || 9.3)}
                        />
                    </label>
                </div>

                <div className='matches-pro__readout'>
                    <div className='matches-pro__stat'>
                        <span>Current tick</span>
                        <strong>{quote ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Current digit</span>
                        <strong className='matches-pro__digit'>{current_digit ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>Decimals</span>
                        <strong>{decimals ?? '-'}</strong>
                    </div>
                    <div className='matches-pro__stat'>
                        <span>History</span>
                        <strong>{digits.length}</strong>
                    </div>
                </div>

                <div className='matches-pro__section-title'>Statistical analysis</div>
                <div className={`matches-pro__signal matches-pro__signal--${quality.replace(' ', '-').toLowerCase()}`}>
                    <div className='matches-pro__signal-main'>
                        <div className='matches-pro__signal-digit'>{predicted ?? '-'}</div>
                        <div>
                            <div className='matches-pro__signal-quality'>{quality}</div>
                            <div className='matches-pro__signal-sub'>
                                Score {prediction?.score ?? 0}/100, sample {prediction?.sampleSize ?? 0}
                            </div>
                        </div>
                    </div>
                    <div className='matches-pro__signal-nums'>
                        <div>
                            <span>Estimated probability</span>
                            <strong>{prediction ? pct(prediction.probabilityEstimate) : '-'}</strong>
                        </div>
                        <div>
                            <span>Break-even needed</span>
                            <strong>{prediction ? pct(prediction.breakeven) : '-'}</strong>
                        </div>
                    </div>
                </div>

                {prediction && (
                    <>
                        <button type='button' className='matches-pro__link' onClick={() => setShowWhy(v => !v)}>
                            {show_why ? 'Hide reasoning' : 'Why?'}
                        </button>
                        {show_why && (
                            <div className='matches-pro__why'>
                                <p>{prediction.reason}</p>
                                <table>
                                    <tbody>
                                        {prediction.factors.map(f => (
                                            <tr key={f.label}>
                                                <td>{f.label}</td>
                                                <td className={f.value >= 0 ? 'pos' : 'neg'}>
                                                    {f.value >= 0 ? '+' : ''}
                                                    {f.value.toFixed(2)} sigma
                                                </td>
                                                <td className='note'>{f.note || ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <p className='matches-pro__why-foot'>
                                    Significance bar is {Z_CRITICAL} sigma, corrected for testing 10 digits across 5
                                    windows on every tick. Probability is shrunk toward 10% with a 500-observation
                                    prior, so a lucky run inside the window does not become a claimed edge.
                                </p>
                            </div>
                        )}
                    </>
                )}

                <div className='matches-pro__section-title'>
                    Backtest
                    <button type='button' className='matches-pro__reset' onClick={onReset}>
                        Reset
                    </button>
                </div>
                {stats && (
                    <>
                        <div className='matches-pro__readout'>
                            <div className='matches-pro__stat'>
                                <span>Predictions</span>
                                <strong>{stats.summary.n}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Correct</span>
                                <strong>{stats.summary.k}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Accuracy</span>
                                <strong>{stats.summary.n ? pct(stats.summary.accuracy) : '-'}</strong>
                            </div>
                            <div className='matches-pro__stat'>
                                <span>Baseline</span>
                                <strong>10.00%</strong>
                            </div>
                        </div>
                        <div className='matches-pro__verdict'>{stats.summary.verdict}</div>
                        <div className='matches-pro__mini'>
                            Last 100: {pct(stats.summary.recent_accuracy)}, longest hit streak{' '}
                            {stats.state.longest_win}, longest miss streak {stats.state.longest_loss}
                        </div>
                        {Object.keys(stats.state.by_quality).length > 0 && (
                            <div className='matches-pro__mini'>
                                {Object.entries(stats.state.by_quality).map(([q, v]) => (
                                    <span key={q} className='matches-pro__tag'>
                                        {q}: {v.correct}/{v.n} ({v.n ? ((v.correct / v.n) * 100).toFixed(1) : '0.0'}%)
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}

                <div className='matches-pro__section-title'>Signal feed</div>
                <div className='matches-pro__feed'>
                    {feed.map(f => (
                        <div key={f.t} className={`matches-pro__feed-row ${f.hit ? 'hit' : 'miss'}`}>
                            <span>{clockOf(f.t)}</span>
                            <span>MATCH {f.predicted}</span>
                            <span>actual {f.actual}</span>
                            <span>{f.quality}</span>
                            <span>{f.hit ? 'HIT' : 'miss'}</span>
                        </div>
                    ))}
                    {!feed.length && <span className='matches-pro__muted'>Waiting for the next tick...</span>}
                </div>

                <div className='matches-pro__section-title'>Digit distribution - last {sample.length} ticks</div>
                <div className='matches-pro__dist'>
                    {distribution.map(d => (
                        <div key={d.digit} className='matches-pro__row'>
                            <span className={`matches-pro__row-digit ${d.digit === predicted ? 'is-predicted' : ''}`}>
                                {d.digit}
                            </span>
                            <span className='matches-pro__bar'>
                                <span style={{ width: `${(d.p / max_pct) * 100}%` }} />
                            </span>
                            <span className='matches-pro__row-pct'>{d.p.toFixed(1)}%</span>
                        </div>
                    ))}
                </div>

                {diag && (
                    <div className='matches-pro__diag'>
                        socket {diag.ready_state} | messages {diag.messages} | last {diag.last_msg_type} | symbols{' '}
                        {diag.symbols_seen} | precision {diag.pip_source} ({diag.known_decimals} known)
                        {diag.last_error ? ` | ${diag.last_error}` : ''}
                    </div>
                )}

                <div className='matches-pro__note'>
                    The engine grades every prediction it makes, including the ones it labels NO SIGNAL. Expect the
                    accuracy to converge on 10%. At a {payout}x payout you need {pct(1 / payout)} just to break even,
                    so a strategy can be genuinely above 10% and still lose money. Trading stays disabled until this
                    panel has hundreds of graded predictions behind it.
                </div>
            </div>
        </div>
    );
};

export default MatchesPro;
'@

$stylesSrc = @'
.matches-pro {
    height: var(--tab-content-height);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 1.6rem 1.6rem 14rem;
    background: radial-gradient(1200px 500px at 85% -10%, rgba(212, 175, 55, 0.12), transparent 60%),
        linear-gradient(180deg, #0a0e17 0%, #0c1120 55%, #0a0e17 100%);

    &__panel {
        max-width: 640px;
        margin: 0 auto;
        padding: 1.8rem;
        border-radius: 1.6rem;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(212, 175, 55, 0.28);
    }

    &__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
    }

    &__title {
        color: #e8cf7a;
        font-size: 2rem;
        font-weight: 800;
        letter-spacing: 0.04em;
    }

    &__subtitle {
        color: #9aa1b0;
        font-size: 1.2rem;
        margin: 0.4rem 0 1.4rem;
    }

    &__status {
        flex-shrink: 0;
        font-size: 1.1rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 0.5rem 0.9rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;

        &--live {
            color: #34d399;
            border-color: rgba(52, 211, 153, 0.4);
        }

        &--reconnecting,
        &--connecting {
            color: #fbbf24;
            border-color: rgba(245, 158, 11, 0.4);
        }

        &--disconnected {
            color: #f87171;
            border-color: rgba(248, 113, 113, 0.4);
        }
    }

    &__dot {
        width: 0.8rem;
        height: 0.8rem;
        border-radius: 50%;
        background: currentColor;
    }

    &__warn {
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.4);
        color: #fbbf24;
        border-radius: 1rem;
        padding: 1rem;
        font-size: 1.2rem;
        margin-bottom: 1.2rem;
    }

    &__controls {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 1.4rem;
    }

    &__field {
        flex: 1 1 200px;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;

        span {
            color: #9aa1b0;
            font-size: 1.1rem;
        }

        select,
        input {
            background: rgba(10, 14, 23, 0.9);
            border: 1px solid rgba(212, 175, 55, 0.3);
            color: #e8eaf0;
            border-radius: 0.8rem;
            padding: 0.9rem 1rem;
            font-size: 1.3rem;
        }
    }

    &__readout {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.8rem;
        margin-bottom: 1.6rem;

        @media (max-width: 600px) {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    &__stat {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 1rem;
        padding: 0.9rem;
        text-align: center;

        span {
            display: block;
            color: #9aa1b0;
            font-size: 1rem;
            margin-bottom: 0.3rem;
        }

        strong {
            color: #e8eaf0;
            font-size: 1.6rem;
            font-weight: 700;
        }
    }

    &__digit {
        color: #e8cf7a !important;
        font-size: 2.4rem !important;
    }

    &__section-title {
        color: #e8cf7a;
        font-size: 1.2rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        margin: 1.6rem 0 0.8rem;
    }

    &__dist {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    &__row {
        display: flex;
        align-items: center;
        gap: 0.8rem;
    }

    &__row-digit {
        width: 1.6rem;
        color: #e8eaf0;
        font-size: 1.3rem;
        font-weight: 700;
        text-align: center;
    }

    &__bar {
        flex: 1;
        height: 1.2rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 999px;
        overflow: hidden;

        span {
            display: block;
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(212, 175, 55, 0.5), #e8cf7a);
            transition: width 0.25s ease;
        }
    }

    &__row-pct {
        width: 4.6rem;
        text-align: right;
        color: #cbd5e1;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__recent {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    &__chip {
        min-width: 2.4rem;
        text-align: center;
        padding: 0.4rem 0.5rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #e8eaf0;
        font-size: 1.2rem;
        font-variant-numeric: tabular-nums;
    }

    &__muted {
        color: #6b7280;
        font-size: 1.2rem;
    }

    &__diag {
        margin-top: 1.6rem;
        padding: 0.8rem 1rem;
        border-radius: 0.8rem;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #7c8698;
        font-family: monospace;
        font-size: 1rem;
        line-height: 1.5;
        word-break: break-word;
    }

    &__signal {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1.2rem;
        padding: 1.4rem;
        border-radius: 1.2rem;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.1);

        &--strong { border-color: rgba(52, 211, 153, 0.55); }
        &--medium { border-color: rgba(212, 175, 55, 0.55); }
        &--weak { border-color: rgba(245, 158, 11, 0.45); }
        &--no-signal { border-color: rgba(148, 163, 184, 0.3); }
    }

    &__signal-main {
        display: flex;
        align-items: center;
        gap: 1.2rem;
    }

    &__signal-digit {
        width: 6rem;
        height: 6rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 1.2rem;
        background: rgba(212, 175, 55, 0.12);
        border: 1px solid rgba(212, 175, 55, 0.35);
        color: #e8cf7a;
        font-size: 3.2rem;
        font-weight: 800;
    }

    &__signal-quality {
        color: #e8eaf0;
        font-size: 1.6rem;
        font-weight: 800;
        letter-spacing: 0.05em;
    }

    &__signal-sub {
        color: #9aa1b0;
        font-size: 1.1rem;
        margin-top: 0.3rem;
    }

    &__signal-nums {
        display: flex;
        gap: 1.6rem;

        span {
            display: block;
            color: #9aa1b0;
            font-size: 1rem;
        }

        strong {
            color: #e8eaf0;
            font-size: 1.5rem;
        }
    }

    &__link {
        margin-top: 0.8rem;
        background: none;
        border: none;
        color: #e8cf7a;
        font-size: 1.2rem;
        text-decoration: underline;
        cursor: pointer;
        padding: 0;
    }

    &__why {
        margin-top: 0.8rem;
        padding: 1.2rem;
        border-radius: 1rem;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #cbd5e1;
        font-size: 1.2rem;
        line-height: 1.55;

        table { width: 100%; margin: 1rem 0; border-collapse: collapse; }
        td { padding: 0.35rem 0; font-size: 1.15rem; }
        td.pos { color: #34d399; text-align: right; font-variant-numeric: tabular-nums; }
        td.neg { color: #f87171; text-align: right; font-variant-numeric: tabular-nums; }
        td.note { color: #6b7280; text-align: right; font-size: 1rem; padding-left: 1rem; }
    }

    &__why-foot {
        color: #7c8698;
        font-size: 1.05rem;
    }

    &__reset {
        float: right;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #cbd5e1;
        border-radius: 0.6rem;
        padding: 0.3rem 0.9rem;
        font-size: 1rem;
        cursor: pointer;
        text-transform: none;
        letter-spacing: 0;
    }

    &__verdict {
        padding: 0.9rem 1.1rem;
        border-radius: 0.9rem;
        background: rgba(148, 163, 184, 0.1);
        border: 1px solid rgba(148, 163, 184, 0.25);
        color: #cbd5e1;
        font-size: 1.2rem;
        line-height: 1.5;
    }

    &__mini {
        margin-top: 0.7rem;
        color: #9aa1b0;
        font-size: 1.1rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
    }

    &__tag {
        padding: 0.2rem 0.7rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    &__feed {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-family: monospace;
        font-size: 1.1rem;
    }

    &__feed-row {
        display: grid;
        grid-template-columns: auto auto auto 1fr auto;
        gap: 0.8rem;
        padding: 0.45rem 0.8rem;
        border-radius: 0.6rem;
        background: rgba(255, 255, 255, 0.03);
        color: #9aa1b0;

        &.hit { color: #34d399; background: rgba(52, 211, 153, 0.08); }
        &.miss { color: #8b93a3; }
    }

    &__row-digit.is-predicted {
        color: #e8cf7a;
    }

    &__note {
        margin-top: 1.8rem;
        padding: 1rem;
        border-radius: 1rem;
        background: rgba(148, 163, 184, 0.08);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: #9aa1b0;
        font-size: 1.1rem;
        line-height: 1.5;
    }
}
'@

Info ''
Info '[1/3] Writing Phase 2 files'
Write-File 'src/components/shared/nlb/matches-engine.ts' $engineSrc
Write-File 'src/components/shared/nlb/backtest-store.ts' $storeSrc
Write-File 'src/pages/matches-pro/matches-pro.tsx'       $pageSrc
Write-File 'src/pages/matches-pro/matches-pro.scss'      $stylesSrc

$ErrorActionPreference = 'Continue'

Info ''
if ($SkipBuild) {
    Info '[2/3] Build skipped (-SkipBuild)'
} else {
    Info '[2/3] Running npm run build (a few minutes)'
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host ''; Fail 'Build failed. Nothing committed. Send me the first red error block.' }
    Ok 'build succeeded'
}

Info ''
Info '[3/3] Commit and push'
git add -A
git commit -m "Matches Pro Phase 2: statistical prediction engine and live backtest"
if ($LASTEXITCODE -ne 0) { Info 'Nothing new to commit.' }

if ($NoPush) {
    Info 'Push skipped (-NoPush). Run: git push'
} else {
    git push
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Ok 'pushed - Vercel will start the deployment now'
}

Write-Host ''
Write-Host 'Done. Hard refresh Matches Pro (Ctrl+Shift+R) once Vercel is green.' -ForegroundColor Yellow
