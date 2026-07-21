// @ts-nocheck — follows vendored dashboard code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import Text from '@/components/shared_ui/text';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import Guide, { GuideButton } from '@/components/shared/nlb/guide';
import './free-bots.scss';

const S = (tradetype, purchase, prediction) => `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">
  <block type="trade_definition" id="fb_root" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="fb_m" deletable="false" movable="false">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next>
          <block type="trade_definition_tradetype" id="fb_tt" deletable="false" movable="false">
            <field name="TRADETYPECAT_LIST">digits</field>
            <field name="TRADETYPE_LIST">${tradetype}</field>
            <next>
              <block type="trade_definition_contracttype" id="fb_ct" deletable="false" movable="false">
                <field name="TYPE_LIST">${purchase}</field>
                <next>
                  <block type="trade_definition_candleinterval" id="fb_ci" deletable="false" movable="false">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_restartbuysell" id="fb_rb" deletable="false" movable="false">
                        <field name="TIME_MACHINE_ENABLED">FALSE</field>
                        <next>
                          <block type="trade_definition_restartonerror" id="fb_re" deletable="false" movable="false">
                            <field name="RESTARTONERROR">TRUE</field>
                          </block>
                        </next>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions" id="fb_to">
        <mutation xmlns="http://www.w3.org/1999/xhtml" has_first_barrier="false" has_second_barrier="false" has_prediction="${prediction === null ? 'false' : 'true'}"></mutation>
        <field name="DURATIONTYPE_LIST">t</field>
        <value name="DURATION">
          <shadow type="math_number_positive" id="fb_d"><field name="NUM">1</field></shadow>
        </value>
        <value name="AMOUNT">
          <shadow type="math_number_positive" id="fb_a"><field name="NUM">0.5</field></shadow>
        </value>${prediction === null ? '' : `
        <value name="PREDICTION">
          <shadow type="math_number_positive" id="fb_p"><field name="NUM">${prediction}</field></shadow>
        </value>`}
      </block>
    </statement>
  </block>
  <block type="before_purchase" id="fb_bp" x="0" y="560">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase" id="fb_buy">
        <field name="PURCHASE_LIST">${purchase}</field>
      </block>
    </statement>
  </block>
  <block type="after_purchase" id="fb_ap" x="0" y="760">
    <statement name="AFTERPURCHASE_STACK">
      <block type="trade_again" id="fb_ta"></block>
    </statement>
  </block>
</xml>`;

// Martingale strategy XML generator.
// Recovers losses by multiplying stake; resets on win; tracks a win target and
// stop-loss so the bot stops itself and the "Session Complete" popup can fire.
const M = ({ tradetype, purchase, prediction, symbol = 'R_100', base = 0.5, mult = 2, wins = 5, sl = 50 }) => `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">
  <variables>
    <variable id="v_stake">Stake</variable>
    <variable id="v_base">Base Stake</variable>
    <variable id="v_mult">Martingale</variable>
    <variable id="v_wintarget">Win Target</variable>
    <variable id="v_wincount">Wins</variable>
    <variable id="v_sl">Stop Loss</variable>
    <variable id="v_pl">Running PL</variable>
  </variables>
  <block type="trade_definition" id="m_root" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="m_m" deletable="false" movable="false">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">${symbol}</field>
        <next>
          <block type="trade_definition_tradetype" id="m_tt" deletable="false" movable="false">
            <field name="TRADETYPECAT_LIST">digits</field>
            <field name="TRADETYPE_LIST">${tradetype}</field>
            <next>
              <block type="trade_definition_contracttype" id="m_ct" deletable="false" movable="false">
                <field name="TYPE_LIST">${purchase}</field>
                <next>
                  <block type="trade_definition_candleinterval" id="m_ci" deletable="false" movable="false">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_restartbuysell" id="m_rb" deletable="false" movable="false">
                        <field name="TIME_MACHINE_ENABLED">FALSE</field>
                        <next>
                          <block type="trade_definition_restartonerror" id="m_re" deletable="false" movable="false">
                            <field name="RESTARTONERROR">TRUE</field>
                          </block>
                        </next>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="INITIALIZATION">
      <block type="variables_set" id="m_i1">
        <field name="VAR" id="v_base">Base Stake</field>
        <value name="VALUE"><block type="math_number" id="m_i1n"><field name="NUM">${base}</field></block></value>
        <next>
        <block type="variables_set" id="m_i2">
          <field name="VAR" id="v_stake">Stake</field>
          <value name="VALUE"><block type="variables_get" id="m_i2g"><field name="VAR" id="v_base">Base Stake</field></block></value>
          <next>
          <block type="variables_set" id="m_i3">
            <field name="VAR" id="v_mult">Martingale</field>
            <value name="VALUE"><block type="math_number" id="m_i3n"><field name="NUM">${mult}</field></block></value>
            <next>
            <block type="variables_set" id="m_i4">
              <field name="VAR" id="v_wintarget">Win Target</field>
              <value name="VALUE"><block type="math_number" id="m_i4n"><field name="NUM">${wins}</field></block></value>
              <next>
              <block type="variables_set" id="m_i5">
                <field name="VAR" id="v_wincount">Wins</field>
                <value name="VALUE"><block type="math_number" id="m_i5n"><field name="NUM">0</field></block></value>
                <next>
                <block type="variables_set" id="m_i6">
                  <field name="VAR" id="v_sl">Stop Loss</field>
                  <value name="VALUE"><block type="math_number" id="m_i6n"><field name="NUM">${sl}</field></block></value>
                  <next>
                  <block type="variables_set" id="m_i7">
                    <field name="VAR" id="v_pl">Running PL</field>
                    <value name="VALUE"><block type="math_number" id="m_i7n"><field name="NUM">0</field></block></value>
                  </block>
                  </next>
                </block>
                </next>
              </block>
              </next>
            </block>
            </next>
          </block>
          </next>
        </block>
        </next>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions" id="m_to">
        <mutation xmlns="http://www.w3.org/1999/xhtml" has_first_barrier="false" has_second_barrier="false" has_prediction="${prediction === null ? 'false' : 'true'}"></mutation>
        <field name="DURATIONTYPE_LIST">t</field>
        <value name="DURATION"><shadow type="math_number_positive" id="m_dur"><field name="NUM">1</field></shadow></value>
        <value name="AMOUNT">
          <shadow type="math_number_positive" id="m_amt"><field name="NUM">${base}</field></shadow>
          <block type="variables_get" id="m_amtv"><field name="VAR" id="v_stake">Stake</field></block>
        </value>${prediction === null ? '' : `
        <value name="PREDICTION"><shadow type="math_number_positive" id="m_pred"><field name="NUM">${prediction}</field></shadow></value>`}
      </block>
    </statement>
  </block>
  <block type="before_purchase" id="m_bp" x="0" y="620">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase" id="m_buy"><field name="PURCHASE_LIST">${purchase}</field></block>
    </statement>
  </block>
  <block type="after_purchase" id="m_ap" x="0" y="900">
    <statement name="AFTERPURCHASE_STACK">
      <block type="controls_if" id="m_if1">
        <mutation else="1"></mutation>
        <value name="IF0">
          <block type="contract_check_result" id="m_res"><field name="CHECK_RESULT">win</field></block>
        </value>
        <statement name="DO0">
          <block type="variables_set" id="m_w1">
            <field name="VAR" id="v_wincount">Wins</field>
            <value name="VALUE">
              <block type="math_arithmetic" id="m_w1a"><field name="OP">ADD</field>
                <value name="A"><block type="variables_get" id="m_w1g"><field name="VAR" id="v_wincount">Wins</field></block></value>
                <value name="B"><block type="math_number" id="m_w1n"><field name="NUM">1</field></block></value>
              </block>
            </value>
            <next>
            <block type="variables_set" id="m_w2">
              <field name="VAR" id="v_stake">Stake</field>
              <value name="VALUE"><block type="variables_get" id="m_w2g"><field name="VAR" id="v_base">Base Stake</field></block></value>
            </block>
            </next>
          </block>
        </statement>
        <statement name="ELSE">
          <block type="variables_set" id="m_l1">
            <field name="VAR" id="v_stake">Stake</field>
            <value name="VALUE">
              <block type="math_arithmetic" id="m_l1a"><field name="OP">MULTIPLY</field>
                <value name="A"><block type="variables_get" id="m_l1g"><field name="VAR" id="v_stake">Stake</field></block></value>
                <value name="B"><block type="variables_get" id="m_l1m"><field name="VAR" id="v_mult">Martingale</field></block></value>
              </block>
            </value>
          </block>
        </statement>
        <next>
        <block type="variables_set" id="m_pl">
          <field name="VAR" id="v_pl">Running PL</field>
          <value name="VALUE">
            <block type="math_arithmetic" id="m_pla"><field name="OP">ADD</field>
              <value name="A"><block type="variables_get" id="m_plg"><field name="VAR" id="v_pl">Running PL</field></block></value>
              <value name="B"><block type="read_details" id="m_pld"><field name="DETAIL_INDEX">4</field></block></value>
            </block>
          </value>
          <next>
          <block type="controls_if" id="m_if2">
            <value name="IF0">
              <block type="logic_operation" id="m_or"><field name="OP">OR</field>
                <value name="A">
                  <block type="logic_compare" id="m_c1"><field name="OP">GTE</field>
                    <value name="A"><block type="variables_get" id="m_c1a"><field name="VAR" id="v_wincount">Wins</field></block></value>
                    <value name="B"><block type="variables_get" id="m_c1b"><field name="VAR" id="v_wintarget">Win Target</field></block></value>
                  </block>
                </value>
                <value name="B">
                  <block type="logic_compare" id="m_c2"><field name="OP">LTE</field>
                    <value name="A"><block type="variables_get" id="m_c2a"><field name="VAR" id="v_pl">Running PL</field></block></value>
                    <value name="B">
                      <block type="math_single" id="m_neg"><field name="OP">NEG</field>
                        <value name="NUM"><block type="variables_get" id="m_c2b"><field name="VAR" id="v_sl">Stop Loss</field></block></value>
                      </block>
                    </value>
                  </block>
                </value>
              </block>
            </value>
            <statement name="DO0">
              <block type="notify" id="m_notify">
                <field name="NOTIFICATION_TYPE">success</field>
                <field name="NOTIFICATION_SOUND">silent</field>
                <value name="MESSAGE"><shadow type="text" id="m_msg"><field name="TEXT">Session Complete!!!</field></shadow></value>
              </block>
            </statement>
            <next>
            <block type="trade_again" id="m_ta"></block>
            </next>
          </block>
          </next>
        </block>
        </next>
      </block>
    </statement>
  </block>
</xml>`;


export const FREE_BOTS = [
    { id: 'nlb-over-1', name: 'Over 1 Shield', risk: 'LOW', desc: 'Wins whenever the last digit is 2-9 — a high hit-rate, small-payout play. Wins often, but losses are larger, so it is not guaranteed profit. Fixed stake.', xml: S('overunder', 'DIGITOVER', 1) },
    { id: 'nlb-under-8', name: 'Under 8 Shield', risk: 'LOW', desc: 'Wins whenever the last digit is 0-7 — mirror of Over 1 Shield. High hit-rate, small payout, larger occasional losses. Fixed stake.', xml: S('overunder', 'DIGITUNDER', 8) },
    { id: 'nlb-even-flow', name: 'Even Flow', risk: 'MEDIUM', desc: 'Trades Even every tick with a fixed stake. Close to 50/50 with a bigger payout and bigger swings than the Shield bots.', xml: S('evenodd', 'DIGITEVEN', null) },
    { id: 'nlb-odd-rush', name: 'Odd Rush', risk: 'MEDIUM', desc: 'Trades Odd continuously with a fixed stake — the mirror of Even Flow.', xml: S('evenodd', 'DIGITODD', null) },
    { id: 'nlb-over-2', name: 'Over 2 Steady', risk: 'MEDIUM', desc: 'Wins when the last digit is 3-9. Balanced win-rate and payout. Fixed stake.', xml: S('overunder', 'DIGITOVER', 2) },
    { id: 'nlb-under-7', name: 'Under 7 Guard', risk: 'MEDIUM', desc: 'Wins when the last digit is 0-6. Defensive digit play with a fixed stake.', xml: S('overunder', 'DIGITUNDER', 7) },
    { id: 'nlb-over-4', name: 'Over 4 Bold', risk: 'HIGH', desc: 'Wins only when the last digit is 5-9 — roughly a coin flip with a larger payout. Higher risk, bigger swings. Fixed stake.', xml: S('overunder', 'DIGITOVER', 4) },
    { id: 'nlb-under-5', name: 'Under 5 Bold', risk: 'HIGH', desc: 'Wins only when the last digit is 0-4 — mirror of Over 4 Bold. Larger payout, lower win rate. Fixed stake.', xml: S('overunder', 'DIGITUNDER', 5) },
    { id: 'nlb-over-7', name: 'Over 7 Payout', risk: 'HIGH', desc: 'Wins only when the last digit is 8 or 9 — rare, but a large payout when it lands. Expect long losing stretches. High risk, fixed stake.', xml: S('overunder', 'DIGITOVER', 7) },
    { id: 'nlb-infinity', name: 'Infinity Algo', risk: 'MARTINGALE', desc: 'Over 2 on Vol 10 with martingale recovery. Recovers losses by increasing stake after each loss and resets on a win; stops at its win target with a "Session Complete" message. Wins often in short sessions, but a losing streak can hit stop-loss and cause a large loss.', xml: M({ tradetype: 'overunder', purchase: 'DIGITOVER', prediction: 2, symbol: 'R_10', base: 0.5, mult: 2, wins: 5, sl: 50 }) },
    { id: 'nlb-switcher', name: 'Under 7-8-9 Switcher', risk: 'MARTINGALE', desc: 'Under 8 with martingale recovery on Vol 25. Same recovery logic as Infinity Algo — multiplies stake after losses, resets on win, stops at win target. Martingale risk: a long losing streak can reach stop-loss and wipe several winning sessions.', xml: M({ tradetype: 'overunder', purchase: 'DIGITUNDER', prediction: 8, symbol: 'R_25', base: 0.5, mult: 2, wins: 5, sl: 50 }) },
    { id: 'nlb-differ', name: 'Differ Smart Cycle', risk: 'MARTINGALE', desc: 'Over 4 with martingale recovery on Vol 50 — the boldest of the three (lower base win rate, bigger recovery swings). Multiplies stake after losses, resets on win, stops at win target. High martingale risk — test on demo and set a stop-loss you can afford.', xml: M({ tradetype: 'overunder', purchase: 'DIGITOVER', prediction: 4, symbol: 'R_50', base: 0.5, mult: 2, wins: 5, sl: 50 }) },
];

const FreeBots = observer(() => {
    const { dashboard, load_modal } = useStore();
    const { setActiveTab } = dashboard;
    const { loadStrategyToBuilder } = load_modal;
    const [guide_open, setGuideOpen] = React.useState(false);

    const runBot = async bot => {
        await loadStrategyToBuilder({ id: bot.id, name: bot.name, save_type: 'unsaved', xml: bot.xml }, false);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    return (
        <div className='free-bots' id='free-bots-section'>
            <div className='free-bots__head-row'>
                <Text weight='bold' size='m' className='free-bots__title'>Free Bots</Text>
                <GuideButton onClick={() => setGuideOpen(true)} />
            </div>
            <Text size='xs' color='less-prominent'>
                NolimitzBots starter strategies — fixed stake, no martingale. Tap a bot to load it into the builder, review the stake, then press Run.
            </Text>
            <Guide tool='free-bots' open={guide_open} onClose={() => setGuideOpen(false)} />
            <div className='free-bots__grid'>
                {FREE_BOTS.map(bot => (
                    <div key={bot.id} className='free-bots__card'>
                        <div className='free-bots__card-head'>
                            <Text weight='bold' size='s'>{bot.name}</Text>
                            <span className={`free-bots__badge free-bots__badge--${bot.risk.toLowerCase()}`}>{bot.risk}</span>
                        </div>
                        <Text size='xxs' color='less-prominent' className='free-bots__desc'>{bot.desc}</Text>
                        <button className='free-bots__run' onClick={() => runBot(bot)}>⚡ Load Bot</button>
                    </div>
                ))}
            </div>
        </div>
    );
});

export default FreeBots;
