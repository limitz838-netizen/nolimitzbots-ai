// @ts-nocheck — follows vendored dashboard code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import Text from '@/components/shared_ui/text';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
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

const FREE_BOTS = [
    { id: 'nlb-even-flow', name: 'Even Flow', risk: 'LOW', desc: 'Trades Even on every tick with a fixed stake. Simple, steady digit rhythm on Volatility 100.', xml: S('evenodd', 'DIGITEVEN', null) },
    { id: 'nlb-odd-rush', name: 'Odd Rush', risk: 'LOW', desc: 'Trades Odd continuously with a fixed stake — the mirror of Even Flow.', xml: S('evenodd', 'DIGITODD', null) },
    { id: 'nlb-over-2', name: 'Over 2 Steady', risk: 'MEDIUM', desc: 'Wins when the last digit is 3-9. High win-rate profile with smaller payouts. Fixed stake.', xml: S('overunder', 'DIGITOVER', 2) },
    { id: 'nlb-under-7', name: 'Under 7 Guard', risk: 'MEDIUM', desc: 'Wins when the last digit is 0-6. Defensive digit play with a fixed stake.', xml: S('overunder', 'DIGITUNDER', 7) },
];

const FreeBots = observer(() => {
    const { dashboard, load_modal } = useStore();
    const { setActiveTab } = dashboard;
    const { loadStrategyToBuilder } = load_modal;

    const runBot = async bot => {
        await loadStrategyToBuilder({ id: bot.id, name: bot.name, save_type: 'unsaved', xml: bot.xml }, false);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    return (
        <div className='free-bots'>
            <Text weight='bold' size='m' className='free-bots__title'>Free Bots</Text>
            <Text size='xs' color='less-prominent'>
                NolimitzBots starter strategies — fixed stake, no martingale. Tap a bot to load it into the builder, review the stake, then press Run.
            </Text>
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
