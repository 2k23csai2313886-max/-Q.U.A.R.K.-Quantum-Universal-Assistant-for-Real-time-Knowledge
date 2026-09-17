'use client';

/**
 * Timers & reminders with localStorage persistence.
 * Reminders survive a page reload; timers resume their remaining duration.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'quark.timers.v1';
let seq = 0;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => t && t.id) : [];
  } catch {
    return [];
  }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50))); } catch { /* quota / private mode */ }
}

export function useTimers({ onDue } = {}) {
  const [items, setItems] = useState([]);
  const [tick, setTick] = useState(0);
  const onDueRef = useRef(onDue);
  onDueRef.current = onDue;
  const firedRef = useRef(new Set());

  // hydrate once, client-side only
  useEffect(() => {
    setItems(load());
  }, []);

  // 1s heartbeat
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const itemsRef = useRef([]);
  itemsRef.current = items;
  const persist = useCallback((next) => { itemsRef.current = next; setItems(next); save(next); }, []);

  const add = useCallback(
    ({ kind = 'timer', seconds = 0, at = null, label = 'Timer' }) => {
      const id = `q${Date.now().toString(36)}${(++seq).toString(36)}`;
      const dueAt = kind === 'reminder' ? new Date(at).getTime() : Date.now() + seconds * 1000;
      const item = { id, kind, label, dueAt, seconds: kind === 'timer' ? seconds : null, at, created: Date.now() };
      setItems((prev) => {
        const next = [...prev, item];
        save(next);
        return next;
      });
      return item;
    },
    [],
  );

  // Read from a ref rather than mutating inside the state updater — updaters
  // run twice under StrictMode, so side effects there are unsafe.
  const cancel = useCallback((id) => {
    const found = itemsRef.current.some((t) => t.id === id);
    if (found) {
      const next = itemsRef.current.filter((t) => t.id !== id);
      persist(next);
    }
    firedRef.current.delete(id);
    return found;
  }, [persist]);

  const clearAll = useCallback(() => {
    const n = itemsRef.current.length;
    persist([]);
    firedRef.current.clear();
    return n;
  }, [persist]);

  // fire due items
  useEffect(() => {
    if (!tick) return;
    const now = Date.now();
    for (const t of items) {
      if (t.dueAt <= now && !firedRef.current.has(t.id)) {
        firedRef.current.add(t.id);
        onDueRef.current?.(t);
      }
    }
  }, [tick, items]);

  const decorated = items.map((t) => {
    const remainingMs = Math.max(0, t.dueAt - Date.now());
    return {
      ...t,
      remainingMs,
      due: remainingMs === 0,
      remainingLabel: formatRemaining(remainingMs),
    };
  });

  return { items: decorated, add, cancel, clearAll, list: () => items };
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  if (s <= 0) return 'DUE';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
