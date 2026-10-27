import { useEffect, useRef } from "react";

// A halftone sphere after the "Halftone Sphere" pattern on bookofshapes.com by
// Nikolaj Sokolowski: a grid of dots whose radius falls off with the distance
// from a light, inverted and clamped. Here the light orbits, so the sphere seems to turn.
const GRID = 11;
const SPACING = 10;
/** Radius of the biggest dot. */
const DOT = 3.9;
/** Distance from the light at which dots reach their minimum. */
const FALLOFF = 62;
const MIN_SCALE = 0.02;
/** How far the light travels from the center. */
const ORBIT = 16;
const PERIOD_MS = 2400;

const EXTENT = ((GRID - 1) / 2) * SPACING;
const DOTS = Array.from({ length: GRID * GRID }, (_, i) => ({
  x: (i % GRID) * SPACING - EXTENT,
  y: Math.floor(i / GRID) * SPACING - EXTENT,
}));

function radius(x: number, y: number, lightX: number, lightY: number) {
  const falloff = 1 - Math.hypot(x - lightX, y - lightY) / FALLOFF;
  return DOT * Math.max(MIN_SCALE, falloff);
}

export function HalftoneLoader({ size = 96 }: { size?: number }) {
  const circles = useRef<(SVGCircleElement | null)[]>([]);

  useEffect(() => {
    const draw = (lightX: number, lightY: number) =>
      DOTS.forEach(({ x, y }, i) =>
        circles.current[i]?.setAttribute("r", String(radius(x, y, lightX, lightY))),
      );
    draw(0, 0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = requestAnimationFrame(function step(now) {
      const angle = (now / PERIOD_MS) * Math.PI * 2;
      draw(Math.cos(angle) * ORBIT, Math.sin(angle) * ORBIT);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const view = EXTENT + DOT + 2;
  return (
    <svg
      role="img"
      aria-label="Loading"
      width={size}
      height={size}
      viewBox={`${-view} ${-view} ${view * 2} ${view * 2}`}
      className="text-info"
    >
      {DOTS.map(({ x, y }, i) => (
        <circle
          key={i}
          ref={(el) => {
            circles.current[i] = el;
          }}
          cx={x}
          cy={y}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
