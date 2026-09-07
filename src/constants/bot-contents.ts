type TTabsTitle = {
    [key: string]: string | number;
};

type TDashboardTabIndex = {
    [key: string]: number;
};

export const tabs_title: TTabsTitle = Object.freeze({
    WORKSPACE: 'Workspace',
    CHART: 'Chart',
});

export const DBOT_TABS: TDashboardTabIndex = Object.freeze({
    DASHBOARD: 0,
    BOT_BUILDER: 1,
    FREE_BOTS: 2,
    BULK_TRADER: 3,
    SPEEDBOT: 4,
    AI_SOFTWARE: 5,
    MATCHES_PRO: 6,
    MY_PERFORMANCE: 7,
    CHART: 8,
    TUTORIAL: 9,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = ['id-dbot-dashboard', 'id-bot-builder', 'id-free-bots', 'id-bulk-trader', 'id-speedbot', 'id-ai-software', 'id-matches-pro', 'id-my-performance', 'id-charts', 'id-tutorials'];

export const DEBOUNCE_INTERVAL_TIME = 500;
