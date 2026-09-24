import { MODELS, neededFiles, stemColour, type ModelId } from '../models.ts';
import { hasModel } from '../modelstore.ts';
import { DEFAULTS, saveSettings, type Settings } from '../settings.ts';
import { $, fmtMB, h, pressed } from './dom.ts';

export class SettingsPanel {
  onChange: () => void = () => {};

  constructor(public s: Settings) {
    const bindSelect = (id: keyof Settings, parse: (v: string) => any = (v) => v) => {
      $<HTMLSelectElement>(id).addEventListener('change', (e) => this.set({ [id]: parse((e.target as HTMLSelectElement).value) }));
    };
    bindSelect('precision');
    bindSelect('device');
    bindSelect('wavDepth');
    bindSelect('flacDepth');
    bindSelect('clip');
    bindSelect('mp3Bitrate', Number);
    bindSelect('twoStems');
    $<HTMLInputElement>('shifts').addEventListener('input', (e) => this.set({ shifts: Number((e.target as HTMLInputElement).value) }));
    $<HTMLInputElement>('overlap').addEventListener('input', (e) => this.set({ overlap: Number((e.target as HTMLInputElement).value) }));
    $('format').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).dataset.v;
      if (v) this.set({ format: v as Settings['format'] });
    });
    $('resetSettings').addEventListener('click', () => this.set({ ...DEFAULTS }));
    this.render();
  }

  set(patch: Partial<Settings>) {
    Object.assign(this.s, patch);
    const stems = MODELS[this.s.model].stems;
    if (this.s.twoStems && !stems.includes(this.s.twoStems)) this.s.twoStems = '';
    this.s.skipStems = this.s.skipStems.filter((x) => stems.includes(x));
    if (this.s.skipStems.length >= stems.length) this.s.skipStems = [];
    saveSettings(this.s);
    this.render();
    this.onChange();
  }

  async render() {
    const s = this.s;
    const info = MODELS[s.model];

    // Model cards
    const cards = $('modelCards');
    cards.replaceChildren(
      ...Object.values(MODELS).map((m) => {
        const size = m.files[s.precision].reduce((a, f) => a + f.bytes, 0);
        const meta = h('span', { class: 'meta' }, fmtMB(size));
        Promise.all(m.files[s.precision].map(hasModel)).then((have) => {
          if (have.every(Boolean)) meta.replaceChildren(h('span', { class: 'have' }, 'Downloaded'));
          else if (have.some(Boolean)) meta.textContent = 'Partly downloaded';
        });
        const b = h('button', { class: 'model-card', type: 'button' }, h('b', {}, m.label), meta, h('p', {}, m.blurb));
        pressed(b, m.id === s.model);
        b.onclick = () => this.set({ model: m.id as ModelId });
        return b;
      }),
    );

    // Stem mode
    const sel = $<HTMLSelectElement>('twoStems');
    sel.replaceChildren(
      h('option', { value: '' }, `All ${info.stems.length} stems`),
      ...info.stems.map((x) => h('option', { value: x }, x === 'vocals' ? 'Vocals + instrumental (karaoke)' : `${cap(x)} + everything else`)),
    );
    sel.value = s.twoStems;

    const toggles = $('stemToggles');
    toggles.hidden = !!s.twoStems;
    toggles.replaceChildren(
      ...info.stems.map((x) => {
        const b = h('button', { class: 'stem-chip', type: 'button', style: `--c:${stemColour(x)}`, title: 'Include this stem' }, x);
        pressed(b, !s.skipStems.includes(x));
        b.onclick = () => {
          const skip = s.skipStems.includes(x) ? s.skipStems.filter((y) => y !== x) : [...s.skipStems, x];
          this.set({ skipStems: skip });
        };
        return b;
      }),
    );

    // Simple controls
    const v = (id: string, val: string) => ($<HTMLInputElement>(id).value = val);
    v('shifts', String(s.shifts));
    v('overlap', String(s.overlap));
    $('shiftsOut').textContent = s.shifts === 1 ? '1 (off)' : String(s.shifts);
    $('overlapOut').textContent = `${Math.round(s.overlap * 100)}%`;
    v('precision', s.precision);
    v('device', s.device);
    v('wavDepth', s.wavDepth);
    v('flacDepth', s.flacDepth);
    v('mp3Bitrate', String(s.mp3Bitrate));
    v('clip', s.clip);
    for (const b of $('format').querySelectorAll('button')) pressed(b, b.dataset.v === s.format);
    $('wavDepthWrap').hidden = s.format !== 'wav';
    $('flacDepthWrap').hidden = s.format !== 'flac';
    $('mp3Wrap').hidden = s.format !== 'mp3';

    // Cost estimate
    const files = neededFiles(s.model, s.precision, s.twoStems, s.skipStems);
    const passes = files.length * s.shifts * (1 + (s.overlap - 0.25) * 1.2);
    const missing = (await Promise.all(files.map(async (f) => ((await hasModel(f)) ? 0 : f.bytes)))).reduce((a, b) => a + b, 0);
    const parts = [passes <= 1.05 ? 'Fastest setting.' : `About ${passes.toFixed(1)}× the time of the default.`];
    if (s.model === 'htdemucs_ft' && files.length < 4) parts.push(`Only runs the ${files.length} specialist model${files.length > 1 ? 's' : ''} needed.`);
    if (s.model === 'htdemucs_ft' && s.twoStems) parts.push('"Everything else" = original minus the stem.');
    if (missing) parts.push(`First run downloads ${fmtMB(missing)}.`);
    $('estimate').textContent = parts.join(' ');
  }
}

const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
