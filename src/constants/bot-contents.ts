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
    CHART: 3,
    TUTORIAL: 4,
    BULK_TRADER: 5,
    SPEEDBOT: 6,
    AI_SOFTWARE: 7,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = ['id-dbot-dashboard', 'id-bot-builder', 'id-free-bots', 'id-charts', 'id-tutorials', 'id-bulk-trader', 'id-speedbot', 'id-ai-software'];

export const DEBOUNCE_INTERVAL_TIME = 500;
