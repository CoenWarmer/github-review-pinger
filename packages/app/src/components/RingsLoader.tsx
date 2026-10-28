import { useEffect, useRef } from "react";

// Concentric noise rings after the pattern of that name on bookofshapes.com by
// Nikolaj Sokolowski: rings spaced evenly between a minimum and maximum
// radius, each wobbling by noise sampled along a circle. Neighbouring rings
// sample nearby noise, so they wobble alike. Here the noise drifts over time,
// so the rings slowly morph.
const RINGS = 11;
const MIN_RADIUS = 11;
const MAX_RADIUS = 42;
const AMPLITUDE = 5.5;
const SEGMENTS = 96;
/** How far apart, in noise space, the sampled circle's points are. */
const NOISE_RADIUS = 1.5;
/** How far apart the first and last rings sample, in noise space. */
const RING_SPREAD = 3;
/** Noise space travelled per second. */
const DRIFT = 0.45;
const STROKE = 1.1;
/** Opacity of each ring from the inside out, so some stand out and some recede. */
const OPACITIES = [1, 0.35, 0.7, 0.3, 0.9, 0.45, 0.25, 0.8, 0.4, 1, 0.55];

const VIEW = MAX_RADIUS + AMPLITUDE + STROKE + 1;

// Classic Perlin noise in 3D, returning roughly -1 to 1.
const PERMUTATION = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 7;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return [...p, ...p];
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

function gradient(hash: number, x: number, y: number, z: number) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function noise(x: number, y: number, z: number) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const p = PERMUTATION;
  const A = p[X] + Y;
  const AA = p[A] + Z;
  const AB = p[A + 1] + Z;
  const B = p[X + 1] + Y;
  const BA = p[B] + Z;
  const BB = p[B + 1] + Z;
  return lerp(
    w,
    lerp(
      v,
      lerp(u, gradient(p[AA], x, y, z), gradient(p[BA], x - 1, y, z)),
      lerp(u, gradient(p[AB], x, y - 1, z), gradient(p[BB], x - 1, y - 1, z)),
    ),
    lerp(
      v,
      lerp(u, gradient(p[AA + 1], x, y, z - 1), gradient(p[BA + 1], x - 1, y, z - 1)),
      lerp(u, gradient(p[AB + 1], x, y - 1, z - 1), gradient(p[BB + 1], x - 1, y - 1, z - 1)),
    ),
  );
}

function ringPath(ring: number, time: number) {
  const fraction = ring / (RINGS - 1);
  const radius = MIN_RADIUS + fraction * (MAX_RADIUS - MIN_RADIUS);
  const z = 10 + fraction * RING_SPREAD + time * DRIFT;
  let d = "";
  for (let i = 0; i < SEGMENTS; i++) {
    const angle = (i / SEGMENTS) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const r = radius + AMPLITUDE * noise(cos * NOISE_RADIUS + 20, sin * NOISE_RADIUS + 20, z);
    d += `${i === 0 ? "M" : "L"}${(cos * r).toFixed(2)} ${(sin * r).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** The rings morph while `loading`, and hold still otherwise. */
export function RingsLoader({
  size = 208,
  loading = true,
}: {
  size?: number;
  loading?: boolean;
}) {
  const paths = useRef<(SVGPathElement | null)[]>([]);
  /** Seconds of morphing so far, so the rings resume where they stopped. */
  const elapsed = useRef(0);

  useEffect(() => {
    const draw = () =>
      paths.current.forEach((path, ring) =>
        path?.setAttribute("d", ringPath(ring, elapsed.current)),
      );
    draw();
    if (!loading || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let last: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      if (last !== null) elapsed.current += (now - last) / 1000;
      last = now;
      draw();
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);

  return (
    <svg
      role="img"
      aria-label={loading ? "Loading" : "Review Pinger"}
      width={size}
      height={size}
      viewBox={`${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`}
      className="text-info"
    >
      {Array.from({ length: RINGS }, (_, ring) => (
        <path
          key={ring}
          ref={(el) => {
            paths.current[ring] = el;
          }}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeOpacity={OPACITIES[ring % OPACITIES.length]}
        />
      ))}
    </svg>
  );
}
