// Small animation helpers shared across screens.
import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Count from 0 up to `target` over `ms` with an ease-out curve. Returns the
 * current integer value each frame. Jumps straight to `target` when the user
 * prefers reduced motion. Used for the send-receipt amount and balance bumps.
 */
export function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(() => (prefersReducedMotion() ? target : 0));
  const raf = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setV(target);
      return;
    }
    let start: number | undefined;
    const tick = (now: number) => {
      if (start === undefined) start = now;
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(Math.round(target * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ms]);
  return v;
}
