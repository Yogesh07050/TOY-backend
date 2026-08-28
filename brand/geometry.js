'use strict';

/**
 * Shared geometry for the OffersOffer mark: two interlocking rings, ink on the
 * left and gold on the right, each an open ellipse whose gap faces the other.
 *
 * The rings are emitted as explicit elliptical-arc paths rather than a stroked
 * <ellipse> with a dash gap: `pathLength` is unevenly supported (librsvg
 * ignores it, which repeats the dash pattern and scallops the edge), and an
 * arc path renders identically everywhere - browser, email client, rasteriser.
 */

const rad = (deg) => (deg * Math.PI) / 180;

/** Point at parametric angle `t` (radians) on an ellipse rotated by `rot`. */
function pointAt({ cx, cy, rx, ry, rot }, t) {
  const cos = Math.cos(rad(rot));
  const sin = Math.sin(rad(rot));
  const x = rx * Math.cos(t);
  const y = ry * Math.sin(t);
  return [cx + x * cos - y * sin, cy + x * sin + y * cos];
}

/** An open arc sweeping clockwise from `from` to `to` (degrees). */
function arc(ellipse, from, to) {
  const start = pointAt(ellipse, rad(from));
  const end = pointAt(ellipse, rad(to));
  const largeArc = (to - from + 360) % 360 > 180 ? 1 : 0;
  const f = (n) => Number(n.toFixed(2));
  return (
    `M ${f(start[0])} ${f(start[1])} ` +
    `A ${ellipse.rx} ${ellipse.ry} ${ellipse.rot} ${largeArc} 1 ${f(end[0])} ${f(end[1])}`
  );
}

// Proportions measured off the reference artwork: the rings are noticeably
// elongated (rx:ry about 3:2) and tilted, and the band is thin relative to the
// ring - roughly a quarter of the radius rather than a third.
const STROKE = 36;
const base = { rx: 146, ry: 94, rot: -20, cy: 160 };
const ink = { ...base, cx: 203 };
const gold = { ...base, cx: 357 };

// Each ring is open by 54 degrees. These are parametric angles on the ellipse,
// not screen angles - on a shape this elongated the two differ by more than 10
// degrees, which is the difference between the notch landing where the
// reference puts it and it sitting visibly too high. t=0 is the rightmost
// point and grows clockwise (SVG's y axis points down); the ink notch faces
// the gold ring and the gold notch mirrors it exactly 180 degrees away.
const inkPath = arc(ink, 7, -48);
const goldPath = arc(gold, 187, 132);

const VIEW = { width: 560, height: 320 };

module.exports = { STROKE, VIEW, ink, gold, inkPath, goldPath, pointAt, arc };
