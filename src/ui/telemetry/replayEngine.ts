/*
 * RAF-driven telemetry playback loop. Owns `currentTSec` state and calls a
 * user-supplied `onTick` at ~60 fps while playing. Play/pause/seek/speed are
 * external commands (the rail UI drives them).
 *
 * Deliberately dumb: this module has no idea what the sim is, or what the
 * frames contain. It just advances time and delegates the "apply this
 * timestamp" work to the caller.
 */

export interface EngineOptions {
  /** Called every RAF frame while playing (and once on seek). */
  onTick: (tSec: number) => void;
  /** Total duration; playback stops when it reaches this. */
  durationSec: number;
  /** Optional callback when playback naturally reaches the end. */
  onEnd?: () => void;
}

export interface Engine {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(tSec: number): void;
  setSpeed(mult: number): void;
  setDuration(sec: number): void;
  setOnTick(fn: (t: number) => void): void;
  isPlaying(): boolean;
  currentTime(): number;
  destroy(): void;
}

export function createEngine(opts: EngineOptions): Engine {
  let tSec = 0;
  let playing = false;
  let speedMult = 1;
  let duration = opts.durationSec;
  let onTick = opts.onTick;
  let rafId = 0;
  let lastFrameMs = 0;

  const tick = (nowMs: number) => {
    if (!playing) return;
    const dt = lastFrameMs > 0 ? (nowMs - lastFrameMs) / 1000 : 0;
    lastFrameMs = nowMs;
    tSec = Math.min(duration, tSec + dt * speedMult);
    onTick(tSec);
    if (tSec >= duration) {
      playing = false;
      opts.onEnd?.();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  return {
    play() {
      if (playing) return;
      // if we're at the end, restart from 0
      if (tSec >= duration) tSec = 0;
      playing = true;
      lastFrameMs = 0;
      rafId = requestAnimationFrame(tick);
    },
    pause() {
      playing = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
    toggle() { if (playing) this.pause(); else this.play(); },
    seek(t) {
      tSec = Math.max(0, Math.min(duration, t));
      onTick(tSec);
    },
    setSpeed(m) { speedMult = m; },
    setDuration(sec) {
      duration = sec;
      if (tSec > duration) tSec = duration;
    },
    setOnTick(fn) { onTick = fn; },
    isPlaying() { return playing; },
    currentTime() { return tSec; },
    destroy() {
      playing = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}
