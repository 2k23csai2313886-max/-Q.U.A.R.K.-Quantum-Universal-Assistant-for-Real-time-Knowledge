'use client';

import { useEffect, useRef } from 'react';

/**
 * Quantum orb — Canvas 2D particle field.
 *
 * Fixed from the original:
 *  • devicePixelRatio-aware backing store (was blurry on every retina display)
 *  • pauses on `visibilitychange` (was burning CPU forever in hidden tabs)
 *  • honours `prefers-reduced-motion` (renders one static frame)
 *  • the whole rAF body is guarded, not just the first call
 */
export default function QuantumOrb({ exciteSignal = 0, size = 320 }) {
  const canvasRef = useRef(null);
  const exciteRef = useRef(0);
  const lastSignal = useRef(0);

  useEffect(() => {
    if (exciteSignal !== lastSignal.current) {
      lastSignal.current = exciteSignal;
      exciteRef.current = 1;
    }
  }, [exciteSignal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // ── HiDPI backing store ────────────────────────────────────────────
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cssSize = () => canvas.clientWidth || size;
    const resize = () => {
      const s = cssSize();
      canvas.width = Math.round(s * dpr);
      canvas.height = Math.round(s * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const particles = Array.from({ length: 160 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 40 + Math.random() * 90,
      speed: (Math.random() * 0.006 + 0.002) * (Math.random() < 0.5 ? 1 : -1),
      wobble: Math.random() * Math.PI * 2,
      size: Math.random() * 1.6 + 0.6,
      hue: Math.random() < 0.5 ? 'cyan' : 'magenta',
    }));

    let t = 0;
    let raf = 0;
    let running = true;

    const accentRgb = () => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const m = /^#?([0-9a-f]{6})$/i.exec(hex);
      if (!m) return '77,234,255';
      const n = parseInt(m[1], 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };

    const draw = () => {
      try {
        const s = cssSize();
        const cx = s / 2, cy = s / 2;
        ctx.clearRect(0, 0, s, s);
        t += 1;
        if (exciteRef.current > 0) exciteRef.current = Math.max(0, exciteRef.current - 0.012);
        const excite = exciteRef.current;

        // core glow
        const coreR = 26 + Math.sin(t * 0.03) * 3 + excite * 10;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
        const acc = accentRgb();
        grad.addColorStop(0, `rgba(${acc},0.9)`);
        grad.addColorStop(0.4, 'rgba(139,107,255,0.35)');
        grad.addColorStop(1, 'rgba(139,107,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#eef7ff';
        ctx.beginPath();
        ctx.arc(cx, cy, coreR * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // orbit rings
        ctx.strokeStyle = 'rgba(139,92,246,0.18)';
        ctx.lineWidth = 1;
        for (const r of [70, 110, 150]) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, r * (s / 320), r * 0.4 * (s / 320), t * 0.002 + r, 0, Math.PI * 2);
          ctx.stroke();
        }

        // particles
        const tilt = 0.42;
        const scale = s / 320;
        for (const p of particles) {
          p.angle += p.speed * (1 + excite * 3);
          const wob = Math.sin(t * 0.02 + p.wobble) * 8;
          const r = (p.radius + wob) * scale;
          const x = cx + Math.cos(p.angle) * r;
          const y = cy + Math.sin(p.angle) * r * tilt;
          const depth = (Math.sin(p.angle) + 1) / 2;
          const color = p.hue === 'cyan' ? acc : '255,79,195';
          ctx.beginPath();
          ctx.fillStyle = `rgba(${color},${0.25 + depth * 0.6})`;
          ctx.arc(x, y, p.size * (0.6 + depth * 0.8), 0, Math.PI * 2);
          ctx.fill();
        }
      } catch {
        /* a dropped frame must never kill the loop */
      }
    };

    const loop = () => {
      if (!running) return;
      draw();
      raf = requestAnimationFrame(loop);
    };

    if (reduced) {
      draw(); // single static frame
    } else {
      loop();
    }

    const onVisibility = () => {
      if (reduced) return;
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [size]);

  return <canvas id="orb" ref={canvasRef} width={size} height={size} aria-hidden="true" />;
}
