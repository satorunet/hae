#!/usr/bin/env python3
"""The share card for ハエそろばん計算機: an SVG drawn to the page's own palette, 1200x630.

  python3 tools/og-card.py && rsvg-convert -w 1200 -h 630 og-card.svg -o ../og-soroban.png

Nothing here is a screenshot - the board is laid out the way the real one is (a five-bead above the
beam, four one-beads below), so the number on it is a number you could actually read off it.
"""
import os

W, H = 1200, 630
BG, CARD, LINE, INK, DIM = '#0b0e12', '#141a21', '#232c36', '#e8eef4', '#8c99a8'
OK, WARM, GOOD = '#59b7ff', '#ffb454', '#54d98c'
FONT = "Droid Sans Japanese,Droid Sans Fallback,Noto Sans JP,sans-serif"

NUMBER = '12345678'          # what the beads are showing
RODS = len(NUMBER)

# ---- the board
BX, BW = 74, W - 148                 # frame left / width
BY, BH_ = 264, 320                   # frame top / height
RAIL = 15                            # frame thickness
beam_y = BY + RAIL + 92              # the beam, one bead's worth down
beam_h = 13
top_y, bot_y = BY + RAIL, BY + BH_ - RAIL
pitch = (BW - RAIL * 2) / RODS
rod_x = [BX + RAIL + pitch * (i + 0.5) for i in range(RODS)]
bh, bw = 34, pitch * 0.42            # bead height / half width
gap = 3

def bead(cx, cy, w, h, fill, stroke, op=1.0):
    d = (f"M{cx-w:.1f},{cy:.1f} Q{cx-w*0.62:.1f},{cy-h*0.52:.1f} {cx:.1f},{cy-h/2:.1f} "
         f"Q{cx+w*0.62:.1f},{cy-h*0.52:.1f} {cx+w:.1f},{cy:.1f} "
         f"Q{cx+w*0.62:.1f},{cy+h*0.52:.1f} {cx:.1f},{cy+h/2:.1f} "
         f"Q{cx-w*0.62:.1f},{cy+h*0.52:.1f} {cx-w:.1f},{cy:.1f} Z")
    return (f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" opacity="{op}"/>'
            f'<path d="M{cx-w*0.72:.1f},{cy-3:.1f} Q{cx:.1f},{cy-h*0.44:.1f} {cx+w*0.72:.1f},{cy-3:.1f}"'
            f' fill="none" stroke="#ffffff" stroke-width="2" opacity="{0.22*op:.2f}"/>')

def leg(hip, knee, foot, wdt=5.0):
    """A leg tapers: the femur is thick where it leaves the body, the tarsus is a hair on the bead."""
    out = []
    for w, a, b in ((wdt, hip, knee), (wdt * 0.62, knee, foot)):
        d = f'M{a[0]:.1f},{a[1]:.1f} L{b[0]:.1f},{b[1]:.1f}'
        out.append(f'<path d="{d}" fill="none" stroke="#0d1116" stroke-width="{w+3.5:.1f}" stroke-linecap="round"/>')
        out.append(f'<path d="{d}" fill="none" stroke="#333b45" stroke-width="{w:.1f}" stroke-linecap="round"/>')
    out.append(f'<circle cx="{foot[0]:.1f}" cy="{foot[1]:.1f}" r="{wdt*0.7:.1f}" fill="#232a32"/>')
    return ''.join(out)

s = []
s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">')
s.append(f'''<defs>
<radialGradient id="glow" cx="50%" cy="30%" r="72%">
  <stop offset="0" stop-color="#1b2husk"/></radialGradient>
<linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#3a2e22"/><stop offset="1" stop-color="#241c14"/></linearGradient>
<linearGradient id="inner" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#0d1116"/><stop offset="1" stop-color="#121820"/></linearGradient>
<linearGradient id="beadg" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ffc978"/><stop offset="1" stop-color="#e08b2a"/></linearGradient>
<linearGradient id="beadoff" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#6d5a45"/><stop offset="1" stop-color="#4a3c2e"/></linearGradient>
<linearGradient id="wing" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#cfe6ff" stop-opacity=".40"/>
  <stop offset="1" stop-color="#9fd0ff" stop-opacity=".12"/></linearGradient>
<linearGradient id="thorax" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#3b434d"/><stop offset="1" stop-color="#171c22"/></linearGradient>
</defs>''')
s.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
s.append(f'<ellipse cx="600" cy="250" rx="640" ry="330" fill="#16202b" opacity=".55"/>')
s.append(f'<ellipse cx="600" cy="330" rx="420" ry="170" fill="#1d2b3a" opacity=".45"/>')

# ---- text
s.append(f'<text x="70" y="104" font-size="58" font-weight="700" fill="{INK}">ハエにそろばん覚えさせてみた</text>')
s.append(f'<text x="74" y="156" font-size="24" fill="{OK}">FlyWire の全脳コネクトーム 138,639 ニューロンに、そろばんの回路を移植</text>')
s.append(f'<text x="74" y="196" font-size="24" fill="{DIM}">8 桁の足し算・引き算・かけ算を、蠅が六本の脚で珠を弾いて解きます</text>')

# ---- the board
s.append(f'<rect x="{BX}" y="{BY}" width="{BW}" height="{BH_}" rx="16" fill="url(#frame)" stroke="#4a3a28" stroke-width="2"/>')
s.append(f'<rect x="{BX+RAIL}" y="{BY+RAIL}" width="{BW-RAIL*2}" height="{BH_-RAIL*2}" rx="5" fill="url(#inner)"/>')
for x in rod_x:                                   # the rods
    s.append(f'<rect x="{x-2.5:.1f}" y="{top_y}" width="5" height="{bot_y-top_y}" rx="2.5" fill="#6b727b"/>')
    s.append(f'<rect x="{x-2.5:.1f}" y="{top_y}" width="2" height="{bot_y-top_y}" fill="#9aa3ad" opacity=".5"/>')
s.append(f'<rect x="{BX+RAIL}" y="{beam_y:.0f}" width="{BW-RAIL*2}" height="{beam_h}" fill="#2e2418" stroke="#4a3a28" stroke-width="1.5"/>')
for i in range(RODS):                             # the dots on the beam, every third rod
    if (RODS - 1 - i) % 3 == 0:
        s.append(f'<circle cx="{rod_x[i]:.1f}" cy="{beam_y+beam_h/2:.1f}" r="3" fill="{WARM}" opacity=".75"/>')

for i, ch in enumerate(NUMBER):
    d = int(ch); x = rod_x[i]
    h_on, e_on = d >= 5, d % 5
    cy = beam_y - bh/2 - gap if h_on else top_y + bh/2 + gap
    s.append(bead(x, cy, bw, bh, 'url(#beadg)' if h_on else 'url(#beadoff)', '#2a2118'))
    for k in range(4):
        if k < e_on:
            cy = beam_y + beam_h + gap + bh/2 + k * (bh + gap)
        else:
            cy = bot_y - gap - bh/2 - (3 - k) * (bh + gap)
        s.append(bead(x, cy, bw, bh, 'url(#beadg)' if k < e_on else 'url(#beadoff)', '#2a2118'))

# ---- the fly, from above, standing on the board with all six legs on the beads
S = 0.62                                          # it is a fly on a soroban, not a fly over a soroban
fx, fy = rod_x[4] + pitch / 2, beam_y - 8         # thorax centre, on the board
def loc(x, y):                                    # a point on the board, in the fly's own frame
    return ((x - fx) / S, (y - fy) / S)
feet = [(rod_x[2], top_y + 40), (rod_x[6], top_y + 40),            # front pair, up on the five-beads
        (rod_x[1], beam_y + 66), (rod_x[7], beam_y + 66),          # middle pair, out on the one-beads
        (rod_x[3], bot_y - 46), (rod_x[5], bot_y - 46)]            # hind pair, down at the bottom
hips  = [(-26, -34), (26, -34), (-30, -6), (30, -6), (-26, 22), (26, 22)]
knees = [(-116, -104), (116, -104), (-150, 24), (150, 24), (-104, 128), (104, 128)]
g = ['<ellipse cx="{:.1f}" cy="{:.1f}" rx="86" ry="58" fill="#000" opacity=".38"/>'.format(fx + 10, fy + 34),
     '<g transform="translate({:.1f},{:.1f}) scale({})">'.format(fx, fy, S)]
for hp, kn, ft in zip(hips, knees, feet):
    g.append(leg(hp, kn, loc(*ft), 8.0))
g.append('<ellipse cx="-74" cy="-18" rx="104" ry="46" fill="url(#wing)" stroke="#bcdcff" stroke-opacity=".30" stroke-width="2" transform="rotate(-26 -74 -18)"/>')
g.append('<ellipse cx="74" cy="-18" rx="104" ry="46" fill="url(#wing)" stroke="#bcdcff" stroke-opacity=".30" stroke-width="2" transform="rotate(26 74 -18)"/>')
g.append('<ellipse cx="0" cy="96" rx="52" ry="84" fill="#20262d" stroke="#0e1216" stroke-width="3"/>')
for k in range(3):
    g.append(f'<path d="M{-49+k*3},{62+k*34} Q0,{78+k*34} {49-k*3},{62+k*34}" fill="none" stroke="#0e1216" stroke-width="4" opacity=".75"/>')
g.append('<ellipse cx="0" cy="0" rx="60" ry="68" fill="url(#thorax)" stroke="#0e1216" stroke-width="3"/>')
g.append('<ellipse cx="0" cy="-74" rx="52" ry="44" fill="#2a3138" stroke="#0e1216" stroke-width="3"/>')
g.append('<ellipse cx="-35" cy="-82" rx="26" ry="33" fill="#c2452f"/><ellipse cx="35" cy="-82" rx="26" ry="33" fill="#c2452f"/>')
g.append('<ellipse cx="-40" cy="-92" rx="9" ry="12" fill="#ff9d84" opacity=".5"/><ellipse cx="30" cy="-92" rx="9" ry="12" fill="#ff9d84" opacity=".5"/>')
g.append('</g>')
s.append(''.join(g))

# ---- the sum, under the board
s.append(f'<text x="70" y="{H-24}" font-size="25" fill="{DIM}">12345677 ＋ 1 ＝ <tspan fill="{GOOD}">12345678</tspan></text>')
s.append(f'<text x="{W-70}" y="{H-24}" font-size="23" fill="{DIM}" text-anchor="end">hae.satoru.net/soroban</text>')
s.append('</svg>')

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'og-card.svg')
open(out, 'w').write('\n'.join(s))
print('wrote', os.path.normpath(out))
