// @ts-nocheck — Honest in-app guides for each NolimitzBots tool.
import React from 'react';
import './guide.scss';

// Content is deliberately honest: real mechanics + risk management,
// NOT fake "best time to trade" claims (synthetic indices run 24/7 and
// each tick is independent, so no time-of-day edge exists).
export const GUIDES = {
    'bulk-trader': {
        title: 'How to use Bulk Trader',
        intro: 'Bulk Trader fires several digit contracts at once on a market you choose. It is fast — which cuts both ways.',
        sections: [
            {
                h: 'What it does',
                p: 'You pick a market, a trade type (Even/Odd or Over/Under), a stake and how many contracts to fire. It buys them in quick succession and shows a settlement popup with your total profit or loss.',
            },
            {
                h: 'How to read the digit panel',
                p: 'The 0–9 grid shows how often each digit appeared in the recent window. The hot digit (green) appeared most, the cold digit (red) least. This is history — it does not predict the next digit. Every tick is independent.',
            },
            {
                h: 'The AI Scanner',
                p: 'The scanner ranks markets by their strongest recent skew and suggests a side. Treat it as "what has been happening lately", not a forecast. It loads the market and side for you; you still decide whether to trade.',
            },
            {
                h: 'Sensible settings',
                p: 'Start small: 0.5 stake, 3–5 contracts. Over/Under with a wide barrier (Over 2, Under 7) wins more often but pays less. Even/Odd is close to 50/50 with bigger payout and bigger swings.',
            },
            {
                h: 'Golden rule',
                p: 'Bulk buying multiplies your stake, not your odds. Firing 20 contracts does not make you more likely to win — it just risks 20× the money at once. Always test on demo first.',
            },
        ],
    },
    speedbot: {
        title: 'How to use Speedbot',
        intro: 'Speedbot trades continuously on every cycle until you stop it or it hits your take-profit / stop-loss.',
        sections: [
            {
                h: 'What it does',
                p: 'Pick a market, trade type, stake, ticks, and — importantly — a Take Profit and Stop Loss. It keeps trading and tracks your running P/L. When TP or SL is reached, it stops itself and shows the result.',
            },
            {
                h: 'Take Profit / Stop Loss are your seatbelt',
                p: 'These are the most important settings. TP locks in gains by stopping while you are ahead; SL caps the damage on a bad run. Never run Speedbot without both set to amounts you are comfortable with.',
            },
            {
                h: 'Fast vs Normal',
                p: 'Normal waits for each contract to settle before the next — safer and easier to follow. Fast overlaps trades for speed but stakes accumulate quicker. Use Normal while learning.',
            },
            {
                h: 'Alternate options',
                p: 'Alternate Even/Odd and Alternate on Loss switch sides automatically. They change the pattern of trades, not the odds of any single trade.',
            },
            {
                h: 'Martingale — handle with care',
                p: 'Martingale raises your stake after a loss to recover it. It can recover small losing streaks but a long streak grows the stake very fast and can drain a balance. It is capped here, but treat it as high risk and keep the multiplier low (≤2).',
            },
        ],
    },
    'ai-software': {
        title: 'How to use AI Software robots',
        intro: 'These robots watch the live digit stream and only enter when their specific pattern appears, then manage the trade for you.',
        sections: [
            {
                h: 'What "trigger" means',
                p: 'Each robot waits for a condition — e.g. Over 1 Pro enters only after two digits ≤ 1 in a row. Until that shows up, the robot sits out. This selectivity means fewer trades and less constant exposure.',
            },
            {
                h: 'This is not prediction',
                p: 'A trigger reacts to what just happened on a random stream. It does not know the next tick. It is a disciplined entry rule, not a crystal ball. Some robots will still lose over time — the payout math does not change.',
            },
            {
                h: 'Set stake, TP and SL first',
                p: 'Before arming a robot, set a stake you can afford and a Take Profit / Stop Loss. The robot stops itself when either is hit.',
            },
            {
                h: 'Watch the log',
                p: 'The robot prints what it is doing — armed, trigger hit, win/loss, TP/SL stop. Watch it for a while on demo before trusting it with real funds.',
            },
        ],
    },
    'free-bots': {
        title: 'How to use Free Bots',
        intro: 'Free Bots are ready-made starter strategies. Tap one to load it into the builder, review the stake, then press Run.',
        sections: [
            {
                h: 'Pick by risk level',
                p: 'LOW bots (Even/Odd, Over 1, Under 8) win more often but pay less. MEDIUM and HIGH bots pay more but win less often. There is no free lunch — higher payout always means lower win rate.',
            },
            {
                h: '"Wins often" is not "profitable"',
                p: 'A bot that wins 90% of the time can still lose money, because the ~10% of losses are much bigger than the wins. Judge a bot by whether your balance grows over many trades on demo, not by its win streak.',
            },
            {
                h: 'Always review the stake',
                p: 'Bots load with a default stake. Change it to suit your balance before running. Start on demo, run for a while, and only move to real funds if you understand how it behaves.',
            },
        ],
    },
};

const Guide = ({ tool, open, onClose }) => {
    const g = GUIDES[tool];
    if (!open || !g) return null;
    return (
        <div className='nlb-guide__overlay' role='dialog' aria-modal='true' onClick={onClose}>
            <div className='nlb-guide' onClick={e => e.stopPropagation()}>
                <div className='nlb-guide__bar'>
                    <span className='nlb-guide__title'>{g.title}</span>
                    <button className='nlb-guide__close' onClick={onClose}>
                        ✕
                    </button>
                </div>
                <p className='nlb-guide__intro'>{g.intro}</p>
                {g.sections.map((s, i) => (
                    <div key={i} className='nlb-guide__section'>
                        <div className='nlb-guide__h'>{s.h}</div>
                        <div className='nlb-guide__p'>{s.p}</div>
                    </div>
                ))}
                <div className='nlb-guide__foot'>
                    Trading synthetic indices carries risk of loss. These tools help you trade — they do not guarantee
                    profit. Practice on a demo account first.
                </div>
                <button className='nlb-guide__done' onClick={onClose}>
                    Got it
                </button>
            </div>
        </div>
    );
};

// Small inline "How to use" pill button.
export const GuideButton = ({ onClick }) => (
    <button className='nlb-guide-btn' onClick={onClick}>
        <span className='nlb-guide-btn__i'>?</span> How to use
    </button>
);

export default Guide;
