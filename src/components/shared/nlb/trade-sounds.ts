// Lightweight WebAudio win/loss chimes — no audio assets needed.
let ctx: AudioContext | null = null;

export const unlockAudio = () => {
    try {
        if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
    } catch {
        /* noop */
    }
};

const tone = (freq: number, start: number, dur: number, type: OscillatorType, gain_v: number) => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime + start);
    gain.gain.linearRampToValueAtTime(gain_v, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.05);
};

export const playWin = () => {
    unlockAudio();
    // ascending gold chime: C5 E5 G5 C6
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.12, 0.35, 'sine', 0.18));
};

export const playLoss = () => {
    unlockAudio();
    // descending low buzz
    tone(220, 0, 0.3, 'sawtooth', 0.12);
    tone(174.61, 0.18, 0.45, 'sawtooth', 0.12);
};
