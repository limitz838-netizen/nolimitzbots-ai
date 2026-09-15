// @ts-nocheck -- Page-level error boundary.
//
// Without this, a single thrown error inside one tab unmounts the whole
// application and the user sees "Sorry for the interruption" with no way back
// except a reload. With it, the broken tab shows what went wrong and every
// other tab keeps working.
import React from 'react';

class PageBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // Keep it in the console for anyone debugging a live report.
        // eslint-disable-next-line no-console
        console.error(`[${this.props.name || 'page'}] crashed`, error, info);
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        return (
            <div className='page-boundary'>
                <div className='page-boundary__card'>
                    <div className='page-boundary__title'>{this.props.name || 'This page'} hit an error</div>
                    <div className='page-boundary__msg'>{error?.message || String(error)}</div>
                    <button
                        type='button'
                        className='page-boundary__btn'
                        onClick={() => this.setState({ error: null })}
                    >
                        Try again
                    </button>
                    <div className='page-boundary__hint'>
                        The rest of the app is unaffected - the other tabs still work.
                    </div>
                </div>
            </div>
        );
    }
}

export default PageBoundary;