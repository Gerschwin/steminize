// The Learn drawer: practise a song the way the method says to. Pick a section (a marker), split it into chunks of a bar or a few bars,
// loop one chunk at a time, and count clean passes in a row; at the target the chunk is done and the next one starts. The rules are in
// src/learn/learn.ts; this is the screen and the glue to the player (through the host, the way the transcription panel does it).

import {
  addClean, addMiss, addPass, chunksOf, mergeMarkers, firstUnfinished, newProgress, readLearn, sameSpan, sectionStatus, sectionsFromMarkers, spanKey, stitch,
  type ChunkSize, type LearnState, type Progress, type Section, type Span, type Status,
} from '../learn/learn.ts';
import { $, fmtTime, h, toast } from './dom.ts';


export interface LearnHost {
  sr: number;
  /** Length of the song in frames. */
  length(): number;
  markers(): { name: string; pos: number }[];
  /** Where each bar starts, in frames (empty with no detected tempo). */
  bars(): number[];
  loop(): { on: boolean; a: number; b: number };
  /** Loops [a, b), jumps to its start and plays. */
  playLoop(a: number, b: number): void;
  /** The tab Trainer is on and listening, so it can judge passes. */
  trainerJudging(): boolean;
  /** Listens to the song and returns its sections (positions in frames), or why it could not. */
  suggest(): Promise<{ name: string; pos: number; bars: number }[] | 'no-tempo' | 'too-short'>;
  /** Replaces the song's section markers. */
  setMarkers(markers: { name: string; pos: number }[]): void;
  changed(): void;
}

const MARK: Record<Status, string> = { new: '○', learning: '◐', solid: '✓' };
const STATUS_TEXT: Record<Status, string> = { new: 'New', learning: 'Learning', solid: 'Solid' };

export class LearnPanel {
  private state: LearnState = readLearn(undefined);
  private sections: Section[] = [];
  private sectionIdx = 0;
  private chunks: Span[] = [];
  private chunkIdx = 0;
  /** How many chunks after the current one are stitched on. */
  private extra = 0;
  private lastLoopKey = '';

  constructor(private host: LearnHost) {
    $('learnSize').onchange = () => {
      this.state.size = Number(($('learnSize') as HTMLSelectElement).value) as ChunkSize;
      this.extra = 0;
      this.rebuildChunks();
      this.chunkIdx = firstUnfinished(this.chunks, this.state.progress, this.host.sr);
      this.save();
    };
    $('learnSection').onchange = () => this.selectSection(Number(($('learnSection') as HTMLSelectElement).value));
    $('learnPrev').onclick = () => this.step(-1);
    $('learnNext').onclick = () => this.step(1);
    $('learnLoop').onclick = () => this.loopCurrent();
    $('learnStitch').onclick = () => this.stitchMore(1);
    $('learnUnstitch').onclick = () => this.stitchMore(-1);
    $('learnNailed').onclick = () => this.nailed();
    $('learnMissed').onclick = () => this.missed();
    $('learnTarget').onchange = () => {
      this.state.target = readLearn({ target: Number(($('learnTarget') as HTMLInputElement).value) }).target;
      this.save();
    };
    $('learnAuto').onchange = () => {
      this.state.auto = ($('learnAuto') as HTMLInputElement).checked;
      this.save();
    };
    $('learnAdvance').onchange = () => {
      this.state.advance = ($('learnAdvance') as HTMLInputElement).checked;
      this.save();
    };
    $('learnSuggest').onclick = () => void this.suggest();
    $('learnSuggestClose').onclick = () => (($('learnSuggestBox') as HTMLElement).hidden = true);
    $('learnSuggestAdd').onclick = () => this.useSuggestions(false);
    $('learnSuggestReplace').onclick = () => this.useSuggestions(true);
    $('learnResetChunk').onclick = () => {
      delete this.state.progress[this.key()];
      this.save();
    };
  }

  // ---------- suggested sections ----------
  private suggested: { name: string; pos: number; bars: number }[] = [];

  private async suggest() {
    const btn = $('learnSuggest') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Listening…';
    try {
      const r = await this.host.suggest();
      if (r === 'no-tempo') toast('No tempo yet: open Tempo & key so the bars are known, then try again', true);
      else if (r === 'too-short' || !r.length) toast('Not enough bars to find a structure in this song', true);
      else {
        this.suggested = r;
        this.renderSuggestions();
      }
    } catch (e) {
      toast(`Couldn't find the sections: ${(e as Error).message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Suggest sections';
    }
  }

  private renderSuggestions() {
    const sr = this.host.sr;
    ($('learnSuggestBox') as HTMLElement).hidden = false;
    ($('learnSuggestList') as HTMLElement).replaceChildren(
      ...this.suggested.map((s, i) => {
        const input = h('input', { type: 'text', value: s.name, maxLength: 30, 'aria-label': `Name of the section at ${fmtTime(s.pos / sr)}` } as any) as HTMLInputElement;
        input.oninput = () => (this.suggested[i].name = input.value.trim() || s.name);
        return h('div', { class: 'learn-row' }, h('span', { class: 'muted small learn-time' }, fmtTime(s.pos / sr)), input, h('span', { class: 'muted small' }, `${s.bars} bar${s.bars === 1 ? '' : 's'}`));
      }),
    );
  }

  private useSuggestions(replace: boolean) {
    const existing = this.host.markers();
    if (replace && existing.length && !confirm(`Replace your ${existing.length} marker${existing.length === 1 ? '' : 's'} with ${this.suggested.length} suggested sections?`)) return;
    const merged = mergeMarkers(existing, this.suggested.map((s) => ({ name: s.name, pos: s.pos })), replace, this.host.sr);
    this.host.setMarkers(merged);
    ($('learnSuggestBox') as HTMLElement).hidden = true;
    toast(`${replace ? 'Replaced the markers with' : 'Added'} ${this.suggested.length} section${this.suggested.length === 1 ? '' : 's'}`);
  }

  // ---------- the song ----------
  /** A song has been opened (or closed, with no state): reads its saved progress and builds the sections. */
  open(raw: unknown) {
    this.state = readLearn(raw);
    this.extra = 0;
    this.sectionIdx = 0;
    this.chunkIdx = 0;
    this.rebuildSections();
    const firstOpen = this.sections.findIndex((s, i) => this.statusOf(i) !== 'solid');
    this.sectionIdx = firstOpen < 0 ? 0 : firstOpen;
    this.rebuildChunks();
    this.chunkIdx = firstUnfinished(this.chunks, this.state.progress, this.host.sr);
    this.render();
  }

  getState(): LearnState {
    return this.state;
  }

  /** The markers or the bar grid changed: rebuild the sections and chunks, keeping the place if it still exists. */
  refresh() {
    const keep = this.sections[this.sectionIdx]?.a;
    this.rebuildSections();
    const i = this.sections.findIndex((s) => keep !== undefined && Math.abs(s.a - keep) < this.host.sr / 4);
    this.sectionIdx = i >= 0 ? i : Math.min(this.sectionIdx, Math.max(0, this.sections.length - 1));
    this.rebuildChunks();
    this.chunkIdx = Math.min(this.chunkIdx, Math.max(0, this.chunks.length - 1));
    this.render();
  }

  private rebuildSections() {
    this.sections = this.host.length() ? sectionsFromMarkers(this.host.markers(), this.host.length(), this.host.sr) : [];
  }

  private rebuildChunks() {
    const s = this.sections[this.sectionIdx];
    this.chunks = s ? chunksOf(s, this.state.size, this.host.bars(), this.host.sr) : [];
  }

  private chunksOfSection(i: number): Span[] {
    const s = this.sections[i];
    return s ? chunksOf(s, this.state.size, this.host.bars(), this.host.sr) : [];
  }

  private sectionKey(i: number) {
    return spanKey({ a: this.sections[i].a, b: this.sections[i].a }, this.host.sr);
  }

  private statusOf(i: number): Status {
    return sectionStatus(this.chunksOfSection(i), this.state.progress, this.host.sr, !!this.state.solid[this.sectionKey(i)]);
  }

  // ---------- what is being practised ----------
  /** The stretch being practised: the current chunk, with any stitched ones after it. */
  private range(): Span | null {
    if (!this.chunks.length) return null;
    return stitch(this.chunks, this.chunkIdx, Math.min(this.chunks.length - 1, this.chunkIdx + this.extra));
  }

  private key() {
    const r = this.range();
    return r ? spanKey(r, this.host.sr) : '';
  }

  private progress(): Progress {
    return this.state.progress[this.key()] ?? newProgress();
  }

  private setProgress(p: Progress) {
    const k = this.key();
    if (k) this.state.progress[k] = p;
  }

  /** The loop is set to exactly the stretch being practised, so passes count. */
  private looping(): boolean {
    const r = this.range();
    const l = this.host.loop();
    return !!r && l.on && sameSpan(r, { a: l.a, b: l.b }, this.host.sr);
  }

  /** The tab Trainer is deciding which passes are clean, so the buttons stand aside. */
  private judgedByTrainer() {
    return this.state.auto && this.host.trainerJudging();
  }

  wantsJudging() {
    return this.judgedByTrainer() && this.looping();
  }

  // ---------- doing things ----------
  private selectSection(i: number) {
    if (i < 0 || i >= this.sections.length) return;
    this.sectionIdx = i;
    this.extra = 0;
    this.rebuildChunks();
    this.chunkIdx = firstUnfinished(this.chunks, this.state.progress, this.host.sr);
    this.render();
    this.host.changed();
  }

  private step(d: number) {
    this.extra = 0;
    let i = this.chunkIdx + d;
    if (i >= this.chunks.length && this.sectionIdx + 1 < this.sections.length) {
      this.selectSection(this.sectionIdx + 1);
      this.chunkIdx = 0;
      this.afterMove();
      return;
    }
    if (i < 0 && this.sectionIdx > 0) {
      this.sectionIdx -= 1;
      this.rebuildChunks();
      i = this.chunks.length - 1;
    }
    this.chunkIdx = Math.max(0, Math.min(this.chunks.length - 1, i));
    this.afterMove();
  }

  /** After moving to another chunk: if the loop was following the last one, it moves too. */
  private afterMove() {
    this.render();
    if (this.host.loop().on) this.loopCurrent();
  }

  /** Whether the pane is open, for the keys that only mean something there. */
  isOpen() {
    return !($('learnPane') as HTMLElement).hidden;
  }

  next() {
    this.step(1);
  }
  prev() {
    this.step(-1);
  }

  private stitchMore(d: number) {
    const last = this.chunks.length - 1 - this.chunkIdx;
    this.extra = Math.max(0, Math.min(last, this.extra + d));
    this.render();
    if (this.host.loop().on) this.loopCurrent();
  }

  private loopCurrent() {
    const r = this.range();
    if (!r) return;
    this.host.playLoop(r.a, r.b);
    this.render();
  }

  /** A loop pass has been played: it counts, if the loop is the chunk being practised. */
  onPass() {
    if (!this.looping()) return;
    this.setProgress(addPass(this.progress()));
    this.render();
    this.save(false);
  }

  /** The tab Trainer has scored the pass just played: clean if it meets the accuracy asked for. */
  onJudged(fraction: number, needed: number) {
    if (!this.wantsJudging()) return;
    if (fraction >= needed) this.clean();
    else this.miss();
  }

  nailed() {
    if (this.judgedByTrainer() && this.looping()) {
      toast('The tab Trainer is judging your passes. Untick "Let the tab Trainer judge" to press this yourself');
      return;
    }
    this.clean();
  }

  missed() {
    if (this.judgedByTrainer() && this.looping()) return;
    this.miss();
  }

  private clean() {
    const r = addClean(this.progress(), this.state.target);
    this.setProgress(r.progress);
    if (r.reached) this.finished();
    else {
      this.render();
      this.save(false);
    }
  }

  private miss() {
    this.setProgress(addMiss(this.progress()));
    this.render();
    this.save(false);
  }

  /** The target was reached: say so, mark it, and (if asked) go on to the next chunk that is not done. */
  private finished() {
    const sectionDone = this.statusOf(this.sectionIdx) === 'solid';
    this.save(false);
    if (!this.state.advance) {
      toast(`Done: ${this.state.target} clean passes in a row`);
      this.render();
      return;
    }
    // The next chunk (or section) that still needs work.
    this.extra = 0;
    const nextHere = this.chunks.findIndex((c, i) => i > this.chunkIdx && !this.state.progress[spanKey(c, this.host.sr)]?.done);
    if (nextHere >= 0) {
      this.chunkIdx = nextHere;
      toast(`Done. On to chunk ${nextHere + 1} of ${this.chunks.length}`);
    } else {
      const nextSection = this.sections.findIndex((_, i) => i > this.sectionIdx && this.statusOf(i) !== 'solid');
      if (nextSection >= 0) {
        toast(`${this.sections[this.sectionIdx].name} is solid. On to ${this.sections[nextSection].name}`);
        this.selectSection(nextSection);
      } else if (sectionDone) {
        toast('Everything is solid. Now play the song through!');
        this.render();
        return;
      } else {
        toast('Done. Some earlier chunks are still to do');
        this.chunkIdx = firstUnfinished(this.chunks, this.state.progress, this.host.sr);
      }
    }
    this.render();
    if (this.host.loop().on) this.loopCurrent();
  }

  private save(redraw = true) {
    this.host.changed();
    if (redraw) this.render();
  }

  // ---------- drawing ----------
  render() {
    const sr = this.host.sr;
    const has = this.sections.length > 0 && this.chunks.length > 0;
    ($('learnEmpty') as HTMLElement).hidden = has;
    ($('learnBody') as HTMLElement).hidden = !has;
    if (!has) {
      $('sumLearn').textContent = '';
      return;
    }
    ($('learnSize') as HTMLSelectElement).value = String(this.state.size);
    ($('learnTarget') as HTMLInputElement).value = String(this.state.target);
    ($('learnAuto') as HTMLInputElement).checked = this.state.auto;
    ($('learnAdvance') as HTMLInputElement).checked = this.state.advance;

    const sel = $('learnSection') as HTMLSelectElement;
    sel.replaceChildren(...this.sections.map((s, i) => h('option', { value: String(i) }, `${MARK[this.statusOf(i)]} ${s.name}`)));
    sel.value = String(this.sectionIdx);

    const r = this.range()!;
    const bars = this.host.bars();
    const barOf = (f: number) => bars.findIndex((b) => Math.abs(b - f) < sr / 8) + 1;
    const b0 = barOf(r.a);
    const b1 = barOf(r.b) - 1;
    const where = b0 > 0 && b1 >= b0 ? (b1 > b0 ? `bars ${b0}–${b1}` : `bar ${b0}`) : `${fmtTime(r.a / sr)}–${fmtTime(r.b / sr)}`;
    const stitched = this.extra ? ` (${this.extra + 1} chunks stitched)` : '';
    $('learnWhere').textContent = `Chunk ${this.chunkIdx + 1}${this.extra ? `–${this.chunkIdx + 1 + this.extra}` : ''} of ${this.chunks.length} · ${where}${stitched}`;
    ($('learnPrev') as HTMLButtonElement).disabled = this.sectionIdx === 0 && this.chunkIdx === 0;
    ($('learnNext') as HTMLButtonElement).disabled = this.sectionIdx === this.sections.length - 1 && this.chunkIdx >= this.chunks.length - 1;
    ($('learnStitch') as HTMLButtonElement).disabled = this.chunkIdx + this.extra >= this.chunks.length - 1;
    ($('learnUnstitch') as HTMLButtonElement).disabled = this.extra === 0;

    const p = this.progress();
    const looping = this.looping();
    $('learnStreak').textContent = String(p.streak);
    $('learnOf').textContent = `of ${this.state.target} clean passes in a row`;
    $('learnStats').textContent = `${p.passes} play${p.passes === 1 ? '' : 's'} · best run ${p.best}${p.done ? ' · done ✓' : ''}`;
    ($('learnBar') as HTMLElement).style.width = `${Math.min(100, (100 * p.streak) / this.state.target)}%`;
    const judged = this.judgedByTrainer() && looping;
    ($('learnNailed') as HTMLButtonElement).disabled = judged;
    ($('learnMissed') as HTMLButtonElement).disabled = judged;
    ($('learnHint') as HTMLElement).textContent = !looping
      ? 'Press "Loop this chunk" so the plays and your clean passes are counted for it.'
      : judged
        ? 'The tab Trainer is judging each pass: it counts as clean when the accuracy is high enough.'
        : 'Press Nailed it (N) after a clean pass, or Missed (X) to start the run again.';
    ($('learnLoop') as HTMLButtonElement).classList.toggle('primary', !looping);
    ($('learnAutoWrap') as HTMLElement).title = this.host.trainerJudging() ? 'The tab Trainer is on and listening' : 'Needs the tab Trainer (Scratchpad) and Live input turned on';

    const here = this.statusOf(this.sectionIdx);
    const done = this.chunks.filter((c) => this.state.progress[spanKey(c, sr)]?.done).length;
    $('sumLearn').textContent = `${this.sections[this.sectionIdx].name} · ${here === 'solid' ? 'solid' : `${done}/${this.chunks.length}`}`;

    // The checkpoints.
    ($('learnList') as HTMLElement).replaceChildren(
      ...this.sections.map((s, i) => {
        const st = this.statusOf(i);
        const cs = this.chunksOfSection(i);
        const d = cs.filter((c) => this.state.progress[spanKey(c, sr)]?.done).length;
        const go = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Work on this section' }, i === this.sectionIdx ? 'Here' : 'Learn');
        go.onclick = () => {
          this.selectSection(i);
          if (this.host.loop().on) this.loopCurrent();
        };
        const solid = h('button', { class: 'btn tiny ghost', type: 'button', title: st === 'solid' ? 'Put it back to learning' : 'Mark this section solid: you have got it' }, st === 'solid' && this.state.solid[this.sectionKey(i)] ? 'Undo solid' : 'Mark solid');
        solid.onclick = () => {
          const k = this.sectionKey(i);
          if (this.state.solid[k]) delete this.state.solid[k];
          else this.state.solid[k] = true;
          this.save();
        };
        const reset = h('button', { class: 'btn tiny ghost', type: 'button', title: 'Forget the progress in this section' }, 'Reset');
        reset.onclick = () => {
          for (const c of cs) delete this.state.progress[spanKey(c, sr)];
          delete this.state.solid[this.sectionKey(i)];
          this.save();
        };
        return h(
          'div',
          { class: `learn-row ${st}${i === this.sectionIdx ? ' current' : ''}` },
          h('span', { class: 'learn-mark', title: STATUS_TEXT[st] }, MARK[st]),
          h('span', { class: 'learn-name' }, s.name),
          h('span', { class: 'muted small' }, `${fmtTime(s.a / sr)} · ${st === 'solid' ? 'solid' : `${d} of ${cs.length} chunks`}`),
          h('span', { class: 'learn-prog' }, h('i', { style: `width:${cs.length ? Math.round((100 * (st === 'solid' ? cs.length : d)) / cs.length) : 0}%` })),
          go,
          solid,
          reset,
        );
      }),
    );
    this.lastLoopKey = this.key();
  }

  /** The loop was moved, or turned on or off, outside this panel: redraw only if that changes whether it matches the chunk. */
  loopChanged() {
    const k = `${this.key()}|${this.looping()}`;
    if (k !== this.lastLoopKey) {
      this.lastLoopKey = k;
      this.render();
    }
  }
}
