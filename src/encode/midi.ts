// Standard MIDI File writer (format 1: a tempo track plus one track per part).

import type { NoteEvent } from '../analysis/basicPitch.ts';

const PPQ = 480;

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const text = (s: string) => [...new TextEncoder().encode(s)];

function chunk(id: string, body: number[]) {
  const n = body.length;
  return [...text(id), (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...body];
}

export interface MidiTrack {
  name: string;
  notes: NoteEvent[];
  /** General MIDI program (0 = piano, 33 = fingered bass, 52 = choir aahs…). */
  program?: number;
  /** 9 for drums. */
  channel?: number;
}

/** Notes keep their exact times: the file's tempo is only for how bars line up in a DAW. */
export function writeMidi(tracks: MidiTrack[], bpm = 120): Uint8Array {
  const tick = (sec: number) => Math.max(0, Math.round((sec * bpm * PPQ) / 60));
  const usPerBeat = Math.round(60_000_000 / bpm);
  const tempo = [0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255];
  const timeSig = [0, 0xff, 0x58, 4, 4, 2, 24, 8]; // 4/4
  const tempoTrack = [...tempo, ...timeSig, 0, 0xff, 0x2f, 0];
  const chunks = [chunk('MThd', [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 255, PPQ & 255]), chunk('MTrk', tempoTrack)];
  tracks.forEach((t, i) => {
    const ch = t.channel ?? (i >= 9 ? i + 1 : i) % 16;
    const events: { at: number; bytes: number[]; order: number }[] = [];
    for (const n of t.notes) {
      const vel = Math.max(1, Math.min(127, Math.round(n.amp * 127)));
      const s = tick(n.start);
      const e = Math.max(s + 1, tick(n.end));
      events.push({ at: s, bytes: [0x90 | ch, n.pitch, vel], order: 1 });
      events.push({ at: e, bytes: [0x80 | ch, n.pitch, 0], order: 0 }); // note-offs first at equal times
    }
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    const name = text(t.name).slice(0, 120);
    const body = [0, 0xff, 0x03, ...vlq(name.length), ...name];
    if (ch !== 9) body.push(0, 0xc0 | ch, (t.program ?? 0) & 127);
    let last = 0;
    for (const ev of events) {
      body.push(...vlq(ev.at - last), ...ev.bytes);
      last = ev.at;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk('MTrk', body));
  });
  return Uint8Array.from(chunks.flat());
}

/** A sensible General MIDI instrument for a stem name. */
export function programFor(name: string) {
  const n = name.toLowerCase();
  if (/bass/.test(n)) return 33;
  if (/vox|vocal|voice|sing/.test(n)) return 53; // voice oohs
  if (/gtr|guitar/.test(n)) return 25;
  if (/organ/.test(n)) return 16;
  if (/synth/.test(n)) return 81;
  return 0; // piano
}

/**
 * A MIDI file that is only a tempo map: the tempo and bar length at the start, any tempo changes (each at a whole beat, counted in
 * quarter notes from the start), and markers at times in seconds. A DAW can import it to set up its tempo grid and marker list.
 */
export function writeMidiTempoMap(o: {
  bpm: number;
  perBar: number;
  changes?: { beat: number; bpm: number }[];
  markers?: { name: string; time: number }[];
  seconds?: number;
}): Uint8Array {
  const segs = [{ beat: 0, bpm: o.bpm }, ...(o.changes ?? []).filter((c) => c.beat > 0)].sort((a, b) => a.beat - b.beat);
  /** The tick at a time in seconds, walking through the tempo segments. */
  const tickAt = (sec: number) => {
    let t = 0;
    let beat = 0;
    for (let i = 0; i < segs.length; i++) {
      const next = i + 1 < segs.length ? segs[i + 1].beat : Infinity;
      const secPerBeat = 60 / segs[i].bpm;
      const room = (next - segs[i].beat) * secPerBeat;
      if (sec - t <= room || next === Infinity) {
        beat = segs[i].beat + (sec - t) / secPerBeat;
        break;
      }
      t += room;
      beat = next;
    }
    return Math.max(0, Math.round(beat * PPQ));
  };
  const events: { at: number; order: number; bytes: number[] }[] = [];
  const perBar = Math.max(1, Math.min(32, Math.round(o.perBar)));
  events.push({ at: 0, order: 0, bytes: [0xff, 0x58, 4, perBar, 2, 24, 8] }); // perBar/4
  for (const sg of segs) {
    const us = Math.round(60_000_000 / sg.bpm);
    events.push({ at: Math.round(sg.beat * PPQ), order: 1, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  for (const m of o.markers ?? []) {
    const name = text(m.name.replace(/[\r\n]+/g, ' ').slice(0, 120));
    events.push({ at: tickAt(m.time), order: 2, bytes: [0xff, 0x06, ...vlq(name.length), ...name] });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const title = text('Tempo map');
  const body = [0, 0xff, 0x03, ...vlq(title.length), ...title];
  let last = 0;
  for (const ev of events) {
    body.push(...vlq(ev.at - last), ...ev.bytes);
    last = ev.at;
  }
  const end = Math.max(last, o.seconds != null ? tickAt(o.seconds) : last);
  body.push(...vlq(end - last), 0xff, 0x2f, 0);
  return Uint8Array.from([...chunk('MThd', [0, 1, 0, 1, (PPQ >> 8) & 255, PPQ & 255]), ...chunk('MTrk', body)]);
}
