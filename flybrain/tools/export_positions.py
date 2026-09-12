"""
Neuron positions and classes for drawing the brain, in model index order.

    python export_positions.py ANNOTATIONS.tsv Completeness_783.csv OUT.bin.gz

Layout (little-endian), gzip:
    'FLYP'  u32 n
    u16[n]  x, u16[n] y   frontal view, scaled to 0..65535, the fly's left on
                          the left (as seen from behind), dorsal up
    u8[n]   class: 0 sensory, 1 optic, 2 central, 3 visual projection,
                   4 visual centrifugal, 5 ascending, 6 descending, 7 motor,
                   8 endocrine, 255 unannotated
Positions are FlyWire's representative point per neuron (pos_x/y/z, CC-BY 4.0).
"""
import gzip
import struct
import sys

import numpy as np
import pandas as pd

ann_path, comp_path, out_path = sys.argv[1:4]
comp = pd.read_csv(comp_path, index_col=0)
n = len(comp)
a = pd.read_csv(ann_path, sep='\t', low_memory=False,
                usecols=['root_id', 'pos_x', 'pos_y', 'super_class', 'side'])
a = a.drop_duplicates('root_id').set_index('root_id').reindex(comp.index)

CLASS = {'sensory': 0, 'sensory_ascending': 0, 'optic': 1, 'central': 2,
         'visual_projection': 3, 'visual_centrifugal': 4, 'ascending': 5,
         'descending': 6, 'motor': 7, 'endocrine': 8}
cls = a.super_class.map(CLASS).fillna(255).astype(np.uint8).to_numpy().copy()
x = a.pos_x.to_numpy(dtype=float)
y = a.pos_y.to_numpy(dtype=float)
ok = ~(np.isnan(x) | np.isnan(y))

# put the fly's left on the left of the picture (viewed from behind)
left_x = np.nanmean(x[(a.side == 'left').to_numpy() & ok])
right_x = np.nanmean(x[(a.side == 'right').to_numpy() & ok])
if left_x > right_x:
    x = -x

def scale(v):
    lo, hi = np.nanmin(v[ok]), np.nanmax(v[ok])
    s = np.zeros(n, dtype=np.uint16)
    s[ok] = np.round((v[ok] - lo) / (hi - lo) * 65535).astype(np.uint16)
    return s, hi - lo

sx, wx = scale(x)
sy, wy = scale(y)
cls[~ok] = 255
with gzip.open(out_path, 'wb', compresslevel=9) as f:
    f.write(b'FLYP' + struct.pack('<I', n))
    f.write(sx.astype('<u2').tobytes())
    f.write(sy.astype('<u2').tobytes())
    f.write(cls.tobytes())
print(f'{out_path}: {n:,} neurons, {int(ok.sum()):,} placed, aspect {wx / wy:.3f} (w/h)')
