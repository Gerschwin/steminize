// Model catalogue. The ONNX exports are community conversions of Meta's
// MIT-licensed Demucs v4 weights (see README for credits).

export type ModelId = 'htdemucs' | 'htdemucs_ft' | 'htdemucs_6s';
export type Precision = 'compact' | 'full';

export const STEMS_4 = ['drums', 'bass', 'other', 'vocals'] as const;
export const STEMS_6 = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const;

export interface ModelFile {
  key: string; // stable id used for the cache
  url: string;
  bytes: number; // approximate, for display
  /** Rows of the model output this file is trusted for (FT specialists only own one stem). */
  rows: number[];
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  blurb: string;
  stems: readonly string[];
  /** Relative run time vs htdemucs, for estimates. */
  cost: number;
  files: Record<Precision, ModelFile[]>;
  /** The Hugging Face repo these files come from, so people can browse it for other versions/formats. */
  hfRepo: string;
}

const HF = 'https://huggingface.co';
const MB = 1024 * 1024;

function file(repo: string, name: string, mb: number, rows: number[]): ModelFile {
  return { key: name, url: `${HF}/${repo}/resolve/main/${name}`, bytes: mb * MB, rows };
}

const ftFiles = (suffix: string, mb: number) =>
  STEMS_4.map((s, i) => file('StemSplitio/htdemucs-ft-onnx', `htdemucs_ft_${s}${suffix}.onnx`, mb, [i]));

export const MODELS: Record<ModelId, ModelInfo> = {
  htdemucs: {
    id: 'htdemucs',
    label: 'HT Demucs',
    blurb: 'Default. Good quality, fastest. Best choice on phones.',
    stems: STEMS_4,
    cost: 1,
    files: {
      compact: [file('StemSplitio/htdemucs-onnx', 'htdemucs_fp16weights.onnx', 166, [0, 1, 2, 3])],
      full: [file('StemSplitio/htdemucs-onnx', 'htdemucs.onnx', 316, [0, 1, 2, 3])],
    },
    hfRepo: 'StemSplitio/htdemucs-onnx',
  },
  htdemucs_ft: {
    id: 'htdemucs_ft',
    label: 'HT Demucs Fine-tuned',
    blurb: 'Best quality. Four specialist models, so about 4x slower and a bigger download.',
    stems: STEMS_4,
    cost: 4,
    files: { compact: ftFiles('_fp16weights', 166), full: ftFiles('', 316) },
    hfRepo: 'StemSplitio/htdemucs-ft-onnx',
  },
  htdemucs_6s: {
    id: 'htdemucs_6s',
    label: 'HT Demucs 6-stem',
    blurb: 'Adds guitar and piano. Guitar is decent; piano bleeds a lot.',
    stems: STEMS_6,
    cost: 1,
    files: {
      compact: [file('StemSplitio/htdemucs-6s-onnx', 'htdemucs_6s_fp16weights.onnx', 136, [0, 1, 2, 3, 4, 5])],
      full: [file('StemSplitio/htdemucs-6s-onnx', 'htdemucs_6s.onnx', 258, [0, 1, 2, 3, 4, 5])],
    },
    hfRepo: 'StemSplitio/htdemucs-6s-onnx',
  },
};

export const ALL_FILES: ModelFile[] = Object.values(MODELS).flatMap((m) => [...m.files.compact, ...m.files.full]);

export const STEM_COLOURS: Record<string, string> = {
  vocals: '#f472b6',
  drums: '#fb923c',
  bass: '#a78bfa',
  other: '#34d399',
  guitar: '#facc15',
  piano: '#38bdf8',
};
const EXTRA_COLOURS = ['#60a5fa', '#f87171', '#c084fc', '#2dd4bf', '#fbbf24', '#a3e635', '#f472b6', '#22d3ee'];
/** Colour for a stem or track; guesses from common track names (e.g. "Kick", "Lead vox", "Bass DI"). */
export const stemColour = (name: string, index = 0) => {
  const n = name.replace(/^no_/, '').toLowerCase();
  if (STEM_COLOURS[n]) return STEM_COLOURS[n];
  if (/vox|vocal|voice|sing|bv/.test(n)) return STEM_COLOURS.vocals;
  if (/drum|kick|snare|hat|tom|overhead|perc|cymbal/.test(n)) return STEM_COLOURS.drums;
  if (/bass/.test(n)) return STEM_COLOURS.bass;
  if (/gtr|guitar/.test(n)) return STEM_COLOURS.guitar;
  if (/piano|keys|synth|organ|rhodes/.test(n)) return STEM_COLOURS.piano;
  return EXTRA_COLOURS[index % EXTRA_COLOURS.length];
};

/** Which files a job needs. Specialist bags only load the members that own the wanted stems. */
export function neededFiles(model: ModelId, precision: Precision, twoStems: string, skip: string[]): ModelFile[] {
  const info = MODELS[model];
  const files = info.files[precision];
  if (files.length === 1) return files;
  const wanted = twoStems
    ? [info.stems.indexOf(twoStems)]
    : info.stems.map((_, i) => i).filter((i) => !skip.includes(info.stems[i]));
  return files.filter((f) => f.rows.some((r) => wanted.includes(r)));
}

/** A file size the way the app shows it. */
const sizeText = (b: number) => (b >= 1e9 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** The words about the model download: the model that will be used, its size, and whether it is already here. */
export function modelNote(label: string, bytes: number, have: boolean | 'partly'): string {
  if (have === true) return `The separation model (${label}) is already on this computer, so your first split can start straight away. It works offline.`;
  if (have === 'partly') return `Part of the separation model (${label}, ${sizeText(bytes)}) is already on this computer. Your first split finishes the download once, then it works offline.`;
  return `Splitting a song needs a one-off download of the separation model (${label}, ${sizeText(bytes)}). After that it works offline. You can choose a different model under Models.`;
}
