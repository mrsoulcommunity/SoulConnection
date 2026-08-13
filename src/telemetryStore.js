// ---- Live telemetry, outside React ----
//
// `traffic` and `latencyMs` are pushed from vpn/telemetry.cjs on a timer for
// the whole life of a connection. They used to be App state, and that was the
// single most expensive thing the renderer did: two numbers rendered in the
// footer forced App to reconcile its entire return value once a second --
// the sidebar, the hero, the tunnel panel, the settings pane, all of it. Four
// components had React.memo specifically to survive that tick, and the three
// that didn't (TunnelStatus, UpdateCard, FailoverStatus) simply re-rendered.
//
// Holding it here instead means the tick reaches exactly the two components
// that display it. Same shape as finder/testEngine.js: a module-level store
// read through useSyncExternalStore, with emits coalesced to one per animation
// frame so a latency update and a traffic update landing together cost one
// render rather than two.
//
// The IPC subscription is attached on the first subscriber, not at module
// load: in the browser dev harness `window.soul` is installed by main.jsx
// after this module has already been evaluated, so attaching eagerly would
// bind to nothing and the rail would sit empty forever.

const listeners = new Set();

// One immutable object, replaced (never mutated) on every change, so
// useSyncExternalStore's identity check is the truth about whether anything
// moved. Both fields are null whenever there is no tunnel to measure.
let state = { traffic: null, latencyMs: null };

let attached = false;

function emit() {
  for (const fn of listeners) fn();
}

let emitScheduled = false;
function emitThrottled() {
  if (emitScheduled) return;
  emitScheduled = true;
  requestAnimationFrame(() => {
    emitScheduled = false;
    emit();
  });
}

function attach() {
  if (attached || typeof window === 'undefined' || !window.soul) return;
  attached = true;
  window.soul.onTrafficUpdate?.((traffic) => {
    state = { ...state, traffic };
    emitThrottled();
  });
  window.soul.onLatencyUpdate?.(({ ms }) => {
    if (state.latencyMs === ms) return;
    state = { ...state, latencyMs: ms };
    emitThrottled();
  });
}

export function subscribe(fn) {
  attach();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // Deliberately keeps the IPC subscription for the life of the window. The
    // readouts unmount and remount as tabs change; tearing the channel down
    // and rebuilding it each time would drop whichever tick landed in between,
    // and there is exactly one of these per app.
  };
}

export function getSnapshot() {
  return state;
}

// Called when the connection leaves 'connected'. The measurements belong to a
// tunnel that no longer exists, and leaving them on screen is how a footer
// comes to report a speed for a session that ended -- so this is a correctness
// concern, not a tidiness one. Flushed immediately rather than on the next
// frame: disconnecting is a user action and the rail should answer it at once.
export function resetTelemetry() {
  if (state.traffic === null && state.latencyMs === null) return;
  state = { traffic: null, latencyMs: null };
  emit();
}
