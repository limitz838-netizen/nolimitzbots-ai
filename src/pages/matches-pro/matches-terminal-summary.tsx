import React from 'react';

type TDigitItem = {
    digit: number;
    is_current: boolean;
};

type TMatchesTerminalSummaryProps = {
    market: string;
    status: string;
    account_id?: string;
    is_demo: boolean;
    balance?: number;
    currency: string;
    quote: string | number | null;
    current_digit: number | null;
    predicted_digit: number | null;
    signal_quality: string;
    signal_score: number;
    estimated_probability?: number;
    session_pl: number;
    auto_enabled: boolean;
    recent_digits: number[];
};

const money = (value: number, currency: string) => {
    if (!Number.isFinite(value)) return `0.00 ${currency}`;
    return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)} ${currency}`;
};

const probability = (value?: number) =>
    Number.isFinite(value) ? `${(Number(value) * 100).toFixed(2)}%` : '-';

const MatchesTerminalSummary = ({
    market,
    status,
    account_id,
    is_demo,
    balance,
    currency,
    quote,
    current_digit,
    predicted_digit,
    signal_quality,
    signal_score,
    estimated_probability,
    session_pl,
    auto_enabled,
    recent_digits,
}: TMatchesTerminalSummaryProps) => {
    const digits: TDigitItem[] = recent_digits.slice(-10).map((digit, index, arr) => ({
        digit,
        is_current: index === arr.length - 1,
    }));

    return (
        <section className='matches-pro__terminal' aria-label='Matches Pro live terminal'>
            <div className='matches-pro__terminal-top'>
                <div>
                    <div className='matches-pro__terminal-kicker'>NOLIMITZ SIGNAL ENGINE</div>
                    <div className='matches-pro__terminal-market'>{market}</div>
                    <div className='matches-pro__terminal-meta'>
                        <span className={`matches-pro__terminal-live matches-pro__terminal-live--${status}`}>
                            <i />
                            {status}
                        </span>
                        <span>{account_id || 'No account'}</span>
                        <span className={is_demo ? 'demo' : 'real'}>{is_demo ? 'DEMO' : 'REAL'}</span>
                    </div>
                </div>

                <div className='matches-pro__terminal-balance'>
                    <span>Balance</span>
                    <strong>
                        {Number.isFinite(balance) ? Number(balance).toFixed(2) : '0.00'} {currency}
                    </strong>
                </div>
            </div>

            <div className='matches-pro__terminal-grid'>
                <div className='matches-pro__terminal-card matches-pro__terminal-card--hero'>
                    <span>Live digit</span>
                    <strong>{current_digit ?? '-'}</strong>
                    <small>{quote ?? 'Waiting for tick'}</small>
                </div>

                <div className='matches-pro__terminal-card matches-pro__terminal-card--hero'>
                    <span>Engine pick</span>
                    <strong>{predicted_digit ?? '-'}</strong>
                    <small>{signal_quality}</small>
                </div>

                <div className='matches-pro__terminal-card'>
                    <span>Signal score</span>
                    <strong>{Math.max(0, Math.min(100, signal_score || 0))}/100</strong>
                    <small>Statistical signal strength</small>
                </div>

                <div className='matches-pro__terminal-card'>
                    <span>Estimated probability</span>
                    <strong>{probability(estimated_probability)}</strong>
                    <small>Model estimate, not a guarantee</small>
                </div>

                <div className='matches-pro__terminal-card'>
                    <span>Session P/L</span>
                    <strong className={session_pl >= 0 ? 'pos' : 'neg'}>{money(session_pl, currency)}</strong>
                    <small>Current market today</small>
                </div>

                <div className='matches-pro__terminal-card'>
                    <span>Automation</span>
                    <strong className={auto_enabled ? 'pos' : ''}>{auto_enabled ? 'ARMED' : 'OFF'}</strong>
                    <small>{auto_enabled ? 'Risk gate controls every order' : 'Manual analysis only'}</small>
                </div>
            </div>

            <div className='matches-pro__terminal-strip'>
                <div className='matches-pro__terminal-strip-label'>Recent digits</div>
                <div className='matches-pro__terminal-digits'>
                    {digits.length ? (
                        digits.map((item, index) => (
                            <span
                                key={`${index}-${item.digit}`}
                                className={item.is_current ? 'is-current' : undefined}
                            >
                                {item.digit}
                            </span>
                        ))
                    ) : (
                        <span className='matches-pro__terminal-empty'>Waiting for market data...</span>
                    )}
                </div>
            </div>
        </section>
    );
};

export default MatchesTerminalSummary;
