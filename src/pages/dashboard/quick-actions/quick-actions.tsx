// @ts-nocheck — follows vendored dashboard code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import {
    LabelPairedArrowUpFromBracketCaptionBoldIcon,
    LabelPairedChartTrendUpCaptionBoldIcon,
    LabelPairedGridCaptionBoldIcon,
    LabelPairedPuzzlePieceTwoCaptionBoldIcon,
} from '@deriv/quill-icons/LabelPaired';
import { useDevice } from '@deriv-com/ui';
import './quick-actions.scss';

const QuickActions = observer(() => {
    const { dashboard, load_modal, quick_strategy } = useStore();
    const { isDesktop } = useDevice();
    const { setActiveTab } = dashboard;
    const { toggleLoadModal, setActiveTabIndex } = load_modal;
    const { setFormVisibility } = quick_strategy;

    const uploadBot = () => {
        toggleLoadModal();
        setActiveTabIndex(isDesktop ? 1 : 0);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    const scrollToFreeBots = () => {
        document.getElementById('free-bots-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const actions = [
        {
            id: 'upload',
            accent: 'orange',
            icon: <LabelPairedArrowUpFromBracketCaptionBoldIcon height='26px' width='26px' fill='#fb923c' />,
            title: 'Upload Bot',
            desc: 'Import an XML bot from your device',
            onClick: uploadBot,
        },
        {
            id: 'freebots',
            accent: 'green',
            icon: <LabelPairedGridCaptionBoldIcon height='26px' width='26px' fill='#4ade80' />,
            title: 'Free Bots',
            desc: 'Browse ready-made trading strategies',
            onClick: scrollToFreeBots,
        },
        {
            id: 'editor',
            accent: 'purple',
            icon: <LabelPairedPuzzlePieceTwoCaptionBoldIcon height='26px' width='26px' fill='#a78bfa' />,
            title: 'Bot Editor',
            desc: 'Build a custom bot with the visual editor',
            onClick: () => setActiveTab(DBOT_TABS.BOT_BUILDER),
        },
        {
            id: 'quick',
            accent: 'gold',
            icon: <LabelPairedChartTrendUpCaptionBoldIcon height='26px' width='26px' fill='#e8cf7a' />,
            title: 'Quick Strategy',
            desc: 'Start fast with a pre-built strategy template',
            onClick: () => setFormVisibility(true),
        },
    ];

    return (
        <div className='quick-actions'>
            <div className='quick-actions__heading'>
                <span className='quick-actions__line' />
                <span className='quick-actions__label'>Quick Actions</span>
                <span className='quick-actions__line' />
            </div>
            <div className='quick-actions__grid'>
                {actions.map(a => (
                    <button
                        key={a.id}
                        className={`quick-actions__card quick-actions__card--${a.accent}`}
                        onClick={a.onClick}
                    >
                        <span className={`quick-actions__chip quick-actions__chip--${a.accent}`}>{a.icon}</span>
                        <span className='quick-actions__title'>{a.title}</span>
                        <span className='quick-actions__desc'>{a.desc}</span>
                        <span className={`quick-actions__open quick-actions__open--${a.accent}`}>Open →</span>
                    </button>
                ))}
            </div>
        </div>
    );
});

export default QuickActions;
