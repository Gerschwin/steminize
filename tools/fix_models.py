#!/usr/bin/env python3
"""
Make Demucs ONNX exports loadable in the browser.

Some exports contain float64 ("double") maths in their iSTFT section. The
browser build of ONNX Runtime has no float64 kernels, so loading fails with:
  "Could not find an implementation for ConstantOfShape(9) ..."

This script converts every float64 tensor/constant/cast in the model to
float32, then (if onnxruntime is installed) checks that the converted model
gives the same output as the original.

Usage:
  pip install onnx numpy onnxruntime
  python tools/fix_models.py htdemucs_fp16weights.onnx [more.onnx ...] [-o browser-models]

Then in Steminize: Models -> Import model file... and pick the converted files.
"""
import argparse
import os
import sys
import time
from collections import Counter

import numpy as np
import onnx
from onnx import TensorProto, numpy_helper

DOUBLE, FLOAT = TensorProto.DOUBLE, TensorProto.FLOAT


def fix_tensor(t):
    if t.data_type != DOUBLE:
        return t, False
    new = numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32), t.name)
    return new, True


def fix_type(tp):
    """Rewrite a TypeProto in place; returns True if changed."""
    changed = False
    if tp.HasField("tensor_type") and tp.tensor_type.elem_type == DOUBLE:
        tp.tensor_type.elem_type = FLOAT
        changed = True
    if tp.HasField("sequence_type"):
        changed |= fix_type(tp.sequence_type.elem_type)
    return changed


def fix_graph(g, counts):
    for i, init in enumerate(list(g.initializer)):
        new, ch = fix_tensor(init)
        if ch:
            g.initializer[i].CopyFrom(new)
            counts["initializers"] += 1
    for vi in list(g.input) + list(g.output) + list(g.value_info):
        if fix_type(vi.type):
            counts["declared types"] += 1
    for node in g.node:
        for a in node.attribute:
            if a.type == onnx.AttributeProto.TENSOR:
                new, ch = fix_tensor(a.t)
                if ch:
                    a.t.CopyFrom(new)
                    counts[f"{node.op_type} constants"] += 1
            elif a.type == onnx.AttributeProto.INT and a.name in ("to", "dtype") and a.i == DOUBLE:
                a.i = FLOAT
                counts[f"{node.op_type} to float64"] += 1
            elif a.type == onnx.AttributeProto.GRAPH:
                fix_graph(a.g, counts)
            elif a.type == onnx.AttributeProto.GRAPHS:
                for sub in a.graphs:
                    fix_graph(sub, counts)


def parity(original, converted):
    try:
        import onnxruntime as ort
    except ImportError:
        print("  (install onnxruntime to verify the converted model)")
        return True
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    a = ort.InferenceSession(original, opts, providers=["CPUExecutionProvider"])
    b = ort.InferenceSession(converted, opts, providers=["CPUExecutionProvider"])
    inp = a.get_inputs()[0]
    shape = [d if isinstance(d, int) else 1 for d in inp.shape]
    rng = np.random.default_rng(0)
    x = (rng.standard_normal(shape) * 0.5).astype(np.float32)
    t = time.time()
    ya = a.run(None, {inp.name: x})[0]
    yb = b.run(None, {b.get_inputs()[0].name: x})[0]
    err = float(np.abs(ya.astype(np.float64) - yb).max())
    scale = float(np.abs(ya).max()) or 1.0
    ok = ya.shape == yb.shape and err / scale < 1e-3
    print(f"  parity: max difference {err:.2e} (relative {err / scale:.1e}) -> {'OK' if ok else 'MISMATCH'}  [{time.time() - t:.1f}s]")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="+")
    ap.add_argument("-o", "--out", default="browser-models")
    ap.add_argument("--no-check", action="store_true", help="skip the parity check")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    bad = 0
    for path in args.models:
        name = os.path.basename(path)
        print(f"{name}:")
        model = onnx.load(path)
        counts = Counter()
        fix_graph(model.graph, counts)
        out = os.path.join(args.out, name)
        if not counts:
            print("  no float64 found; copying unchanged")
        else:
            print("  converted " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
        onnx.checker.check_model(model)
        onnx.save(model, out)
        print(f"  saved {out} ({os.path.getsize(out) / 2**20:.0f} MB)")
        if not args.no_check and not parity(path, out):
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
