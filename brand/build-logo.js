'use strict';

/**
 * Generates the OffersOffer mark.
 *
 * The rings are emitted as explicit elliptical-arc paths rather than a stroked
 * <ellipse> with a dash gap: `pathLength` is unevenly supported (librsvg
 * ignores it, which repeats the dash pattern and scallops the edge), and an
 * arc path renders identically everywhere - browser, email client, rasteriser.
 */

const fs = require('node:fs');

const TAU = Math.PI * 2;
const rad = (deg) => (deg * Math.PI) / 180;

/** Point at parametric angle `t` on an ellipse rotated by `rot`. */
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
  let sweep = (to - from + 360) % 360;
  const largeArc = sweep > 180 ? 1 : 0;
  const f = (n) => Number(n.toFixed(2));
  return (
    `M ${f(start[0])} ${f(start[1])} ` +
    `A ${ellipse.rx} ${ellipse.ry} ${ellipse.rot} ${largeArc} 1 ${f(end[0])} ${f(end[1])}`
  );
}

// Both rings share a geometry, offset horizontally so they interlock.
const base = { rx: 150, ry: 122, rot: -14, cy: 210 };
const black = { ...base, cx: 232 };
const gold = { ...base, cx: 408 };

// Each ring is open by ~66 degrees. The black gap sits at roughly 1 o'clock and
// the gold gap at roughly 7 o'clock, mirroring each other about the centre.
// t=0 is the rightmost point and grows clockwise (SVG's y axis points down),
// so -50 is roughly 1 o'clock and 130 is roughly 7 o'clock.
const blackPath = arc(black, -16, -84);
const goldPath = arc(gold, 164, 96);

const STROKE = 50;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" role="img" aria-label="OffersOffer">
  <title>OffersOffer</title>
  <defs>
    <linearGradient id="oo-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFD64F"/>
      <stop offset="0.5" stop-color="#F9B417"/>
      <stop offset="1" stop-color="#EF8F00"/>
    </linearGradient>
    <linearGradient id="oo-ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3B3B3E"/>
      <stop offset="0.55" stop-color="#232326"/>
      <stop offset="1" stop-color="#151517"/>
    </linearGradient>
    <!-- The upper crossing only: where the black ring passes in front. -->
    <clipPath id="oo-cross">
      <rect x="286" y="52" width="104" height="140"/>
    </clipPath>
  </defs>

  <g fill="none" stroke-width="${STROKE}" stroke-linecap="butt">
    <path d="${blackPath}" stroke="url(#oo-ink)"/>
    <path d="${goldPath}" stroke="url(#oo-gold)"/>
    <g clip-path="url(#oo-cross)">
      <path d="${blackPath}" stroke="url(#oo-ink)"/>
    </g>
  </g>
</svg>
`;

fs.writeFileSync('logo-mark.svg', svg);
console.log('logo-mark.svg written');
