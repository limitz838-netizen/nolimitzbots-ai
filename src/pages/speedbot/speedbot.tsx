// @ts-nocheck — Nolimitz AI replaces the legacy Speedbot UI while preserving
// the proven Deriv execution / settlement plumbing underneath.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { api_base, MessageTypes } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { playLoss, playWin, unlockAudio } from '@/components/shared/nlb/trade-sounds';
import { trackContracts, describeError } from '@/components/shared/nlb/settlement';
import { contract_stages } from '@/constants/contract-stage';
import {
    analyzeDigitMarket,
    candidateToContract,
    NOLIMITZ_AI_ENGINE_VERSION,
} from '@/components/shared/nlb/nolimitz-ai-engine';
import {
    readAiEvidence,
    recordAiEvidence,
    setupEvidence,
    topAiSetups,
} from '@/components/shared/nlb/nolimitz-ai-evidence';
import Guide, { GuideButton } from '@/components/shared/nlb/guide';
import './speedbot.scss';

const MARKETS = [
    { code: '1HZ100V', label: 'Vol 100 (1s)' },
    { code: '1HZ75V', label: 'Vol 75 (1s)' },
    { code: '1HZ50V', label: 'Vol 50 (1s)' },
    { code: '1HZ25V', label: 'Vol 25 (1s)' },
    { code: '1HZ10V', label: 'Vol 10 (1s)' },
    { code: 'R_100', label: 'Vol 100' },
    { code: 'R_75', label: 'Vol 75' },
    { code: 'R_50', label: 'Vol 50' },
    { code: 'R_25', label: 'Vol 25' },
    { code: 'R_10', label: 'Vol 10' },
];

const FALLBACK_DECIMALS = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
};

const STRATEGIES = [
    { id: 'alpha', label: 'Alpha', note: 'Demo execution test — one controlled contract' },
    { id: 'quantum', label: 'Quantum', note: '2-model consensus + fresh forward evidence' },
    { id: 'apex', label: 'Apex', note: '3-model consensus + stricter evidence gate' },
];

const AI_RULES = {
    quantum: { minTier: 2, minEvidence: 20, margin: 0.005 },
    apex: { minTier: 3, minEvidence: 35, margin: 0.01 },
};

const familyForContract = contract =>
    contract === 'even_odd' ? 'even_odd' : contract === 'over_under' ? 'over_under' : null;

const CONTRACTS = [
    { id: 'rise_fall', label: 'Rise/Fall', symbol: '↕', available: true },
    { id: 'even_odd', label: 'Even/Odd', symbol: '#', available: true },
    { id: 'match', label: 'Match', symbol: '=', available: false, note: 'Matches Pro' },
    { id: 'over_under', label: 'Over/Under', symbol: '⌃', available: true, recommended: true },
    { id: 'differ', label: 'Differ', symbol: '/', available: false, note: 'Coming next' },
    { id: 'mix', label: 'Mix', symbol: '⌁', available: false, note: 'Coming next' },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const maxMartingaleSteps = risk => (risk === 'high' ? 4 : risk === 'medium' ? 2 : 0);

const NolimitzAI = observer(() => {
    const { client, run_panel, transactions, summary_card, journal } = useStore();
    const is_logged_in = !!client?.is_logged_in;
    const loginid = client?.loginid || 'NOT CONNECTED';
    const currency = client?.currency || 'USD';
    const balance = Number(client?.balance ?? 0);
    const is_demo = loginid.startsWith('VRT') || loginid.startsWith('VRTC');
    const account_mode = !is_logged_in ? 'offline' : is_demo ? 'demo' : 'real';

    const [symbol, setSymbol] = React.useState('1HZ100V');
    const [strategy, setStrategy] = React.useState('quantum');
    const [contract, setContract] = React.useState('over_under');
    const [direction, setDirection] = React.useState('over');
    const [risk, setRisk] = React.useState('low');
    const [duration, setDuration] = React.useState(1);
    const [stake, setStake] = React.useState('0.5');
    const [tp, setTp] = React.useState('10');
    const [sl, setSl] = React.useState('5');
    const [optimization, setOptimization] = React.useState(true);
    const [martingale, setMartingale] = React.useState(false);
    const [mult, setMult] = React.useState('1.5');

    const [digits, setDigits] = React.useState([]);
    const [quote, setQuote] = React.useState(null);
    const [running, setRunning] = React.useState(false);
    const [engineAnalysis, setEngineAnalysis] = React.useState(null);
    const [evidenceState, setEvidenceState] = React.useState(() => readAiEvidence('1HZ100V', 'over_under'));
    const [gateInfo, setGateInfo] = React.useState({
        status: 'SHADOW',
        reason: 'Collecting measured setup evidence.',
        breakeven: null,
        required: null,
    });
    const [stats, setStats] = React.useState({
        ticks: 0,
        last_digit: null,
        pnl: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        cur_stake: 0,
    });
    const [logs, setLogs] = React.useState([]);
    const [result, setResult] = React.useState(null);
    const [guide_open, setGuideOpen] = React.useState(false);

    const run_ref = React.useRef(null);
    const settle_handles_ref = React.useRef(new Set());
    const ws_ref = React.useRef(null);
    const decimals_ref = React.useRef({ ...FALLBACK_DECIMALS });
    const sym_ref = React.useRef(symbol);
    const contract_ref = React.useRef(contract);
    const digits_ref = React.useRef([]);
    const engine_ref = React.useRef(null);
    const pending_shadow_ref = React.useRef(null);
    const last_shadow_fingerprint_ref = React.useRef(null);
    const last_traded_fingerprint_ref = React.useRef(null);
    const last_gate_reason_ref = React.useRef('');
    sym_ref.current = symbol;
    contract_ref.current = contract;

    const log = line =>
        setLogs(prev => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 50));

    const journalLog = (message, type = MessageTypes.SUCCESS) => {
        try {
            journal?.pushMessage?.(message, type, 'journal__text');
        } catch {
            /* journal mirroring must not interrupt execution */
        }
    };

    const publishAnalysis = (history, family) => {
        if (!family) {
            engine_ref.current = null;
            setEngineAnalysis(null);
            return null;
        }
        const next = analyzeDigitMarket(history, family);
        engine_ref.current = next;
        setEngineAnalysis(next);
        return next;
    };

    React.useEffect(() => {
        let alive = true;
        const ws = new WebSocket(isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING);
        ws_ref.current = ws;

        const subscribe = () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            setDigits([]);
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(
                JSON.stringify({
                    ticks_history: sym_ref.current,
                    count: 1000,
                    end: 'latest',
                    style: 'ticks',
                    subscribe: 1,
                })
            );
        };

        ws.onopen = () => {
            if (!alive) return;
            ws.send(JSON.stringify({ active_symbols: 'brief' }));
            subscribe();
        };

        ws.onmessage = msg => {
            if (!alive) return;
            let data;
            try {
                data = JSON.parse(msg.data);
            } catch {
                return;
            }

            if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
                data.active_symbols.forEach(s => {
                    const code = s.symbol || s.underlying_symbol;
                    if (code && typeof s.pip === 'number') {
                        decimals_ref.current[code] = `${s.pip}`.split('.')[1]?.length ?? 0;
                    }
                });
                return;
            }

            if (data.msg_type === 'history' && data.echo_req?.ticks_history === sym_ref.current) {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const prices = data.history?.prices || [];
                const ds = prices.map(pr => Number(Number(pr).toFixed(dec).slice(-1))).slice(-1000);
                digits_ref.current = ds;
                setDigits(ds);
                if (prices.length) setQuote(Number(prices[prices.length - 1]).toFixed(dec));

                const family = familyForContract(contract_ref.current);
                const analysis = publishAnalysis(ds, family);
                if (family && analysis?.candidate && analysis?.fingerprint) {
                    last_shadow_fingerprint_ref.current = analysis.fingerprint;
                    pending_shadow_ref.current = {
                        symbol: sym_ref.current,
                        family,
                        fingerprint: analysis.fingerprint,
                        side: analysis.candidate,
                        tier: analysis.agreementTier,
                        models: analysis.agreementModels || [],
                        estimate: analysis.estimate,
                    };
                }
                return;
            }

            if (data.msg_type === 'tick' && data.tick?.symbol === sym_ref.current) {
                const dec = decimals_ref.current[sym_ref.current] ?? 2;
                const q = Number(data.tick.quote).toFixed(dec);
                const d = Number(q.slice(-1));
                setQuote(q);

                const pending = pending_shadow_ref.current;
                if (pending && pending.symbol === sym_ref.current) {
                    const updatedEvidence = recordAiEvidence(pending.symbol, pending.family, {
                        ...pending,
                        actual: d,
                        t: Date.now(),
                    });
                    setEvidenceState(updatedEvidence);
                }
                pending_shadow_ref.current = null;

                const nextDigits = [...digits_ref.current, d].slice(-1000);
                digits_ref.current = nextDigits;
                setDigits(nextDigits);
                setStats(prev => ({ ...prev, ticks: prev.ticks + 1, last_digit: d }));

                const family = familyForContract(contract_ref.current);
                const analysis = publishAnalysis(nextDigits, family);

                if (analysis?.candidate && analysis?.fingerprint) {
                    if (analysis.fingerprint !== last_shadow_fingerprint_ref.current) {
                        last_shadow_fingerprint_ref.current = analysis.fingerprint;
                        pending_shadow_ref.current = {
                            symbol: sym_ref.current,
                            family,
                            fingerprint: analysis.fingerprint,
                            side: analysis.candidate,
                            tier: analysis.agreementTier,
                            models: analysis.agreementModels || [],
                            estimate: analysis.estimate,
                        };
                    }
                } else {
                    last_shadow_fingerprint_ref.current = null;
                }
            }
        };

        const resub = () => subscribe();
        window.addEventListener('nlb-ai-symbol', resub);

        return () => {
            alive = false;
            window.removeEventListener('nlb-ai-symbol', resub);
            if (run_ref.current) run_ref.current.active = false;
            settle_handles_ref.current.forEach(h => h.cancel());
            settle_handles_ref.current.clear();
            try {
                ws.close();
            } catch {
                /* noop */
            }
        };
    }, []);

    const selectedFamily = familyForContract(contract);

    React.useEffect(() => {
        pending_shadow_ref.current = null;
        last_shadow_fingerprint_ref.current = null;
        last_traded_fingerprint_ref.current = null;
        last_gate_reason_ref.current = '';
        const family = familyForContract(contract);
        if (family) {
            setEvidenceState(readAiEvidence(symbol, family));
            publishAnalysis(digits_ref.current, family);
        } else {
            setEvidenceState({ total: 0, correct: 0, by_setup: {}, by_tier: {}, recent: [] });
            engine_ref.current = null;
            setEngineAnalysis(null);
        }
    }, [symbol, contract]);

    const evenCount = digits.filter(d => d % 2 === 0).length;
    const evenPct = digits.length ? (100 * evenCount) / digits.length : 50;
    const over2Pct = digits.length ? (100 * digits.filter(d => d > 2).length) / digits.length : 70;
    const under7Pct = digits.length ? (100 * digits.filter(d => d < 7).length) / digits.length : 70;

    const manualContractSpec = React.useMemo(() => {
        if (contract === 'rise_fall') {
            return direction === 'fall' ? { type: 'PUT', label: 'Fall' } : { type: 'CALL', label: 'Rise' };
        }
        if (contract === 'even_odd') {
            return direction === 'odd'
                ? { type: 'DIGITODD', label: 'Odd' }
                : { type: 'DIGITEVEN', label: 'Even' };
        }
        if (contract === 'over_under') {
            return direction === 'under'
                ? { type: 'DIGITUNDER', label: 'Under 7', barrier: 7 }
                : { type: 'DIGITOVER', label: 'Over 2', barrier: 2 };
        }
        return null;
    }, [contract, direction]);

    const aiContractSpec = React.useMemo(
        () => (selectedFamily && engineAnalysis?.candidate
            ? candidateToContract(selectedFamily, engineAnalysis.candidate)
            : null),
        [selectedFamily, engineAnalysis]
    );

    const contractSpec = strategy === 'alpha' ? manualContractSpec : aiContractSpec;
    const exactSetupEvidence = React.useMemo(
        () => setupEvidence(evidenceState, engineAnalysis?.fingerprint),
        [evidenceState, engineAnalysis?.fingerprint]
    );
    const bestSetups = React.useMemo(() => topAiSetups(evidenceState, 5), [evidenceState]);

    const settleContract = (contract_id, durationTicks = 1) =>
        new Promise(resolve => {
            const handle = trackContracts([contract_id], {
                timeoutMs: (durationTicks + 30) * 1000,
                onContract: contractUpdate => {
                    try {
                        transactions?.onBotContractEvent?.(contractUpdate);
                        summary_card?.onBotContractEvent?.(contractUpdate);
                        run_panel?.onBotContractEvent?.(contractUpdate);
                    } catch {
                        /* Bot Builder mirroring must never interrupt settlement */
                    }
                },
                onDone: ({ profits, settled }) => {
                    settle_handles_ref.current.delete(handle);
                    try {
                        run_panel?.setHasOpenContract?.(false);
                        run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
                    } catch {
                        /* noop */
                    }
                    const values = Object.values(profits);
                    resolve(settled > 0 ? values[0] : null);
                },
            });
            settle_handles_ref.current.add(handle);
        });

    const prepareProposal = async (spec, amount, durationTicks = 1) => {
        const req = {
            proposal: 1,
            amount,
            basis: 'stake',
            contract_type: spec.type,
            currency,
            duration: durationTicks,
            duration_unit: 't',
            underlying_symbol: symbol,
            ...(spec.barrier !== undefined ? { barrier: String(spec.barrier) } : {}),
        };
        const response = await api_base.api.send(req);
        const proposal = response?.proposal;
        const ask = Number(proposal?.ask_price ?? amount);
        const payout = Number(proposal?.payout ?? 0);
        if (!proposal?.id || !(ask > 0) || !(payout > 0)) throw new Error('Invalid live proposal');
        return {
            id: proposal.id,
            ask,
            payout,
            breakeven: ask / payout,
            proposal,
        };
    };

    const buyPrepared = async prepared => {
        try {
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
        } catch {
            /* noop */
        }
        const res = await api_base.api.send({ buy: prepared.id, price: prepared.ask });
        const contractId = res?.buy?.contract_id;
        if (!contractId) throw new Error('No contract id returned');
        try {
            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
        } catch {
            /* noop */
        }
        return contractId;
    };


    const reportGate = next => {
        setGateInfo(next);
        if (next?.reason && next.reason !== last_gate_reason_ref.current) {
            last_gate_reason_ref.current = next.reason;
            log(next.reason);
        }
    };

    const applyTradeResult = (r, profit, baseStake, multiplier, maxSteps) => {
        const won = profit > 0;
        r.trades += 1;
        r.pnl += profit;

        if (won) {
            r.wins += 1;
            r.steps = 0;
            r.curStake = baseStake;
        } else {
            r.losses += 1;
            if (martingale && maxSteps > 0) {
                r.steps += 1;
                if (r.steps > maxSteps) {
                    r.steps = 0;
                    r.curStake = baseStake;
                } else {
                    r.curStake = Math.min(r.curStake * multiplier, baseStake * 10);
                }
            } else {
                r.curStake = baseStake;
            }
        }

        setStats(prev => ({
            ...prev,
            pnl: r.pnl,
            trades: r.trades,
            wins: r.wins,
            losses: r.losses,
            cur_stake: r.curStake,
        }));

        const resultLine =
            (won ? 'WIN ' : 'LOSS ') +
            (profit >= 0 ? '+' : '') +
            profit.toFixed(2) +
            ' · P/L ' +
            r.pnl.toFixed(2);

        log(resultLine);
        journalLog(
            'Nolimitz AI · ' +
                (won ? 'WIN' : 'LOSS') +
                ' · ' +
                (profit >= 0 ? '+' : '') +
                profit.toFixed(2) +
                ' ' +
                currency,
            MessageTypes.SUCCESS
        );
        return won;
    };

    const stopRun = (reason, r) => {
        if (!r) return;
        r.active = false;
        run_ref.current = null;
        setRunning(false);

        try {
            run_panel?.setIsRunning?.(false);
            if (!run_panel?.has_open_contract) {
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        } catch {
            /* noop */
        }

        if (reason) {
            const won = r.pnl >= 0;
            if (won) playWin();
            else playLoss();
            setResult({ reason, pnl: r.pnl, trades: r.trades, wins: r.wins, losses: r.losses });
            journalLog(
                'Nolimitz AI stopped · ' +
                    reason +
                    ' · session P/L ' +
                    r.pnl.toFixed(2) +
                    ' ' +
                    currency
            );
        }
    };

    const start = async () => {
        if (running || !is_logged_in || !api_base?.api) return;

        if (!is_demo) {
            reportGate({
                status: 'BLOCKED',
                reason: 'Demo validation only — switch to a Deriv demo account before running Nolimitz AI.',
                breakeven: null,
                required: null,
            });
            journalLog('Nolimitz AI blocked: demo account required.', MessageTypes.ERROR);
            return;
        }

        if (strategy !== 'alpha' && !selectedFamily) {
            reportGate({
                status: 'BLOCKED',
                reason: 'Quantum/Apex currently validate Even/Odd and Over/Under only. Use Alpha for a Rise/Fall execution test.',
                breakeven: null,
                required: null,
            });
            return;
        }

        const baseStake = Math.max(0.35, parseFloat(stake) || 0.5);
        const tpValue = Math.max(0, parseFloat(tp) || 0);
        const slValue = Math.max(0, parseFloat(sl) || 0);
        const multiplier = clamp(parseFloat(mult) || 1.5, 1, 3);
        const maxSteps = maxMartingaleSteps(risk);

        unlockAudio();
        setResult(null);
        setLogs([]);
        last_traded_fingerprint_ref.current = null;
        last_gate_reason_ref.current = '';

        const r = {
            active: true,
            pnl: 0,
            trades: 0,
            wins: 0,
            losses: 0,
            curStake: baseStake,
            steps: 0,
        };

        run_ref.current = r;
        setRunning(true);

        try {
            run_panel.run_id = 'nolimitz-ai-' + Date.now();
            summary_card?.clear?.();
            run_panel?.setContractStage?.(contract_stages.STARTING);
            run_panel?.setIsRunning?.(true);
            run_panel?.toggleDrawer?.(true);
        } catch {
            /* noop */
        }

        log(
            'Nolimitz AI started · ' +
                STRATEGIES.find(x => x.id === strategy)?.label +
                ' · ' +
                symbol
        );
        journalLog(
            'Nolimitz AI started · ' +
                STRATEGIES.find(x => x.id === strategy)?.label +
                ' · ' +
                symbol +
                ' · DEMO'
        );

        if (strategy === 'alpha') {
            if (!manualContractSpec) {
                stopRun('No supported Alpha contract selected', r);
                return;
            }

            try {
                reportGate({
                    status: 'TEST',
                    reason: 'Alpha demo execution test: preparing one real Deriv proposal.',
                    breakeven: null,
                    required: null,
                });

                const prepared = await prepareProposal(manualContractSpec, baseStake, duration);
                setGateInfo({
                    status: 'TEST',
                    reason:
                        'Live proposal ready · break-even ' +
                        (prepared.breakeven * 100).toFixed(2) +
                        '%',
                    breakeven: prepared.breakeven,
                    required: prepared.breakeven,
                });

                const cid = await buyPrepared(prepared);
                journalLog(
                    'Alpha demo test bought ' +
                        manualContractSpec.label +
                        ' · contract ' +
                        cid
                );

                const profit = await settleContract(cid, duration);
                if (profit === null) {
                    stopRun('Alpha demo execution test settlement timeout', r);
                    return;
                }

                applyTradeResult(r, profit, baseStake, multiplier, maxSteps);
                stopRun('Alpha demo execution test complete', r);
            } catch (e) {
                const message = describeError(e);
                journalLog('Nolimitz AI Alpha error · ' + message, MessageTypes.ERROR);
                stopRun('Alpha test failed: ' + message, r);
            }
            return;
        }

        const rules = AI_RULES[strategy];

        while (r.active) {
            if (tpValue > 0 && r.pnl >= tpValue) {
                stopRun('Profit target reached', r);
                return;
            }

            if (slValue > 0 && r.pnl <= -slValue) {
                stopRun('Maximum loss reached', r);
                return;
            }

            const analysis = engine_ref.current;

            if (!analysis?.candidate || !analysis?.fingerprint) {
                reportGate({
                    status: 'SHADOW',
                    reason: analysis?.reason || 'Waiting for measured model consensus.',
                    breakeven: null,
                    required: null,
                });
                await new Promise(res => setTimeout(res, 800));
                continue;
            }

            if (analysis.agreementTier < rules.minTier) {
                reportGate({
                    status: 'SHADOW',
                    reason:
                        strategy.toUpperCase() +
                        ' needs ' +
                        rules.minTier +
                        ' agreeing models; current setup has ' +
                        analysis.agreementTier +
                        '.',
                    breakeven: null,
                    required: null,
                });
                await new Promise(res => setTimeout(res, 800));
                continue;
            }

            const latestEvidence = readAiEvidence(symbol, selectedFamily);
            setEvidenceState(latestEvidence);
            const exact = setupEvidence(latestEvidence, analysis.fingerprint);

            if (exact.n < rules.minEvidence) {
                reportGate({
                    status: 'SHADOW',
                    reason:
                        'Shadow validating exact setup: ' +
                        exact.n +
                        '/' +
                        rules.minEvidence +
                        ' independent forward results.',
                    breakeven: null,
                    required: null,
                });
                await new Promise(res => setTimeout(res, 800));
                continue;
            }

            if (last_traded_fingerprint_ref.current === analysis.fingerprint) {
                reportGate({
                    status: 'COOLDOWN',
                    reason: 'This fingerprint has already been traded. Waiting for the market state to change.',
                    breakeven: null,
                    required: null,
                });
                await new Promise(res => setTimeout(res, 800));
                continue;
            }

            const liveSpec = candidateToContract(selectedFamily, analysis.candidate);

            try {
                const prepared = await prepareProposal(liveSpec, Number(r.curStake.toFixed(2)), 1);
                const required = prepared.breakeven + rules.margin;

                if (!(exact.lowerBound > required)) {
                    reportGate({
                        status: 'SHADOW',
                        reason:
                            'No trade · exact setup lower bound ' +
                            (exact.lowerBound * 100).toFixed(2) +
                            '% must beat live break-even + margin ' +
                            (required * 100).toFixed(2) +
                            '%.',
                        breakeven: prepared.breakeven,
                        required,
                    });
                    await new Promise(res => setTimeout(res, 1000));
                    continue;
                }

                setGateInfo({
                    status: 'TRADE READY',
                    reason:
                        analysis.agreementTier +
                        '-model consensus · ' +
                        exact.correct +
                        '/' +
                        exact.n +
                        ' fresh correct · LB ' +
                        (exact.lowerBound * 100).toFixed(2) +
                        '% > ' +
                        (required * 100).toFixed(2) +
                        '% required.',
                    breakeven: prepared.breakeven,
                    required,
                });

                last_traded_fingerprint_ref.current = analysis.fingerprint;
                setStats(prev => ({ ...prev, cur_stake: r.curStake }));

                const cid = await buyPrepared(prepared);

                log(
                    'AI TRADE · ' +
                        liveSpec.label +
                        ' · ' +
                        currency +
                        ' ' +
                        r.curStake.toFixed(2) +
                        ' · LB ' +
                        (exact.lowerBound * 100).toFixed(2) +
                        '%'
                );

                journalLog(
                    'Nolimitz AI trade · ' +
                        liveSpec.label +
                        ' · ' +
                        currency +
                        ' ' +
                        r.curStake.toFixed(2) +
                        ' · contract ' +
                        cid
                );

                const profit = await settleContract(cid, 1);
                if (profit === null) {
                    journalLog('Nolimitz AI settlement timeout.', MessageTypes.ERROR);
                    continue;
                }

                applyTradeResult(r, profit, baseStake, multiplier, maxSteps);
            } catch (e) {
                const message = describeError(e);
                log('Trade error · ' + message);
                journalLog('Nolimitz AI trade error · ' + message, MessageTypes.ERROR);
                await new Promise(res => setTimeout(res, 1500));
            }

            await new Promise(
                res =>
                    setTimeout(
                        res,
                        risk === 'high' ? 450 : risk === 'medium' ? 800 : 1200
                    )
            );
        }
    };

    const stop = () => {
        log('Stopped by user');
        const r = run_ref.current;
        if (r) r.active = false;
        run_ref.current = null;
        setRunning(false);

        try {
            run_panel?.setIsRunning?.(false);
            if (!run_panel?.has_open_contract) {
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        } catch {
            /* noop */
        }

        journalLog('Nolimitz AI stopped by user.');
    };

    const currentStrategy = STRATEGIES.find(x => x.id === strategy);
    const winRate = stats.trades ? (100 * stats.wins) / stats.trades : 0;

    return (
        <div className='nolimitz-ai'>
            <div className='nolimitz-ai__shell'>
                <div className='nolimitz-ai__hero'>
                    <div>
                        <span className='nolimitz-ai__eyebrow'>NOLIMITZBOTS</span>
                        <h1><span>Nolimitz AI</span> Trading Dashboard</h1>
                        <p>Automated Deriv execution with live controls, strategy filters and session risk limits.</p>
                    </div>
                    <GuideButton onClick={() => setGuideOpen(true)} />
                </div>
                <Guide tool='speedbot' open={guide_open} onClose={() => setGuideOpen(false)} />

                <section className='nolimitz-ai__account'>
                    <div className='nolimitz-ai__account-top'>
                        <div className='nolimitz-ai__account-id'>
                            <div className='nolimitz-ai__avatar'>NL</div>
                            <div>
                                <small>CONNECTED ACCOUNT</small>
                                <strong>{loginid}</strong>
                            </div>
                        </div>
                        <span className={`nolimitz-ai__account-type ${account_mode}`}>
                            <i /> {!is_logged_in ? 'OFFLINE' : is_demo ? 'DEMO' : 'REAL'}
                        </span>
                    </div>
                    <div className='nolimitz-ai__balance'>
                        <small>LIVE BALANCE</small>
                        <strong>{balance.toFixed(2)} <span>{currency}</span></strong>
                        <div className='nolimitz-ai__live-dot'>● <span>LIVE</span></div>
                    </div>
                </section>

                {!is_logged_in && (
                    <div className='nolimitz-ai__warning'>Connect your Deriv account before starting Nolimitz AI.</div>
                )}
                {is_logged_in && !is_demo && (
                    <div className='nolimitz-ai__warning'>
                        DEMO VALIDATION PHASE — switch to a Deriv demo account to run or test Nolimitz AI.
                    </div>
                )}

                <section className='nolimitz-ai__card nolimitz-ai__card--engine'>
                    <div className='nolimitz-ai__card-head'>
                        <div className='nolimitz-ai__brand-icon'>✦</div>
                        <div>
                            <span className='nolimitz-ai__tag'>NOLIMITZ AI</span>
                            <h2>Automated Trading Engine</h2>
                        </div>
                        <span className='nolimitz-ai__mode-badge'>{running ? 'RUNNING' : 'READY'}</span>
                    </div>

                    <div className='nolimitz-ai__field-label'>MARKET</div>
                    <div className='nolimitz-ai__market-row'>
                        <select
                            value={symbol}
                            disabled={running}
                            onChange={e => {
                                setSymbol(e.target.value);
                                setTimeout(() => window.dispatchEvent(new Event('nlb-ai-symbol')), 0);
                            }}
                        >
                            {MARKETS.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
                        </select>
                        <div className='nolimitz-ai__quote'>
                            <small>LIVE TICK</small>
                            <strong>{quote ?? '—'}</strong>
                        </div>
                    </div>

                    <div className='nolimitz-ai__field-label'>TRADING STRATEGY</div>
                    <div className='nolimitz-ai__segmented'>
                        {STRATEGIES.map(s => (
                            <button
                                key={s.id}
                                disabled={running}
                                className={strategy === s.id ? 'active' : ''}
                                onClick={() => setStrategy(s.id)}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                    <div className='nolimitz-ai__strategy-note'>
                        {currentStrategy?.note}
                    </div>

                    <div className='nolimitz-ai__engine-panel'>
                        <div>
                            <span>ENGINE</span>
                            <strong>{NOLIMITZ_AI_ENGINE_VERSION}</strong>
                        </div>
                        <div>
                            <span>STATUS</span>
                            <strong>{strategy === 'alpha' ? 'EXECUTION TEST' : gateInfo.status}</strong>
                        </div>
                        <div>
                            <span>CANDIDATE</span>
                            <strong>{engineAnalysis?.candidate ? engineAnalysis.candidate.toUpperCase() : '—'}</strong>
                        </div>
                        <div>
                            <span>AGREEMENT</span>
                            <strong>{engineAnalysis?.agreementTier ? `${engineAnalysis.agreementTier} models` : '—'}</strong>
                        </div>
                        <div>
                            <span>FRESH EVIDENCE</span>
                            <strong>{evidenceState?.correct || 0}/{evidenceState?.total || 0}</strong>
                        </div>
                        <div>
                            <span>EXACT SETUP</span>
                            <strong>{exactSetupEvidence.correct}/{exactSetupEvidence.n}</strong>
                        </div>
                        <div>
                            <span>SETUP LOWER BOUND</span>
                            <strong>{exactSetupEvidence.n ? `${(exactSetupEvidence.lowerBound * 100).toFixed(2)}%` : '—'}</strong>
                        </div>
                        <div>
                            <span>LIVE BREAK-EVEN</span>
                            <strong>{gateInfo.breakeven ? `${(gateInfo.breakeven * 100).toFixed(2)}%` : '—'}</strong>
                        </div>
                        <p>{strategy === 'alpha' ? 'Alpha places one user-selected demo contract only, to verify the full execution pipeline.' : gateInfo.reason}</p>
                    </div>

                    {strategy !== 'alpha' && engineAnalysis?.votes?.length > 0 && (
                        <div className='nolimitz-ai__votes'>
                            <span className='nolimitz-ai__votes-title'>LIVE MODEL VOTES</span>
                            {engineAnalysis.votes.map(vote => (
                                <div key={vote.model} className={engineAnalysis.agreementModels?.includes(vote.model) ? 'agree' : ''}>
                                    <b>{vote.model}</b>
                                    <span>{vote.side.toUpperCase()}</span>
                                    <small>{(vote.probability * 100).toFixed(2)}% from {vote.samples} samples</small>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className='nolimitz-ai__field-label'>CONTRACT TYPE</div>
                    <div className='nolimitz-ai__contracts'>
                        {CONTRACTS.map(item => (
                            <button
                                key={item.id}
                                disabled={running || !item.available || (strategy !== 'alpha' && item.id === 'rise_fall')}
                                className={`${contract === item.id ? 'active' : ''} ${item.recommended ? 'recommended' : ''}`}
                                onClick={() => item.available && setContract(item.id)}
                            >
                                <b>{item.symbol}</b>
                                <span>{item.label}</span>
                                {item.recommended && <small>RECOMMENDED</small>}
                                {!item.available && <small>{item.note}</small>}
                            </button>
                        ))}
                    </div>

                    {strategy === 'alpha' && contract === 'rise_fall' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'rise' ? 'active' : ''} onClick={() => setDirection('rise')} disabled={running}>RISE</button>
                            <button className={direction === 'fall' ? 'active' : ''} onClick={() => setDirection('fall')} disabled={running}>FALL</button>
                        </div>
                    )}
                    {strategy === 'alpha' && contract === 'even_odd' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'even' ? 'active' : ''} onClick={() => setDirection('even')} disabled={running}>EVEN</button>
                            <button className={direction === 'odd' ? 'active' : ''} onClick={() => setDirection('odd')} disabled={running}>ODD</button>
                        </div>
                    )}
                    {strategy === 'alpha' && contract === 'over_under' && (
                        <div className='nolimitz-ai__choice-row'>
                            <button className={direction === 'over' ? 'active' : ''} onClick={() => setDirection('over')} disabled={running}>OVER 2</button>
                            <button className={direction === 'under' ? 'active' : ''} onClick={() => setDirection('under')} disabled={running}>UNDER 7</button>
                        </div>
                    )}

                    <div className='nolimitz-ai__field-label'>STAKE SIZE [{currency}]</div>
                    <div className='nolimitz-ai__stepper'>
                        <button disabled={running} onClick={() => setStake(String(Math.max(0.35, (parseFloat(stake) || 0.5) - 0.5).toFixed(2)))}>−</button>
                        <input value={stake} disabled={running} onChange={e => setStake(e.target.value)} />
                        <button disabled={running} onClick={() => setStake(String(((parseFloat(stake) || 0.5) + 0.5).toFixed(2)))}>+</button>
                    </div>

                    <label className='nolimitz-ai__optimization'>
                        <span>
                            <b>MEASURED VALIDATION</b>
                            <small>Real tick models + fresh forward evidence + live payout break-even. This safety gate cannot be bypassed in AI modes.</small>
                        </span>
                        <input type='checkbox' checked disabled />
                        <i />
                    </label>

                    <div className='nolimitz-ai__field-label'>RISK LEVEL</div>
                    <div className='nolimitz-ai__risk-tabs'>
                        {['low', 'medium', 'high'].map(level => (
                            <button
                                key={level}
                                className={risk === level ? 'active' : ''}
                                disabled={running}
                                onClick={() => {
                                    setRisk(level);
                                    if (level === 'low') setMartingale(false);
                                }}
                            >
                                {level.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    <div className='nolimitz-ai__targets'>
                        <label>
                            <span>PROFIT TARGET</span>
                            <div><b>◎</b><input value={tp} disabled={running} onChange={e => setTp(e.target.value)} /><small>{currency}</small></div>
                        </label>
                        <label>
                            <span>MAXIMUM LOSS</span>
                            <div><b>♢</b><input value={sl} disabled={running} onChange={e => setSl(e.target.value)} /><small>{currency}</small></div>
                        </label>
                    </div>

                    <div className='nolimitz-ai__advanced'>
                        <label>
                            <span>Martingale</span>
                            <input
                                type='checkbox'
                                checked={martingale}
                                disabled={running || risk === 'low'}
                                onChange={e => setMartingale(e.target.checked)}
                            />
                            <i />
                        </label>
                        {martingale && (
                            <div className='nolimitz-ai__multiplier'>
                                <span>Factor</span>
                                <input value={mult} disabled={running} onChange={e => setMult(e.target.value)} />
                                <small>Max {maxMartingaleSteps(risk)} recovery steps</small>
                            </div>
                        )}
                        <div className='nolimitz-ai__duration'>
                            <span>Contract duration</span>
                            <select
                                value={strategy === 'alpha' ? duration : 1}
                                disabled={running || strategy !== 'alpha'}
                                onChange={e => setDuration(clamp(parseInt(e.target.value || 1, 10), 1, 10))}
                            >
                                {[1,2,3,4,5,10].map(v => <option key={v} value={v}>{v} tick{v > 1 ? 's' : ''}</option>)}
                            </select>
                            <small>{strategy === 'alpha' ? 'Alpha test duration' : 'AI evidence horizon is fixed to 1 tick'}</small>
                        </div>
                    </div>

                    <button
                        className={`nolimitz-ai__run ${running ? 'stop' : ''}`}
                        disabled={!is_logged_in || !is_demo}
                        onClick={running ? stop : start}
                    >
                        {running ? '■ STOP NOLIMITZ AI' : '⚡ RUN NOLIMITZ AI'}
                    </button>
                </section>

                <section className='nolimitz-ai__session'>
                    <div>
                        <span>TRADES</span>
                        <strong>{stats.trades}</strong>
                    </div>
                    <div>
                        <span>WINS / LOSSES</span>
                        <strong>{stats.wins}/{stats.losses}</strong>
                    </div>
                    <div>
                        <span>HIT RATE</span>
                        <strong>{stats.trades ? `${winRate.toFixed(1)}%` : '—'}</strong>
                    </div>
                    <div className={stats.pnl >= 0 ? 'positive' : 'negative'}>
                        <span>SESSION P/L</span>
                        <strong>{stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(2)} {currency}</strong>
                    </div>
                </section>

                <div className='nolimitz-ai__signal'>
                    <span>CURRENT ENGINE PICK</span>
                    <strong>{contractSpec ? contractSpec.label : 'WAITING'}</strong>
                    <small>
                        {strategy === 'alpha'
                            ? 'Manual demo execution test — no AI probability claim.'
                            : engineAnalysis?.reason || 'Waiting for measured consensus.'}
                    </small>
                </div>

                {strategy !== 'alpha' && bestSetups.length > 0 && (
                    <section className='nolimitz-ai__setups'>
                        <div className='nolimitz-ai__setups-title'>FRESH EXACT-SETUP CALIBRATION</div>
                        {bestSetups.map(row => (
                            <div key={row.fingerprint}>
                                <span>{row.side.toUpperCase()} · {row.tier}-model</span>
                                <strong>{row.correct}/{row.n}</strong>
                                <small>LB {(row.lowerBound * 100).toFixed(2)}%</small>
                            </div>
                        ))}
                    </section>
                )}

                {logs.length > 0 && (
                    <section className='nolimitz-ai__log'>
                        {logs.map((line, index) => <div key={index}>{line}</div>)}
                    </section>
                )}

                <div className='nolimitz-ai__disclaimer'>
                    Nolimitz AI automates execution and risk rules. Digit/tick outcomes remain probabilistic; filters do not guarantee profit.
                </div>
            </div>

            {result && (
                <div className='nolimitz-ai__overlay'>
                    <div className={`nolimitz-ai__result ${result.pnl >= 0 ? 'win' : 'loss'}`}>
                        <button onClick={() => setResult(null)}>×</button>
                        <small>{result.reason}</small>
                        <h3>{result.pnl >= 0 ? '+' : ''}{result.pnl.toFixed(2)} {currency}</h3>
                        <div>
                            <span>Trades <b>{result.trades}</b></span>
                            <span>Wins <b>{result.wins}</b></span>
                            <span>Losses <b>{result.losses}</b></span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default NolimitzAI;
