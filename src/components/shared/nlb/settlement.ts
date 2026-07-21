// @ts-nocheck — shared settlement utility for NolimitzBots trading tools.
// One robust implementation so Bulk Trader, Speedbot and AI Software all
// settle contracts the same reliable way: dedupe, poll fallback, clean teardown.
// It also feeds the run panel (Transactions / Summary / Journal) by emitting
// 'bot.contract' events for every contract update, exactly like the bot engine.
import { api_base } from '@/external/bot-skeleton';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';

// Report a contract update into the run panel so Transactions/Summary/Journal fill.
export const reportContract = poc => {
    try {
        if (poc) globalObserver.emit('bot.contract', poc);
    } catch {
        /* noop */
    }
};

// Human-readable reason for a Deriv API error.
export const describeError = e => {
    const msg = e?.error?.message || e?.message || '';
    const code = e?.error?.code || '';
    if (/insufficient|balance/i.test(msg)) return 'Insufficient balance';
    if (/market.*closed|not.*open|trading.*suspend/i.test(msg)) return 'Market closed';
    if (/rate.?limit|too many/i.test(msg) || code === 'RateLimit') return 'Too many requests — slow down';
    if (/invalid.*token|authoriz/i.test(msg)) return 'Session expired — reconnect Deriv';
    if (/duration/i.test(msg)) return 'Invalid duration';
    if (/barrier/i.test(msg)) return 'Invalid digit/barrier';
    return msg || 'Trade error';
};

// Track a set of contract_ids to settlement.
// Returns a handle with .cancel(). Calls onUpdate({settled,total}) as they resolve,
// and onDone({profits, total, wins, settled, count}) exactly once when all are in
// (or the safety timeout fires). Never double-counts, never leaks subscriptions.
export const trackContracts = (contract_ids, { onUpdate, onDone, timeoutMs = 120000 } = {}) => {
    const pending = new Set(contract_ids);
    const profits = {};
    const count = contract_ids.length;
    let finalized = false;
    let sub = null;
    let poll = null;
    let timeout = null;

    const cleanup = () => {
        if (sub) {
            try {
                sub.unsubscribe();
            } catch {
                /* noop */
            }
            sub = null;
        }
        if (poll) {
            clearInterval(poll);
            poll = null;
        }
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };

    const finalize = () => {
        if (finalized) return;
        finalized = true;
        cleanup();
        const list = Object.values(profits);
        const total = list.reduce((a, p) => a + p, 0);
        const wins = list.filter(p => p > 0).length;
        onDone?.({ profits, total, wins, settled: list.length, count });
    };

    const record = contract => {
        if (!contract) return;
        // Feed the run panel on every update (open + sold) so it shows live.
        reportContract(contract);
        if (!contract.is_sold) return;
        const id = contract.contract_id;
        if (!pending.has(id)) return; // dedupe: already recorded
        pending.delete(id);
        profits[id] = Number(contract.profit ?? 0);
        onUpdate?.({ settled: Object.keys(profits).length, total: count });
        if (pending.size === 0) finalize();
    };

    // Primary: the account's global proposal_open_contract stream.
    try {
        sub = api_base.api.onMessage().subscribe(({ data }) => {
            if (data?.msg_type === 'proposal_open_contract') record(data.proposal_open_contract);
        });
    } catch {
        /* stream unavailable — poll will cover it */
    }

    // Fallback: actively poll any still-pending contracts. Covers missed stream messages.
    poll = setInterval(() => {
        if (pending.size === 0) return;
        pending.forEach(id => {
            try {
                api_base.api.send({ proposal_open_contract: 1, contract_id: id }).then(r => {
                    if (r?.proposal_open_contract) record(r.proposal_open_contract);
                });
            } catch {
                /* noop */
            }
        });
    }, 3000);

    // Safety net: never hang forever. Unsettled contracts are reported as-is.
    timeout = setTimeout(finalize, timeoutMs);

    return {
        cancel: () => {
            // Silent teardown — no onDone. Used on unmount / user stop.
            finalized = true;
            cleanup();
        },
        finalizeNow: finalize,
    };
};
