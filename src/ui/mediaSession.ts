// OS media keys and lock-screen / notification controls (the Media Session API), and keeping the screen
// awake while a song plays (Screen Wake Lock). Both are optional in a browser or webview, so everything
// here quietly does nothing where the API isn't there.

export interface MediaControls {
  play(): void;
  pause(): void;
  /** Back to the start of the section (or the song). */
  restart(): void;
  skip(seconds: number): void;
  seek(seconds: number): void;
}

type WakeLockSentinelLike = { release(): Promise<void> };

export class MediaSessionBridge {
  private playing = false;
  private wake: WakeLockSentinelLike | null = null;

  constructor(private ctl: MediaControls) {
    const ms = navigator.mediaSession;
    if (ms) {
      const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
        try {
          ms.setActionHandler(action, fn);
        } catch {
          /* this action isn't supported here */
        }
      };
      on('play', () => this.ctl.play());
      on('pause', () => this.ctl.pause());
      on('stop', () => this.ctl.pause());
      on('previoustrack', () => this.ctl.restart());
      on('nexttrack', () => this.ctl.skip(10));
      on('seekbackward', (d) => this.ctl.skip(-(d.seekOffset ?? 5)));
      on('seekforward', (d) => this.ctl.skip(d.seekOffset ?? 5));
      on('seekto', (d) => {
        if (typeof d.seekTime === 'number') this.ctl.seek(d.seekTime);
      });
    }
    // A wake lock is dropped whenever the page is hidden; take it again when it's back and a song is playing.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.playing) void this.holdScreen();
    });
  }

  /** The song shown on the lock screen / media overlay, or null when nothing is open. */
  setSong(title: string | null) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = title
        ? new MediaMetadata({ title, artist: 'Steminize', artwork: [{ src: './icon-512.png', sizes: '512x512', type: 'image/png' }] })
        : null;
    } catch {
      /* MediaMetadata unavailable */
    }
    if (!title) this.setPlaying(false);
  }

  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing) void this.holdScreen();
    else void this.releaseScreen();
  }

  private async holdScreen() {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl || this.wake) return;
    try {
      this.wake = await wl.request('screen');
      // The user may have paused while the request was in flight.
      if (!this.playing) await this.releaseScreen();
    } catch {
      /* refused (battery saver, hidden page, no permission): nothing to do */
    }
  }

  private async releaseScreen() {
    const w = this.wake;
    this.wake = null;
    try {
      await w?.release();
    } catch {
      /* already released */
    }
  }
}
