// The Setlist card: order library songs for a rehearsal or gig, play them in turn, and optionally move on
// by itself when one ends. Each song keeps its own tempo, pitch, loop, mixer and lyrics in the library, so
// opening it restores them; this only remembers the order and two playback choices (see ../setlists.ts).
import { keyName } from '../analysis/key.ts';
import { SR } from '../engine/separate.ts';
import type { LibMeta } from '../library.ts';
import { GAPS, loadSetlists, moveItem, newSetlist, nextSong, prevSong, pruneSongs, saveSetlists, totalSeconds, uniqueName, type Setlist } from '../setlists.ts';
import type { Deck, DeckState } from './deck.ts';
import { $, containScroll, fmtTime, h, toast } from './dom.ts';
import { createDropdown } from './dropdown.ts';
import type { initLibrary } from './libraryPanel.ts';

type Library = ReturnType<typeof initLibrary>;
const ACTIVE_KEY = 'steminize.setlist.active';

export function initSetlists(deck: Deck, library: Library) {
  let lists = loadSetlists();
  let activeId: string | null = null;
  try {
    activeId = localStorage.getItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
  let metas = new Map<string, LibMeta>();
  let pending: { timer: number; tick: number } | null = null;
  /** Smooths an auto-advance transition instead of a hard cut: the ending song fades out over its
   * last FADE_S seconds, then the next one fades in from silence once it starts. Only for auto-
   * advance — opening a song any other way (a click, the transport) plays at full volume as normal. */
  const FADE_S = 1.2;
  let fadingOut = false;

  // Real <select>s: their open list is drawn by the OS and mostly ignores page CSS (plain white
  // regardless of theme, confirmed in Chromium and WebKitGTK alike), so these three use a custom
  // dropdown instead (see ui/dropdown.ts) that actually looks like the rest of the app.
  const mount = (id: string, dd: ReturnType<typeof createDropdown>) => {
    const placeholder = $(id);
    dd.el.id = id;
    dd.el.hidden = placeholder.hidden;
    placeholder.replaceWith(dd.el);
    return dd;
  };
  const select = mount('slSelect', createDropdown());
  const listEl = $('slList');
  containScroll(listEl);
  const info = $('slInfo');
  const addRow = $('slAddRow');
  const addSel = mount('slAdd', createDropdown());
  const transport = $('slTransport');
  const autoBox = $<HTMLInputElement>('slAuto');
  const gapSel = mount('slGap', createDropdown(GAPS.map((g) => ({ value: String(g), label: g ? `${g} s gap` : 'No gap' }))));
  const newBtn = $<HTMLButtonElement>('slNew');
  const renameBtn = $<HTMLButtonElement>('slRename');
  const delBtn = $<HTMLButtonElement>('slDelete');
  const prevBtn = $<HTMLButtonElement>('slPrev');
  const nextBtn = $<HTMLButtonElement>('slNext');
  const playBtn = $<HTMLButtonElement>('slPlay');

  const active = () => lists.find((l) => l.id === activeId) ?? null;
  const persist = () => saveSetlists(lists);
  const currentIndex = () => {
    const id = deck.current?.libId;
    const sl = active();
    return id && sl ? sl.songs.indexOf(id) : -1;
  };

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    clearInterval(pending.tick);
    pending = null;
    render();
  }

  /** Opens song `i` of the active setlist (restoring its own tempo, pitch, loop and mixer), and optionally plays it. */
  async function openAt(i: number, play: boolean) {
    const sl = active();
    const id = sl?.songs[i];
    if (!sl || !id) return;
    cancelPending();
    fadingOut = false; // a new song's own near-end can trigger its own fade later
    if (deck.current?.libId === id) {
      deck.player.pause();
      deck.player.seek(0);
    } else if (!(await library.openSong(id))) return;
    if (play) await deck.player.play();
    library.refresh(); // moves the highlight in the library list too
  }

  function summary(m: LibMeta): string {
    const st = m.state as DeckState | undefined;
    const pitch = st?.pitch ?? 0;
    return [
      fmtTime(m.seconds),
      m.analysis?.key ? keyName(m.analysis.key, pitch) : '',
      m.analysis ? `${Math.round(m.analysis.bpm)} BPM` : '',
      st && Math.abs(st.tempo - 1) > 0.005 ? `${Math.round(st.tempo * 100)}% speed` : '',
      pitch ? `${pitch > 0 ? '+' : ''}${pitch} st` : '',
      // A marked section is only "looping" while the loop is switched on; otherwise it's just a section.
      st?.loop && st.loop.b > st.loop.a ? `${st.loop.on ? 'looping' : 'section'} ${fmtTime(st.loop.a / SR)}–${fmtTime(st.loop.b / SR)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function row(sl: Setlist, id: string, i: number) {
    const m = metas.get(id)!;
    const ctl = (label: string, title: string, fn: () => void, off = false) => {
      const b = h('button', { class: 'sl-mv', type: 'button', title }, label) as HTMLButtonElement;
      b.disabled = off;
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      return b;
    };
    const move = (to: number) => {
      sl.songs = moveItem(sl.songs, i, to);
      persist();
      render();
    };
    const controls = h(
      'div',
      { class: 'sl-ctl' },
      ctl('↑', 'Move up', () => move(i - 1), i === 0),
      ctl('↓', 'Move down', () => move(i + 1), i === sl.songs.length - 1),
      ctl('×', 'Remove from the setlist (it stays in the library)', () => {
        sl.songs = sl.songs.filter((_, k) => k !== i);
        persist();
        render();
      }),
    );
    const li = h('li', { class: `track done sl-row${deck.current?.libId === id ? ' active' : ''}`, title: 'Open and play' }, h('div', { class: 't-name' }, `${i + 1}. ${m.title}`), controls, h('div', { class: 't-sub' }, summary(m)));
    li.onclick = () => void openAt(i, true);
    return li;
  }

  function render() {
    metas = new Map(library.songs().map((m) => [m.id, m]));
    // Songs deleted from the library drop out of every setlist. Only once the library has actually been read:
    // before that it is empty because it hasn't arrived, not because the songs are gone, and pruning then
    // would wipe every setlist on each page load.
    const ready = library.loaded();
    if (ready) {
      const ids = new Set(metas.keys());
      let changed = false;
      lists = lists.map((l) => {
        const p = pruneSongs(l, ids);
        if (p !== l) changed = true;
        return p;
      });
      if (changed) persist();
    }
    if (!lists.some((l) => l.id === activeId)) activeId = lists[0]?.id ?? null;

    const sl = ready ? active() : null;
    select.setOptions(lists.map((l) => ({ value: l.id, label: `${l.name} (${l.songs.length})` })));
    select.value = activeId ?? '';
    select.el.hidden = !lists.length;
    renameBtn.hidden = delBtn.hidden = !sl;
    listEl.replaceChildren(...(sl ? sl.songs.map((id, i) => row(sl, id, i)) : []));
    listEl.hidden = !sl?.songs.length;

    addRow.hidden = !sl;
    const free = [...metas.values()].filter((m) => !sl?.songs.includes(m.id)).sort((a, b) => a.title.localeCompare(b.title));
    addSel.setOptions([{ value: '', label: free.length ? 'Add a song…' : metas.size ? 'Every library song is in this setlist' : 'No songs in your library yet' }, ...free.map((m) => ({ value: m.id, label: m.title }))]);
    addSel.disabled = !free.length;

    transport.hidden = !sl?.songs.length;
    if (sl) {
      autoBox.checked = sl.auto;
      gapSel.value = String(sl.gap);
      gapSel.disabled = !sl.auto;
    }
    const idx = currentIndex();
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = !sl || nextSong(idx < 0 ? -1 : idx, sl.songs.length) === null && idx >= 0;

    if (!pending) {
      if (!ready) info.textContent = 'Loading your library…';
      else if (!metas.size) info.textContent = 'Separate or open some songs first, then order them here for a rehearsal or gig.';
      else if (!sl) info.textContent = 'Make a setlist to order songs from your library for a rehearsal or gig.';
      else if (!sl.songs.length) info.textContent = 'Add songs below. Each one reopens with its own tempo, key and loop.';
      else info.textContent = `${sl.songs.length} song${sl.songs.length > 1 ? 's' : ''} · ${fmtTime(totalSeconds(sl, (id) => metas.get(id)?.seconds))}`;
    }
  }

  // ---- managing setlists
  select.onChange = (v) => {
    activeId = v;
    try {
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      /* ignore */
    }
    cancelPending();
    render();
  };
  function startRename() {
    const sl = active();
    if (!sl) return;
    const input = h('input', { type: 'text', value: sl.name, maxLength: 80, class: 't-name-edit', 'aria-label': 'Setlist name' } as any) as HTMLInputElement;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== sl.name) {
        sl.name = uniqueName(v, lists.filter((l) => l !== sl).map((l) => l.name));
        persist();
      }
      input.replaceWith(select.el);
      render();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
    select.el.replaceWith(input);
    input.focus();
    input.select();
  }
  newBtn.onclick = () => {
    const sl = newSetlist(uniqueName('Setlist', lists.map((l) => l.name)));
    lists.push(sl);
    activeId = sl.id;
    persist();
    select.el.hidden = false;
    render();
    startRename();
  };
  renameBtn.onclick = startRename;
  delBtn.onclick = () => {
    if (!delBtn.classList.contains('confirm')) {
      delBtn.classList.add('confirm');
      delBtn.textContent = 'Delete?';
      setTimeout(() => {
        delBtn.classList.remove('confirm');
        delBtn.textContent = 'Delete';
      }, 3000);
      return;
    }
    delBtn.classList.remove('confirm');
    delBtn.textContent = 'Delete';
    lists = lists.filter((l) => l.id !== activeId);
    activeId = lists[0]?.id ?? null;
    persist();
    cancelPending();
    render();
  };
  addSel.onChange = (v) => {
    const sl = active();
    if (!sl || !v) return;
    sl.songs.push(v);
    persist();
    render();
  };
  autoBox.onchange = () => {
    const sl = active();
    if (!sl) return;
    sl.auto = autoBox.checked;
    persist();
    if (!sl.auto) cancelPending();
    render();
  };
  gapSel.onChange = (v) => {
    const sl = active();
    if (!sl) return;
    sl.gap = Number(v);
    persist();
  };

  // ---- playing through it
  playBtn.onclick = () => void openAt(0, true);
  nextBtn.onclick = () => {
    const sl = active();
    if (!sl) return;
    const idx = currentIndex();
    const n = idx < 0 ? 0 : nextSong(idx, sl.songs.length);
    if (n === null) toast("That's the last song in the setlist.");
    else void openAt(n, deck.player.state.playing);
  };
  prevBtn.onclick = () => void openAt(prevSong(currentIndex()), deck.player.state.playing);

  // Fades the ending song out over its last FADE_S seconds, instead of an auto-advance hard cut —
  // only once we know there's a next song to actually advance to; the setlist's last song, or a
  // song played outside auto-advance, just ends normally at full volume.
  deck.onNearEnd = (secondsLeft) => {
    const sl = active();
    const i = currentIndex();
    if (!sl || !sl.auto || i < 0 || fadingOut || secondsLeft > FADE_S) return;
    if (nextSong(i, sl.songs.length) === null) return;
    fadingOut = true;
    void deck.fadeVolume(0, Math.max(0, secondsLeft) * 1000);
  };

  // When a song plays to its end, move on to the next after the chosen gap.
  deck.onEnded = () => {
    const sl = active();
    const i = currentIndex();
    if (!sl || !sl.auto || i < 0) return;
    const n = nextSong(i, sl.songs.length);
    if (n === null) {
      toast('End of the setlist.');
      return;
    }
    cancelPending();
    const title = metas.get(sl.songs[n])?.title ?? 'the next song';
    // If the user pressed play on something themselves during the gap, leave them to it.
    const go = () => {
      const stillPlaying = deck.player.state.playing;
      cancelPending();
      if (stillPlaying) return;
      void (async () => {
        await openAt(n, false); // load it muted, so it's never heard at full volume even for an instant — openAt itself refreshes the library highlight
        await deck.fadeVolume(0, 0);
        await deck.player.play();
        await deck.fadeVolume(1, FADE_S * 1000);
      })();
    };
    let left = sl.gap;
    if (left <= 0) return go();
    info.textContent = `Next: ${title} in ${left} s…`;
    pending = {
      timer: window.setTimeout(go, left * 1000),
      tick: window.setInterval(() => {
        left--;
        if (left > 0) info.textContent = `Next: ${title} in ${left} s…`;
      }, 1000),
    };
  };

  // Keep the rows' tempo / key / loop summaries current as the open song is adjusted.
  let refreshTimer = 0;
  const previous = deck.onStateChange;
  deck.onStateChange = (s) => {
    previous(s);
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(render, 500);
  };
  library.onChange = render;
  render();
}
