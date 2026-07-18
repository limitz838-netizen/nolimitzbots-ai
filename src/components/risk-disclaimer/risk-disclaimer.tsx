// @ts-nocheck — follows vendored component conventions
import React from 'react';
import './risk-disclaimer.scss';

const STORAGE_KEY = 'nlb_risk_ack';

const RiskDisclaimer = () => {
    const [visible, setVisible] = React.useState(false);

    React.useEffect(() => {
        try {
            if (!sessionStorage.getItem(STORAGE_KEY)) setVisible(true);
        } catch {
            setVisible(true);
        }
    }, []);

    const close = () => {
        try {
            sessionStorage.setItem(STORAGE_KEY, '1');
        } catch {
            /* noop */
        }
        setVisible(false);
    };

    if (!visible) return null;

    return (
        <div className='risk-disclaimer__overlay' role='dialog' aria-modal='true'>
            <div className='risk-disclaimer__modal'>
                <div className='risk-disclaimer__title'>Risk Disclaimer</div>
                <div className='risk-disclaimer__body'>
                    <p>
                        NolimitzBots connects to Deriv, which offers complex derivative products. These products are
                        not suitable for everyone, and trading them puts your capital at risk:
                    </p>
                    <ul>
                        <li>You may lose some or all of the money you place on any trade.</li>
                        <li>
                            Automated bots and bulk trading multiply how fast stakes are placed — they do not improve
                            the odds of winning.
                        </li>
                        <li>Past results, statistics, and signals describe history, never future outcomes.</li>
                    </ul>
                    <p>
                        Never trade with borrowed money or money you cannot afford to lose. Practice on a demo account
                        before using real funds.
                    </p>
                </div>
                <button className='risk-disclaimer__btn' onClick={close}>
                    I understand
                </button>
            </div>
        </div>
    );
};

export default RiskDisclaimer;
