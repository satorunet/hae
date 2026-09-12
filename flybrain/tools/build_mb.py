"""
Name the mushroom-body neurons of the v783 graph as model indices: Kenyon cells,
MBONs, DANs/MBINs and the olfactory projection neurons that feed the KCs.

    python build_mb.py ANNOTATIONS.tsv Completeness_783.csv OUT.json

ANNOTATIONS.tsv is FlyWire's neuron annotation table (Schlegel et al. 2024,
github.com/flyconnectome/flywire_annotations, CC-BY 4.0), root ids v783.
Only the standard library is used, so it runs without pandas.
"""
import csv
import json
import sys
from collections import defaultdict

ann_path, comp_path, out_path = sys.argv[1:4]

with open(comp_path, newline='') as f:
    r = csv.reader(f)
    next(r)
    index = {row[0]: i for i, row in enumerate(r)}

groups = defaultdict(lambda: {'idx': [], 'L': [], 'R': [], 'C': []})
types = {}          # model index -> cell type, for the KC->MBON wiring step
csv.field_size_limit(1 << 24)

with open(ann_path, newline='') as f:
    for row in csv.DictReader(f, delimiter='\t'):
        i = index.get(row['root_id'])
        if i is None:
            continue
        cls = row['cell_class']
        typ = row['cell_type'] or row['hemibrain_type'] or 'unnamed'
        side = {'l': 'L', 'r': 'R'}.get((row['side'] or '')[:1].lower(), 'C')
        if cls == 'Kenyon_Cell':
            key = f'kc:{typ}'
        elif cls == 'MBON':
            key = f'mbon:{typ}'
        elif cls in ('DAN', 'MBIN'):
            key = f'{cls.lower()}:{typ}'
        elif cls == 'ALPN':
            key = f'alpn:{typ}'
        else:
            continue
        groups[key]['idx'].append(i)
        groups[key][side].append(i)
        types[i] = key

for g in groups.values():
    g['idx'].sort()
    for s in 'LRC':
        g[s].sort()
        if not g[s]:
            del g[s]

out = {'dataset': 'FlyWire v783', 'n': len(index),
       'groups': dict(sorted(groups.items())),
       'type_of': {str(i): t for i, t in sorted(types.items())}}
json.dump(out, open(out_path, 'w'), separators=(',', ':'))

tot = defaultdict(int)
for k, g in groups.items():
    tot[k.split(':')[0]] += len(g['idx'])
print(f'{len(groups)} groups -> {out_path}')
for k, v in sorted(tot.items()):
    print(f'  {k:6s} {v:6d} neurons')
