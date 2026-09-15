// @ts-nocheck -- Live DIGITMATCH proposal stream.
//
// Without this, buying takes two round-trips to Deriv: request a proposal,
// wait, then buy against the id it returns. On a one-tick contract that delay
// can push the order onto a later tick than the one the engine was reasoning
// about.
//
// Here we keep a subscribed proposal open for all ten barriers at once. Deriv
// pushes a fresh id and price on every tick, so a buy is a single message with
// an id we already hold.
//
// It also gives the real payout multiplier continuously, which is what the
// break-even figure should be based on rather than a typed-in guess.

import { api_base } from '@/external/bot-skeleton';

const STALE_MS = 15000; // a proposal id older than this is not trusted

export const startProposals = ({ symbol, currency, amount, contract_type = 'DIGITMATCH', onUpdate, onError }) => {
    const latest = {}; // digit -> { id, ask, payout, at }
    let stream = null;
    let stopped = false;

    try {
        stream = api_base.api.onMessage().subscribe(({ data }) => {
            if (stopped) return;
            if (data?.msg_type !== 'proposal' || !data.proposal) return;

            const echo = data.echo_req || {};
            // Only accept proposals matching the stream we asked for - the
            // account may have other proposal traffic from other surfaces.
            if (echo.underlying_symbol !== symbol) return;
            if (echo.contract_type !== contract_type) return;
            if (Number(echo.amount) !== Number(amount)) return;
            if (echo.barrier === undefined || echo.barrier === null) return;

            const digit = Number(echo.barrier);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) return;

            latest[digit] = {
                id: data.proposal.id,
                ask: Number(data.proposal.ask_price),
                payout: Number(data.proposal.payout),
                at: Date.now(),
            };
            onUpdate?.(latest, digit);
        });
    } catch (e) {
        onError?.(e);
    }

    for (let digit = 0; digit < 10; digit += 1) {
        try {
            api_base.api
                .send({
                    proposal: 1,
                    subscribe: 1,
                    amount: Number(amount),
                    basis: 'stake',
                    contract_type,
                    currency,
                    duration: 1,
                    duration_unit: 't',
                    underlying_symbol: symbol,
                    barrier: String(digit),
                })
                .catch(e => onError?.(e));
        } catch (e) {
            onError?.(e);
        }
    }

    return {
        // A priced, unexpired proposal for this digit, or null.
        get: digit => {
            const p = latest[digit];
            if (!p) return null;
            if (Date.now() - p.at > STALE_MS) return null;
            return p;
        },
        all: () => latest,
        // Payout multiplier implied by whatever we currently hold.
        multiplier: () => {
            const priced = Object.values(latest).filter(p => p.ask > 0 && Date.now() - p.at <= STALE_MS);
            if (!priced.length) return null;
            const ratios = priced.map(p => p.payout / p.ask);
            return ratios.reduce((a, b) => a + b, 0) / ratios.length;
        },
        stop: () => {
            stopped = true;
            try {
                api_base.api.send({ forget_all: 'proposal' });
            } catch {
                /* noop */
            }
            try {
                stream?.unsubscribe();
            } catch {
                /* noop */
            }
        },
    };
};