// Coalesce a burst of updates into one per animation frame.
//
// The pattern this generalises was already in finder/testEngine.js: when work
// runs several measurements at once, each result wants to update the UI, and
// the results arrive far faster than the screen can show a new frame. Applying
// them one at a time costs a full render each and buys nothing -- the user
// cannot see an update that is overwritten 4ms later.
//
// `schedule` runs `flush` at most once per frame, on the next frame after the
// first call. Callers accumulate whatever they need into their own buffer and
// drain it inside `flush`, so no update is dropped -- only the renders between
// them are.
//
// requestAnimationFrame, not setTimeout, on purpose: it is the only clock that
// is already aligned to the compositor, so the render lands in the frame that
// is about to paint rather than a few milliseconds into it.
export function createRafBatch(flush) {
  let scheduled = false;
  let handle = 0;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    handle = requestAnimationFrame(() => {
      scheduled = false;
      flush();
    });
  }

  // For unmount: drops the pending frame. The buffer is the caller's, so a
  // caller that needs the last batch applied should drain it itself first.
  function cancel() {
    if (!scheduled) return;
    scheduled = false;
    cancelAnimationFrame(handle);
  }

  return { schedule, cancel };
}
