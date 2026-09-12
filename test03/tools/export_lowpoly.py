"""Low-poly copies of the NeuroMechFly meshes, for drawing many flies at once (test04).

Reads ../nmf/body.json + ../nmf/meshes.bin.gz (written by export_nmf.py) and writes
../nmf/meshes_lo.json + ../nmf/meshes_lo.bin.gz: every mesh decimated to about
KEEP of its faces (quadric decimation, fast-simplification), same int16/uint16 layout.

    pip install fast-simplification numpy
    python export_lowpoly.py
"""
import gzip
import json
from pathlib import Path

import fast_simplification
import numpy as np

NMF = Path(__file__).resolve().parent.parent / "nmf"
KEEP = 0.25
MIN_FACES = 40


def main():
    J = json.loads((NMF / "body.json").read_text())
    raw = gzip.decompress((NMF / "meshes.bin.gz").read_bytes())
    out, blob = {}, bytearray()
    n0 = n1 = 0
    for b in J["bodies"]:
        g = b.get("geom")
        if not g:
            continue
        m = J["meshes"][g["mesh"]]
        Q = np.frombuffer(raw, np.int16, m["vn"] * 3, m["voff"]).reshape(-1, 3).astype(np.float64)
        V = np.array(m["lo"]) + (Q + 32768) * np.array(m["sc"])
        F = np.frombuffer(raw, np.uint16, m["fn"] * 3, m["foff"]).reshape(-1, 3).astype(np.int64)
        reduction = 0.0 if m["fn"] <= MIN_FACES else min(0.95, 1 - max(KEEP, MIN_FACES / m["fn"]))
        if reduction > 0:
            V2, F2 = fast_simplification.simplify(V.astype(np.float32), F.astype(np.int32), target_reduction=reduction)
        else:
            V2, F2 = V, F
        V2 = np.asarray(V2, np.float64); F2 = np.asarray(F2, np.uint16)
        lo, hi = V2.min(0), V2.max(0)
        sc = np.maximum(hi - lo, 1e-9) / 65535.0
        Qn = np.round((V2 - lo) / sc - 32768).astype(np.int16)
        voff = len(blob); blob += Qn.tobytes()
        foff = len(blob); blob += F2.tobytes()
        while len(blob) % 4:
            blob += b"\0"
        out[b["name"]] = {"voff": voff, "vn": int(len(V2)), "foff": foff, "fn": int(len(F2)),
                          "lo": [float(x) for x in lo], "sc": [float(x) for x in sc]}
        n0 += m["fn"]; n1 += len(F2)
    (NMF / "meshes_lo.json").write_text(json.dumps({"keep": KEEP, "meshes": out}, separators=(",", ":")))
    (NMF / "meshes_lo.bin.gz").write_bytes(gzip.compress(bytes(blob), 9))
    print(f"{len(out)} meshes, faces {n0} -> {n1}, {len(blob) / 1e6:.2f} MB raw")


if __name__ == "__main__":
    main()
