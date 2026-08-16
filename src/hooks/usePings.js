import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pingMs, toEntry } from '../utils/ping.js';
import { createRafBatch } from '../utils/rafBatch.js';

const PING_CONCURRENCY = 12;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// ---- Ping results, published one frame at a time ----
//
// A sweep runs PING_CONCURRENCY measurements at once and each one wants to
// write twice (a "measuring" mark, then the reading). Applied individually
// that is up to a thousand renders over a few seconds, each one rebuilding
// the whole sidebar -- during the exact stretch the user is watching a
// spinner. So the truth lives in a ref, written synchronously, and is
// published to state at most once per animation frame. Nothing is dropped;
// only the renders between frames are.
export default function usePings() {
  const pingsRef = useRef({});
  const [pings, setPings] = useState(pingsRef.current);
  // The live batch measurement, or null. See handlePingAll.
  const sweepStateRef = useRef(null);
  const [pingSweep, setPingSweep] = useState(null);
  // The cancellation token of the sweep in flight -- separate from the readout
  // above, because the stop button has to reach it without a re-render.
  const pingSweepRef = useRef(null);

  // The one place ping state reaches React. Everything above it writes the ref
  // synchronously and asks for a frame; this hands both readouts to React
  // together, so a sweep costs one render per frame instead of two per server.
  const publishPings = useCallback(() => {
    setPings({ ...pingsRef.current });
    setPingSweep(sweepStateRef.current ? { ...sweepStateRef.current } : null);
  }, []);
  const pingFrame = useMemo(() => createRafBatch(publishPings), [publishPings]);
  useEffect(() => () => pingFrame.cancel(), [pingFrame]);

  // `undefined` removes the row's reading rather than storing an empty one --
  // that is what restores a cancelled measurement to "never measured".
  const writePing = useCallback((id, entry) => {
    if (entry === undefined) delete pingsRef.current[id];
    else pingsRef.current[id] = entry;
    pingFrame.schedule();
  }, [pingFrame]);

  // Keeps the previous reading visible while a new one is in flight, so a
  // re-ping doesn't blank the row out and shift the layout under the cursor.
  const handlePing = useCallback(async (id, token) => {
    // `method` rides along so the "measured through the tunnel" marker doesn't
    // blink off and back on during a re-measure of the connected server.
    const previous = pingsRef.current[id];
    writePing(id, { status: 'measuring', prev: pingMs(previous), method: previous?.method });
    try {
      const result = await window.soul.pingTest(id, token);
      // Abandoned by a stop button. The server was not measured and did not
      // fail -- marking the row red would be inventing a result, so it goes
      // back to whatever it showed before.
      if (result && result.cancelled) {
        writePing(id, previous);
        return null;
      }
      const entry = toEntry(result);
      writePing(id, entry);
      return pingMs(entry) ?? -1;
    } catch (err) {
      writePing(id, { status: 'fail', message: err.message, at: Date.now() });
      return -1;
    }
  }, [writePing]);

  // A sweep is a whole batch of measurements, and the user watching it wants
  // three things the old version never told them: how far along it is, how it
  // turned out, and how to stop it. `pingSweepRef` holds the live token so the
  // cancel button can reach it without re-rendering every card on each tick.
  const handlePingAll = useCallback(async (ids) => {
    if (pingSweepRef.current || !ids.length) return;
    const token = { cancelled: false, id: `sweep-${Date.now()}` };
    pingSweepRef.current = token;
    sweepStateRef.current = {
      total: ids.length, done: 0, ok: 0, best: null, running: true, cancelled: false,
    };
    pingFrame.schedule();
    try {
      await mapWithConcurrency(ids, PING_CONCURRENCY, async (id) => {
        // Cancelling stops the queue; measurements already in flight are left
        // to finish, because the main process has no way to abort one midway
        // and pretending otherwise would leave their rows spinning forever.
        if (token.cancelled) return;
        const ms = await handlePing(id, token.id);
        // null means it was abandoned mid-measurement: it counts towards
        // neither the measured tally nor the failures.
        if (ms == null) return;
        const s = sweepStateRef.current;
        if (!s) return; // dismissed mid-sweep
        s.done += 1;
        if (ms >= 0) {
          s.ok += 1;
          if (s.best == null || ms < s.best) s.best = ms;
        }
        pingFrame.schedule();
      });
    } finally {
      pingSweepRef.current = null;
      if (sweepStateRef.current) {
        sweepStateRef.current.running = false;
        sweepStateRef.current.cancelled = token.cancelled;
      }
      pingFrame.schedule();
    }
  }, [handlePing, pingFrame]);

  // Stops the queue AND abandons the dozen measurements already running, so
  // "stopping" takes about as long as it says rather than quietly finishing the
  // batch. Rows that were mid-measurement revert to their previous reading.
  const handleCancelPingAll = useCallback(() => {
    const token = pingSweepRef.current;
    if (!token) return;
    token.cancelled = true;
    if (sweepStateRef.current) sweepStateRef.current.cancelled = true;
    pingFrame.schedule();
    window.soul.pingCancel?.(token.id).catch(() => {});
  }, [pingFrame]);

  const handleDismissPingSweep = useCallback(() => {
    sweepStateRef.current = null;
    pingFrame.schedule();
  }, [pingFrame]);

  return { pings, pingSweep, handlePing, handlePingAll, handleCancelPingAll, handleDismissPingSweep };
}
