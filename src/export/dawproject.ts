// Send to DAW, DAWproject: the open project format (https://github.com/bitwig/dawproject) that Bitwig Studio, Studio One, Cubase 14 and
// others open. A .dawproject file is a ZIP holding project.xml, metadata.xml and the audio. The project.xml written here follows the
// published schema (Project.xsd, checked with xmllint) and the structure of the example in the format's own README.
// No browser needed, so it is tested.

import type { DawProject } from './daw.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (x: number, digits = 6) => String(Number(x.toFixed(digits)));

/** The path of an audio file inside the .dawproject ZIP. */
export const dawprojectAudioPath = (file: string) => `audio/${file}`;

export function dawprojectMetadata(p: DawProject): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MetaData>\n  <Title>${esc(p.title)}</Title>\n  <Comment>Sent from Steminize. The stems are the separated tracks of the song.</Comment>\n</MetaData>\n`;
}

/**
 * The project.xml. Time is in seconds, so the audio plays in real time and needs no warping: each stem is one clip, placed after the
 * lead-in. The tempo and bar length are set so the DAW's grid matches the music; markers (and the loop's ends) are markers.
 */
export function dawprojectXml(p: DawProject, version = '0.9'): string {
  const bpm = p.bpm > 0 ? p.bpm : 120;
  let next = 0;
  const id = () => `id${next++}`;
  const out: string[] = [];
  const L = (indent: number, s: string) => out.push(`${'  '.repeat(indent)}${s}`);
  const tempoId = id();
  const sigId = id();
  const masterTrackId = id();
  const masterChannelId = id();
  const trackIds = p.tracks.map(() => ({ track: id(), channel: id() }));

  L(0, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  L(0, '<Project version="1.0">');
  L(1, `<Application name="Steminize" version="${esc(version)}"/>`);
  L(1, '<Transport>');
  L(2, `<Tempo max="666.000000" min="20.000000" unit="bpm" value="${n(bpm, 4)}" id="${tempoId}" name="Tempo"/>`);
  L(2, `<TimeSignature denominator="4" numerator="${Math.max(1, Math.round(p.perBar))}" id="${sigId}"/>`);
  L(1, '</Transport>');
  L(1, '<Structure>');
  const param = (kind: 'Mute' | 'Pan' | 'Volume', value: string) =>
    kind === 'Mute'
      ? `<Mute value="${value}" id="${id()}" name="Mute"/>`
      : kind === 'Pan'
        ? `<Pan max="1.000000" min="0.000000" unit="normalized" value="${value}" id="${id()}" name="Pan"/>`
        : `<Volume max="2.000000" min="0.000000" unit="linear" value="${value}" id="${id()}" name="Volume"/>`;
  p.tracks.forEach((t, i) => {
    L(2, `<Track contentType="audio" loaded="true" id="${trackIds[i].track}" name="${esc(t.name)}" color="${esc(t.colour)}">`);
    L(3, `<Channel audioChannels="2" destination="${masterChannelId}" role="regular" solo="${t.solo ? 'true' : 'false'}" id="${trackIds[i].channel}">`);
    L(4, param('Mute', t.mute ? 'true' : 'false'));
    L(4, param('Pan', n(Math.max(0, Math.min(1, (t.pan + 1) / 2)), 6)));
    L(4, param('Volume', n(Math.max(0, Math.min(2, t.vol)), 6)));
    L(3, '</Channel>');
    L(2, '</Track>');
  });
  L(2, `<Track contentType="audio notes" loaded="true" id="${masterTrackId}" name="Master">`);
  L(3, `<Channel audioChannels="2" role="master" solo="false" id="${masterChannelId}">`);
  L(4, param('Mute', 'false'));
  L(4, param('Pan', '0.500000'));
  L(4, param('Volume', '1.000000'));
  L(3, '</Channel>');
  L(2, '</Track>');
  L(1, '</Structure>');
  L(1, `<Arrangement id="${id()}">`);
  L(2, `<Lanes timeUnit="seconds" id="${id()}">`);
  p.tracks.forEach((t, i) => {
    L(3, `<Lanes track="${trackIds[i].track}" id="${id()}">`);
    L(4, `<Clips id="${id()}">`);
    L(5, `<Clip time="${n(p.padSec)}" duration="${n(p.seconds)}" contentTimeUnit="seconds" playStart="0.0" name="${esc(t.name)}">`);
    L(6, `<Audio channels="2" duration="${n(p.seconds)}" sampleRate="${p.sampleRate}" id="${id()}">`);
    L(7, `<File path="${esc(dawprojectAudioPath(t.file))}"/>`);
    L(6, '</Audio>');
    L(5, '</Clip>');
    L(4, '</Clips>');
    L(3, '</Lanes>');
  });
  L(3, `<Lanes track="${masterTrackId}" id="${id()}">`);
  L(4, `<Clips id="${id()}"/>`);
  L(3, '</Lanes>');
  L(2, '</Lanes>');
  const marks = [...p.markers.map((m) => ({ name: m.name, time: m.time }))];
  if (p.loop) marks.push({ name: 'Loop start', time: p.loop.start }, { name: 'Loop end', time: p.loop.end });
  marks.sort((a, b) => a.time - b.time);
  if (marks.length) {
    L(2, `<Markers timeUnit="seconds" id="${id()}">`);
    for (const m of marks) L(3, `<Marker time="${n(m.time)}" name="${esc(m.name)}"/>`);
    L(2, '</Markers>');
  }
  L(1, '</Arrangement>');
  L(1, '<Scenes/>');
  L(0, '</Project>');
  return `${out.join('\n')}\n`;
}
