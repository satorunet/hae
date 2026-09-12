"""
Name the neurons of the v783 graph: sensory inputs, descending outputs, motor
neurons, and a few visual projection types, as model indices.

    python build_groups.py ANNOTATIONS.tsv Completeness_783.csv figures.ipynb OUT.json

ANNOTATIONS.tsv is FlyWire's neuron annotation table (Schlegel et al. 2024,
github.com/flyconnectome/flywire_annotations, CC-BY 4.0), whose root ids are
v783. figures.ipynb is from philshiu/Drosophila_brain_model: its hand-curated
sugar / water / bitter / Ir94e GRN lists are used where the annotation lumps
sugar and water together.
"""
import json
import re
import sys

import pandas as pd

ann_path, comp_path, nb_path, out_path = sys.argv[1:5]
comp = pd.read_csv(comp_path, index_col=0)
index = {int(r): i for i, r in enumerate(comp.index)}
a = pd.read_csv(ann_path, sep='\t', low_memory=False)
a = a[a.root_id.isin(index)].copy()
a['i'] = a.root_id.map(index)
a['side'] = a.side.fillna('center').str[0].str.upper().map({'L': 'L', 'R': 'R'}).fillna('C')


def idx(df):
    return sorted(int(x) for x in df.i)


groups = {}

# ---- Shiu's GRN lists (v630 ids; most carry over to v783 unchanged)
nb = json.load(open(nb_path))
src = '\n'.join(''.join(c['source']) for c in nb['cells'] if c['cell_type'] == 'code')
for name in ['neu_sugar', 'neu_water', 'neu_bitter', 'neu_ir94e', 'neu_sugar_left']:
    m = re.search(rf'^{name}\s*=\s*\[(.*?)\]', src, re.M | re.S)
    ids = [int(x) for x in re.findall(r'7205759\d{11}', m.group(1))]
    ok = [index[x] for x in ids if x in index]
    groups[f'shiu:{name[4:]}'] = {'n_listed': len(ids), 'idx': ok}

# ---- sensory, by class / subclass / type and side
s = a[a.super_class.isin(['sensory', 'sensory_ascending'])]
def add(key, df):
    for side in ['L', 'R']:
        d = df[df.side == side]
        if len(d):
            groups[f'{key}:{side}'] = {'idx': idx(d)}

add('gustatory:sugar_water', s[(s.cell_class == 'gustatory') & (s.cell_sub_class == 'sugar/water')])
add('gustatory:bitter', s[(s.cell_class == 'gustatory') & (s.cell_sub_class == 'bitter')])
add('gustatory:low_salt', s[(s.cell_class == 'gustatory') & (s.cell_sub_class == 'low-salt')])
add('mechano:JO_wind_gravity', s[s.cell_sub_class == 'wind_gravity'])
add('mechano:JO_grooming', s[(s.cell_class == 'mechanosensory') & (s.cell_sub_class == 'grooming')])
add('mechano:JO_auditory', s[s.cell_sub_class == 'auditory'])
add('mechano:head_bristle', s[s.cell_sub_class == 'head bristle'])
add('mechano:eye_bristle', s[s.cell_sub_class == 'eye bristle'])
for sub in ['dry', 'moist', 'cooling', 'evaporative_cooling']:
    add(f'hygro:{sub}', s[(s.cell_class == 'hygrosensory') & (s.cell_sub_class == sub)])
for sub in ['cold', 'heating', 'humid']:
    add(f'thermo:{sub}', s[(s.cell_class == 'thermosensory') & (s.cell_sub_class == sub)])
orn = s[s.cell_type.fillna('').str.startswith('ORN_')]
for ct, d in orn.groupby('cell_type'):
    add(f'olfactory:{ct}', d)
add('visual:R1-6', s[s.cell_type == 'R1-6'])
add('visual:R7', s[s.cell_type.fillna('').str.startswith('R7')])
add('visual:R8', s[s.cell_type.fillna('').str.startswith('R8')])
add('visual:ocellar', s[s.cell_sub_class == 'ocellar'])

# ---- looming-sensitive visual projection neurons (inputs to escape)
vp = a[a.super_class == 'visual_projection']
for ct in ['LC4', 'LPLC2', 'LPLC1', 'LC6', 'LC11']:
    add(f'vpn:{ct}', vp[vp.cell_type == ct])

# ---- outputs: every descending neuron type, and motor neurons, by side
dn = a[a.super_class == 'descending']
for ct, d in dn.groupby(dn.cell_type.fillna(dn.hemibrain_type).fillna('unnamed')):
    add(f'dn:{ct}', d)
mn = a[a.super_class == 'motor']
for ct, d in mn.groupby(mn.cell_type.fillna('unnamed')):
    add(f'motor:{ct}', d)

out = {'dataset': 'FlyWire v783', 'n': len(comp), 'groups': groups,
       'motor_subclass': {str(ct): str(d.cell_sub_class.iloc[0])
                          for ct, d in mn.groupby(mn.cell_type.fillna('unnamed'))}}
json.dump(out, open(out_path, 'w'), separators=(',', ':'))
print(f'{len(groups)} groups -> {out_path}')
for k in ['shiu:sugar', 'shiu:water', 'shiu:bitter', 'gustatory:sugar_water:L',
          'mechano:JO_wind_gravity:L', 'visual:R1-6:L', 'vpn:LC4:L', 'dn:DNa02:L',
          'dn:MDN:L', 'dn:DNp09:L', 'dn:DNp01:L', 'motor:CB0701:R']:
    g = groups.get(k)
    print(f'  {k:28s} {len(g["idx"]) if g else "-":>5}' + (f'  (listed {g["n_listed"]})' if g and 'n_listed' in g else ''))
