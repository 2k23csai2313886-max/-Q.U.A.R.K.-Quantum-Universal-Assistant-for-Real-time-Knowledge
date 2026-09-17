'use client';

import { useEffect, useState } from 'react';

/** Ambient drifting specks + corner brackets. Memoised so they never re-render. */
export function Specks({ count = 14 }) {
  // Math.random() during SSR would produce different markup on the client and
  // trip React's hydration check, so positions are assigned after mount.
  const [specks, setSpecks] = useState([]);
  useEffect(() => {
    setSpecks(
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: `${Math.random() * 100}vw`,
        top: `${60 + Math.random() * 35}vh`,
        duration: `${14 + Math.random() * 18}s`,
        delay: `${Math.random() * 10}s`,
      })),
    );
  }, [count]);

  return (
    <div id="specks" aria-hidden="true">
      {specks.map((s) => (
        <div
          key={s.id}
          className="speck"
          style={{ left: s.left, top: s.top, animationDuration: s.duration, animationDelay: s.delay }}
        />
      ))}
    </div>
  );
}

export function CornerBrackets() {
  return (
    <div aria-hidden="true">
      <div className="bracket tl" /><div className="bracket tr" />
      <div className="bracket bl" /><div className="bracket br" />
    </div>
  );
}

/** Live clock-driven document title. */
export function useDocumentTitle(text) {
  useEffect(() => {
    const prev = document.title;
    document.title = text;
    return () => { document.title = prev; };
  }, [text]);
}
