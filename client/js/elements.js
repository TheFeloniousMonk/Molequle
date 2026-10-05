// elements.js — Material definitions for entity rendering (visual only).
//
// Each element maps an entity's hue (its "biography" color, 0-360) onto a
// color ramp and defines how the material reacts to light: glow, highlight,
// shadow, opacity, and how bonds, trails, and weather are tinted.

export const ELEMENT_NAMES = ['bioluminescent', 'ice', 'fire', 'metallic'];

export const ELEMENTS = {
  bioluminescent: {
    label: 'Bioluminescent',
    // Full hue circle: the original palette (hue is continuous, no mirroring)
    hueRamp: { saturation: 80, lightness: 56 },
    bodyBlend: 'lighter',      // additive: overlapping entities brighten
    glowBlend: 'lighter',
    glowStrength: 1.15,
    bodyAlpha: 1.0,
    bodyLift: 0.22,
    highlight: { size: 0.5, intensity: 0.35, sharpness: 0.45 },
    shadow: 0.5,
    stormGray: [110, 112, 122],
    bond: [180, 200, 220],
    trailAlpha: 0.15,
    bloomTint: [220, 170, 70],
    rimTint: [130, 160, 255],
    stormFx: 'cloud',
  },
  ice: {
    label: 'Ice',
    ramp: [
      [0.00, [18, 52, 120]],    // deep glacial blue
      [0.28, [24, 118, 210]],   // iceberg blue
      [0.52, [60, 190, 250]],   // bright glacier
      [0.76, [150, 232, 255]],  // pale aqua
      [1.00, [240, 252, 255]],  // white
    ],
    bodyBlend: 'source-over',
    glowBlend: 'lighter',
    glowStrength: 1.0,
    bodyAlpha: 0.88,           // slightly translucent
    bodyLift: 0.3,             // lit-side brightening
    highlight: { size: 0.6, intensity: 0.75, sharpness: 0.25 },  // soft, glassy
    shadow: 0.35,
    stormGray: [70, 84, 104],
    bond: [150, 215, 250],
    trailAlpha: 0.16,
    bloomTint: [150, 220, 255],
    rimTint: [190, 235, 255],
    stormFx: 'frost',
  },

  fire: {
    label: 'Fire',
    ramp: [
      [0.00, [150, 22, 12]],    // ember red
      [0.28, [225, 48, 18]],    // flame red
      [0.52, [255, 110, 25]],   // orange
      [0.76, [255, 185, 60]],   // amber
      [1.00, [255, 248, 215]],  // white-hot
    ],
    bodyBlend: 'lighter',
    glowBlend: 'lighter',
    glowStrength: 1.6,
    bodyAlpha: 1.0,
    bodyLift: 0.3,
    highlight: { size: 0.45, intensity: 0.3, sharpness: 0.15 },  // soft white-hot core, not a gloss
    shadow: 0.2,
    stormGray: [96, 70, 64],
    bond: [255, 160, 80],
    trailAlpha: 0.18,
    bloomTint: [255, 150, 60],
    rimTint: [255, 120, 60],
    stormFx: 'embers',
  },

  metallic: {
    label: 'Metallic',
    ramp: [
      [0.00, [48, 52, 58]],     // gunmetal
      [0.35, [104, 113, 124]],  // steel
      [0.70, [205, 212, 220]],  // silver
      [1.00, [238, 216, 150]],  // pale gold
    ],
    bodyBlend: 'source-over',
    glowBlend: 'lighter',
    glowStrength: 0.4,         // sheen, not a glow
    bodyAlpha: 1.0,
    bodyLift: 0.45,            // strong lit-side sheen
    // Sharp, bright gleam that holds regardless of disruption charge.
    // Intensity above 1 draws the highlight a second time so it blows out to white.
    highlight: { size: 0.36, intensity: 1.7, sharpness: 0.8, floor: 0.9 },
    shadow: 0.7,
    stormGray: [58, 62, 70],
    bond: [200, 205, 215],
    trailAlpha: 0.13,
    bloomTint: [230, 205, 140],
    rimTint: [200, 215, 255],
    stormFx: 'sparks',
  },

};

export function getElement(name) {
  return ELEMENTS[name] || ELEMENTS.bioluminescent;
}

/**
 * Ramp position for a hue. The hue-circle element uses hue directly; ramp
 * elements mirror the circle (0 -> 0, 180 -> 1, 360 -> 0) so an entity whose
 * hue wraps past 360 doesn't snap from one end of the ramp to the other.
 */
export function hueToRampT(element, hue) {
  if (element.hueRamp) return hue / 360;
  return 1 - Math.abs(hue / 180 - 1);
}

/** Ramp color [r, g, b] at t in [0, 1]. */
export function rampColor(element, t) {
  if (element.hueRamp) {
    return hslToRgb(((t % 1) + 1) % 1 * 360, element.hueRamp.saturation, element.hueRamp.lightness);
  }
  const stops = element.ramp;
  if (t <= stops[0][0]) return stops[0][1].slice();
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1].slice();
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}
