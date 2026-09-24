// Rewrites float64 ("double") tensors, casts and declared types in an ONNX
// model to float32, working directly on the protobuf bytes.
//
// Why: some Demucs ONNX exports use float64 inside their iSTFT, but the
// browser build of ONNX Runtime has no float64 kernels, so session creation
// fails ("Could not find an implementation for ConstantOfShape(9)").
// The Python equivalent is tools/fix_models.py.
//
// Only the messages that can contain types are parsed; everything else
// (including the large weight blobs) is copied through as byte ranges.

const DOUBLE = 11;
const FLOAT = 1;

type Chunks = Uint8Array[];
/** Returns replacement chunks for [start, end), or null if nothing changed. */
type Handler = (b: Uint8Array, start: number, end: number, stats: Stats) => Chunks | null;
export interface Stats {
  tensors: number;
  casts: number;
  types: number;
}

function readVarint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const byte = b[p++];
    v += (byte & 0x7f) * mul;
    if (byte < 0x80) return [v, p];
    mul *= 128;
  }
}

function varint(v: number): Uint8Array {
  const out: number[] = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}

interface Field {
  num: number;
  wire: number;
  start: number; // tag start
  dataStart: number; // payload start (after length for wire 2)
  end: number;
  value: number; // varint value (wire 0) or payload length (wire 2)
}

function* fields(b: Uint8Array, start: number, end: number): Generator<Field> {
  let p = start;
  while (p < end) {
    const s = p;
    let tag: number;
    [tag, p] = readVarint(b, p);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    let value = 0;
    let dataStart = p;
    if (wire === 0) [value, p] = readVarint(b, p);
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) {
      [value, p] = readVarint(b, p);
      dataStart = p;
      p += value;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    yield { num, wire, start: s, dataStart, end: p, value };
  }
}

const len = (c: Chunks) => c.reduce((a, x) => a + x.length, 0);

/** Generic message rewrite: sub-handlers for given length-delimited fields. */
function message(subs: Record<number, () => Handler>): Handler {
  return (b, start, end, stats) => {
    const out: Chunks = [];
    let changed = false;
    let copyFrom = start;
    for (const f of fields(b, start, end)) {
      const h = f.wire === 2 ? subs[f.num] : undefined;
      if (!h) continue;
      const r = h()(b, f.dataStart, f.end, stats);
      if (!r) continue;
      changed = true;
      out.push(b.subarray(copyFrom, f.start), varint(f.num * 8 + 2), varint(len(r)), ...r);
      copyFrom = f.end;
    }
    if (!changed) return null;
    out.push(b.subarray(copyFrom, end));
    return out;
  };
}

const tensor: Handler = (b, start, end, stats) => {
  let isDouble = false;
  for (const f of fields(b, start, end)) if (f.num === 2 && f.wire === 0 && f.value === DOUBLE) isDouble = true;
  if (!isDouble) return null;
  stats.tensors++;
  const out: Chunks = [];
  const doubles: number[] = [];
  let raw: Uint8Array | null = null;
  for (const f of fields(b, start, end)) {
    if (f.num === 2) continue; // data_type
    if (f.num === 9) raw = b.slice(f.dataStart, f.end); // raw_data
    else if (f.num === 10 && f.wire === 2) {
      const v = new DataView(b.buffer, b.byteOffset + f.dataStart, f.value);
      for (let i = 0; i < f.value; i += 8) doubles.push(v.getFloat64(i, true));
    } else if (f.num === 10 && f.wire === 1) {
      doubles.push(new DataView(b.buffer, b.byteOffset + f.dataStart, 8).getFloat64(0, true));
    } else out.push(b.subarray(f.start, f.end));
  }
  let values: Float64Array;
  if (raw) {
    const copy = new Uint8Array(raw); // ensure 8-byte alignment
    values = new Float64Array(copy.buffer, 0, copy.length / 8);
  } else values = Float64Array.from(doubles);
  const f32 = new Uint8Array(Float32Array.from(values).buffer);
  out.push(varint(2 * 8 + 0), varint(FLOAT), varint(9 * 8 + 2), varint(f32.length), f32);
  return out;
};

// TypeProto: tensor_type(1) / sequence_type(4) / map_type(5) / optional_type(9)
const typeProto: Handler = (b, s, e, st) => message({ 1: () => tensorType, 4: () => elemType, 5: () => mapType, 9: () => elemType })(b, s, e, st);
const elemType: Handler = (b, s, e, st) => message({ 1: () => typeProto })(b, s, e, st);
const mapType: Handler = (b, s, e, st) => message({ 2: () => typeProto })(b, s, e, st);
const tensorType: Handler = (b, start, end, stats) => {
  for (const f of fields(b, start, end)) {
    if (f.num === 1 && f.wire === 0 && f.value === DOUBLE) {
      stats.types++;
      return [b.subarray(start, f.start), varint(8), varint(FLOAT), b.subarray(f.end, end)];
    }
  }
  return null;
};
const valueInfo = message({ 2: () => typeProto });

const attribute: Handler = (b, start, end, stats) => {
  let name = '';
  for (const f of fields(b, start, end)) if (f.num === 1 && f.wire === 2) name = new TextDecoder().decode(b.subarray(f.dataStart, f.end));
  const out: Chunks = [];
  let changed = false;
  let copyFrom = start;
  const subs: Record<number, Handler> = { 5: tensor, 6: graph, 10: tensor, 11: graph };
  for (const f of fields(b, start, end)) {
    let r: Chunks | null = null;
    if ((name === 'to' || name === 'dtype') && f.num === 3 && f.wire === 0 && f.value === DOUBLE) {
      stats.casts++;
      r = [varint(3 * 8), varint(FLOAT)];
      out.push(b.subarray(copyFrom, f.start), ...r);
    } else if (f.wire === 2 && subs[f.num]) {
      const sub = subs[f.num](b, f.dataStart, f.end, stats);
      if (sub) {
        r = sub;
        out.push(b.subarray(copyFrom, f.start), varint(f.num * 8 + 2), varint(len(sub)), ...sub);
      }
    }
    if (r) {
      changed = true;
      copyFrom = f.end;
    }
  }
  if (!changed) return null;
  out.push(b.subarray(copyFrom, end));
  return out;
};

const node = message({ 5: () => attribute });
// GraphProto: node(1), initializer(5), input(11), output(12), value_info(13)
function graph(b: Uint8Array, s: number, e: number, st: Stats): Chunks | null {
  return message({ 1: () => node, 5: () => tensor, 11: () => valueInfo, 12: () => valueInfo, 13: () => valueInfo })(b, s, e, st);
}
const func = message({ 7: () => node }); // FunctionProto.node
const model = message({ 7: () => graph, 25: () => func }); // ModelProto.graph, .functions

/** Returns the model with float64 converted to float32 (or the input unchanged). */
export function fixFloat64(bytes: Uint8Array): { bytes: Uint8Array; stats: Stats } {
  const stats: Stats = { tensors: 0, casts: 0, types: 0 };
  const r = model(bytes, 0, bytes.length, stats);
  if (!r) return { bytes, stats };
  const out = new Uint8Array(len(r));
  let o = 0;
  for (const c of r) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out, stats };
}
