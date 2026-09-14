// The foods a tap can drop, shared by the page (how they look) and the body worker (how they fall,
// tumble and pile up, what they taste of, how fast they are eaten).
//
// Taste, in the brain's taste neurons (Hz, on the lips; a palm in it gives two thirds): honey is
// sugar; meat is water and low salt (its juices, and the amino acids that flies taste through the
// same Ir76b neurons); dung is water, low salt and a little bitter. In the brain model these drive
// the feeding motor neuron MN9 at about 60, 45 and 25 Hz.
//
// Meat and dung are solid lumps: a few ellipsoids each, laid out with the floor at y = 0 and about
// 1 across (three.js axes, y up) and scaled to 2r; the worker gives them the same shapes in its
// physics. Honey is a puddle, on the floor or on whatever lump it was poured onto.
export const FOODS = {
  honey: { label: '蜜', r: 0.09, eat: 2.5, taste: { sugar: 150 }, ring: 0xf0b040 },
  meat: {
    label: '肉', r: 0.07, eat: 3.5, taste: { water: 100, salt: 100 }, ring: 0xb04040, density: 1050,
    parts: [
      { c: [0, 0.33, 0], s: [0.5, 0.33, 0.4], mat: 'meat', seed: 1.3, bump: 0.1 },
      { c: [-0.1, 0.3, 0.33], s: [0.42, 0.26, 0.12], mat: 'fat', seed: 4.1, bump: 0.12 },       // a band of fat along one side
      { c: [0.26, 0.3, -0.12], s: [0.26, 0.26, 0.24], mat: 'meat', seed: 2.2, bump: 0.15 },
    ],
  },
  dung: {
    label: '糞', r: 0.07, eat: 3.5, taste: { water: 120, salt: 80, bitter: 40 }, ring: 0x6a4a2a, density: 1100,
    parts: [                                                                                     // coiled up to a tip
      { c: [0, 0.22, 0], s: [0.5, 0.24, 0.5], mat: 'dung', seed: 0.7, bump: 0.08 },
      { c: [0.03, 0.48, -0.02], s: [0.36, 0.2, 0.36], mat: 'dung', seed: 2.9, bump: 0.1 },
      { c: [-0.02, 0.7, 0.03], s: [0.22, 0.16, 0.22], mat: 'dung', seed: 5.3, bump: 0.12 },
      { c: [0.02, 0.86, 0], s: [0.09, 0.12, 0.09], mat: 'dung', seed: 3.7, bump: 0.1 },
    ],
  },
};
export const FALL_FROM = 2.6;          // metres above the floor
