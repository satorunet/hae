"""
Pack a FlyWire connectivity table into the flybrain graph format (.fbg.gz).

    python export_graph.py COMPLETENESS.csv CONNECTIVITY.parquet OUT.fbg.gz

Inputs are the two files shipped with philshiu/Drosophila_brain_model
(v630: 2023_03_23_completeness_630_final.csv / ..._connectivity_630_final.parquet,
 v783: Completeness_783.csv / Connectivity_783.parquet).

Layout (little-endian), then gzip:
    'FLYB'  u32 version=1  u32 n  u32 nnz
    u64[n]      FlyWire root ids, in model index order
    u32[n]      out-degree of each presynaptic neuron (CSR row lengths)
    u8[nnz] x3  postsynaptic index, delta-coded within each row, as three
                byte planes (low, mid, high) - planes compress far better
                than interleaved integers
    u8[nnz] x2  signed synapse count (int16), as two byte planes (low, high)
The sign of the count is the presynaptic transmitter (ACh +, GABA/Glu -),
exactly the 'Excitatory x Connectivity' column the Brian2 model uses.
"""
import gzip
import struct
import sys

import numpy as np
import pandas as pd

comp_path, con_path, out_path = sys.argv[1:4]

ids = pd.read_csv(comp_path, index_col=0).index.to_numpy().astype(np.uint64)
n = len(ids)
con = pd.read_parquet(con_path, columns=['Presynaptic_Index', 'Postsynaptic_Index',
                                         'Excitatory x Connectivity'])
con = con.sort_values(['Presynaptic_Index', 'Postsynaptic_Index'], kind='stable')
pre = con['Presynaptic_Index'].to_numpy().astype(np.int64)
post = con['Postsynaptic_Index'].to_numpy().astype(np.int64)
w = con['Excitatory x Connectivity'].to_numpy()
nnz = len(con)
assert w.min() >= -32768 and w.max() <= 32767
assert post.max() < n and pre.max() < n

deg = np.bincount(pre, minlength=n).astype(np.uint32)
starts = np.concatenate(([0], np.cumsum(deg)[:-1])).astype(np.int64)

delta = np.empty(nnz, dtype=np.int64)
delta[0] = post[0]
delta[1:] = post[1:] - post[:-1]
row_first = starts[deg > 0]
delta[row_first] = post[row_first]
assert delta.min() >= 0 and delta.max() < (1 << 24)
d = delta.astype(np.uint32)
w16 = w.astype(np.int16).view(np.uint16)

with gzip.open(out_path, 'wb', compresslevel=9) as f:
    f.write(b'FLYB' + struct.pack('<III', 1, n, nnz))
    f.write(ids.astype('<u8').tobytes())
    f.write(deg.astype('<u4').tobytes())
    for k in range(3):
        f.write(((d >> (8 * k)) & 0xFF).astype(np.uint8).tobytes())
    f.write((w16 & 0xFF).astype(np.uint8).tobytes())
    f.write((w16 >> 8).astype(np.uint8).tobytes())

print(f'{out_path}: {n:,} neurons, {nnz:,} connections, '
      f'{int(np.abs(w).sum()):,} synapses, max out-degree {deg.max():,}')
