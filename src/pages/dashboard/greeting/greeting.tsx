// @ts-nocheck — follows vendored dashboard code conventions
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import './greeting.scss';

const greetingFor = date => {
    const h = date.getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
};

const Greeting = observer(() => {
    const { client } = useStore();
    const loginid = client?.loginid || '';
    const is_logged_in = !!client?.is_logged_in;
    const [now, setNow] = React.useState(new Date());

    React.useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 60000);
        return () => clearInterval(t);
    }, []);

    const hello = greetingFor(now);

    return (
        <div className='nlb-greeting'>
            <div className='nlb-greeting__hello'>
                {hello}
                {is_logged_in && loginid ? (
                    <>
                        , <span className='nlb-greeting__id'>{loginid}</span>
                    </>
                ) : (
                    ''
                )}{' '}
                <span className='nlb-greeting__wave'>👋</span>
            </div>
            <div className='nlb-greeting__tagline'>Your NolimitzBots trading companion.</div>
        </div>
    );
});

export default Greeting;
