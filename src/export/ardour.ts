// Send to DAW, Ardour: a whole Ardour session folder (the .ardour file and the audio where Ardour keeps it) for Ardour 8 and later.
// The skeleton and the stereo track are what Ardour itself writes (see ardourTemplate.ts and tools/make-ardour-template.py); this fills
// in the song: a track per stem with its level, pan, mute and solo and colour, the audio regions at the right place, the markers and
// loop, and the tempo and bars. No browser needed, so it is tested.

import type { DawProject } from './daw.ts';
import { ARDOUR_ROUTE, ARDOUR_SKELETON } from './ardourTemplate.ts';

/** Ardour counts time in "superclocks": 282,240,000 to the second. An "a" in front marks a time in audio time. */
const SUPERCLOCK = 282_240_000;
const sc = (sec: number) => `a${Math.max(0, Math.round(sec * SUPERCLOCK))}`;
/** Ardour's default region fade is 64 samples. */
const FADE_SC = Math.round((64 / 44100) * SUPERCLOCK);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A session name Ardour accepts: it becomes a folder and a file name, so no path or reserved characters. */
export function ardourSessionName(title: string): string {
  const n = title.replace(/[\\/:;|<>?*"'%,\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return n || 'Steminize song';
}

/** Ardour keeps a colour as 0xRRGGBBAA in one number. */
export function ardourColour(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0xaaaaaaff;
  return (((parseInt(m[1], 16) << 24) | (parseInt(m[2], 16) << 16) | (parseInt(m[3], 16) << 8) | 0xff) >>> 0);
}

function uuid(seed: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ (seed.charCodeAt(i) + k), 0x01000193) >>> 0;
    out.push(h.toString(16).padStart(8, '0'));
  }
  const x = out.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

export interface ArdourSession {
  /** The session's file and folder name (no extension). */
  name: string;
  /** The text of `<name>/<name>.ardour`. */
  xml: string;
  /** Folders that must exist in the session, relative to its folder. */
  dirs: string[];
  /** Where the audio files go, relative to the session folder. */
  audioDir: string;
}

/**
 * The session for a project. `p.tracks[i].file` is the audio file's name (a stereo WAV), `p.padSec` is where the stems start on the
 * timeline, `p.seconds` the length of each. Times in `p.markers` and `p.loop` are already on the timeline.
 */
export function ardourSession(p: DawProject, now = 1_700_000_000): ArdourSession {
  const name = ardourSessionName(p.title);
  let nextId = 1000;
  const id = () => String(nextId++);
  const bpm = p.bpm > 0 ? p.bpm : 120;
  const rate = p.sampleRate;
  const lenSec = p.seconds;
  const endSec = p.padSec + lenSec;

  const sources: string[] = [];
  const regions: string[] = [];
  const playlists: string[] = [];
  const routes: string[] = [];
  const used = new Set<string>();

  p.tracks.forEach((t, i) => {
    // Track names must be unique in a session (they name the ports).
    let tname = t.name.replace(/[\\/:;|<>?*"%]/g, ' ').replace(/\s+/g, ' ').trim() || `Track ${i + 1}`;
    let n = 2;
    while (used.has(tname.toLowerCase())) tname = `${t.name} ${n++}`;
    used.add(tname.toLowerCase());

    const src0 = id();
    const src1 = id();
    for (const [ch, sid] of [[0, src0], [1, src1]] as const) {
      sources.push(`<Source name="${esc(t.file)}" take-id="" type="audio" flags="" id="${sid}" natural-position="a0" channel="${ch}" origin="${esc(t.file)}" gain="1"/>`);
    }
    const region = (whole: boolean) => {
      const rid = id();
      const [envId, fiId, ifiId, foId, ofoId] = [id(), id(), id(), id(), id()];
      const len = sc(lenSec);
      const list = (aid: string, aname: string, style: string, events: string) =>
        `<AutomationList automation-id="${aname}" id="${aid}" interpolation-style="${style}" time-domain="AudioTime" state="Off"><events>${events}\n</events></AutomationList>`;
      return (
        `<Region name="${esc(tname)}" muted="0" opaque="1" locked="0" video-locked="0" automatic="0" whole-file="${whole ? 1 : 0}" import="0" external="0" sync-marked="0" left-of-split="0" right-of-split="0" hidden="0" position-locked="0" valid-transients="0" start="a0" length="${len}@${whole ? 'a0' : sc(p.padSec)}" sync-position="a0" ancestral-start="a0" ancestral-length="a0@a0" stretch="1" shift="1" layering-index="0" tags="" contents="0" rgroup="0" envelope-active="0" default-fade-in="0" default-fade-out="0" fade-in-active="1" fade-out-active="1" fade-before-fx="0" scale-amplitude="1" id="${rid}" type="audio" first-edit="nothing" source-0="${src0}" source-1="${src1}" master-source-0="${src0}" master-source-1="${src1}" channels="2">` +
        `<Envelope>${list(envId, 'envelope', 'Exponential', `a0 1\n${len} 1`)}</Envelope>` +
        `<FadeIn>${list(fiId, 'fadein', 'Curved', `a0 1.0000000116860974e-07\na${FADE_SC} 1`)}</FadeIn>` +
        `<InverseFadeIn>${list(ifiId, 'fadein', 'Curved', `a0 1\na${FADE_SC} 1.0000000116860974e-07`)}</InverseFadeIn>` +
        `<FadeOut>${list(foId, 'fadeout', 'Curved', `a0 1\na${FADE_SC} 1.0000000116860974e-07`)}</FadeOut>` +
        `<InverseFadeOut>${list(ofoId, 'fadeout', 'Curved', `a0 1.0000000116860974e-07\na${FADE_SC} 1`)}</InverseFadeOut>` +
        `</Region>`
      );
    };
    regions.push(region(true));
    const playlistId = id();
    const routeIds = ARDOUR_ROUTE.match(/\{\{I\d+\}\}/g) ?? [];
    const idMap = new Map<string, string>();
    for (const tok of routeIds) if (!idMap.has(tok)) idMap.set(tok, id());
    const routeId = idMap.get('{{I0}}')!; // the first id in the template is the route's own
    playlists.push(
      `<Playlist id="${playlistId}" name="${esc(tname)}" type="audio" orig-track-id="${routeId}" pgroup-id="" shared-with-ids="" frozen="0" combine-ops="0">${region(false)}</Playlist>`,
    );
    const pan = Math.max(0, Math.min(1, (t.pan + 1) / 2));
    const filled = ARDOUR_ROUTE.replace(/\{\{I\d+\}\}/g, (tok) => idMap.get(tok) ?? tok)
      .replace(/\{\{NAME\}\}/g, esc(tname))
      .replace(/\{\{PLAYLIST\}\}/g, playlistId)
      .replace(/\{\{ORDER\}\}/g, String(i + 1))
      .replace(/\{\{COLOR\}\}/g, String(ardourColour(t.colour)))
      .replace(/\{\{MUTED\}\}/g, t.mute ? '1' : '0')
      .replace(/\{\{SOLO\}\}/g, t.solo ? '1' : '0')
      .replace(/\{\{GAIN\}\}/g, String(Math.max(0, Number(t.vol.toFixed(5)))))
      .replace(/\{\{PAN\}\}/g, String(Number(pan.toFixed(5))));
    routes.push(filled);
  });

  const locId = () => id();
  const locations: string[] = [`<Location id="${locId()}" name="session" start="a0" end="${sc(endSec)}" flags="IsSessionRange" locked="0" timestamp="${now}" cue="0"/>`];
  if (p.loop) locations.push(`<Location id="${locId()}" name="Loop" start="${sc(p.loop.start)}" end="${sc(p.loop.end)}" flags="IsAutoLoop" locked="0" timestamp="${now}" cue="0"/>`);
  for (const m of p.markers) locations.push(`<Location id="${locId()}" name="${esc(m.name)}" start="${sc(m.time)}" end="${sc(m.time)}" flags="IsMark" locked="0" timestamp="${now}" cue="0"/>`);

  const tempoMap =
    `<TempoMap superclocks-per-second="${SUPERCLOCK}"><Tempos><Tempo npm="${bpm}" enpm="${bpm}" note-type="4" type="Constant" locked-to-meter="0" continuing="0" active="1" sclock="0" quarters="0:0" bbt="1|1|0" omega="0"/></Tempos>` +
    `<Meters><Meter note-value="4" divisions-per-bar="${Math.max(1, Math.round(p.perBar))}" sclock="0" quarters="0:0" bbt="1|1|0"/></Meters><MusicTimes/></TempoMap>`;

  const fill = (text: string, token: string, value: string) => text.replace(token, () => value); // a function, so "$" in a name is not special
  let xml = ARDOUR_SKELETON;
  xml = fill(xml, '{{UUID}}', uuid(name));
  xml = fill(xml, '{{SESSION}}', esc(name));
  xml = fill(xml, '{{IDCOUNTER}}', String(nextId + 10));
  xml = fill(xml, '{{SOURCES}}', `<Sources>${sources.join('')}</Sources>`);
  xml = fill(xml, '{{REGIONS}}', `<Regions>${regions.join('')}</Regions>`);
  xml = fill(xml, '{{LOCATIONS}}', `<Locations>${locations.join('')}</Locations>`);
  xml = fill(xml, '{{PLAYLISTS}}', `<Playlists>${playlists.join('')}</Playlists>`);
  xml = fill(xml, '{{TEMPOMAP}}', tempoMap);
  xml = fill(xml, '{{ROUTES}}', routes.join(''));
  void rate;
  return { name, xml, dirs: ['analysis', 'dead', 'export', 'externals', 'peaks', 'plugins', `interchange/${name}/audiofiles`], audioDir: `interchange/${name}/audiofiles` };
}
