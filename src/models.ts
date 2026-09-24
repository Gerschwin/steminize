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
  },
  htdemucs_ft: {
    id: 'htdemucs_ft',
    label: 'HT Demucs Fine-tuned',
    blurb: 'Best quality. Four specialist models, so about 4x slower and a bigger download.',
    stems: STEMS_4,
    cost: 4,
    files: { compact: ftFiles('_fp16weights', 166), full: ftFiles('', 316) },
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
export const stemColour = (name: string) => STEM_COLOURS[name.replace(/^no_/, '')] ?? '#94a3b8';

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
