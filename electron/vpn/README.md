# electron/vpn — the VPN core

Everything about *being connected* lives here. `main.cjs` owns the Electron
shell (window, tray, IPC surface, profiles, subscriptions, updates) and talks to
this directory through a single object.

## Why it exists

Connecting is not one action. It is a process, a routing dispatcher, a network
adapter with routes, the Windows proxy configuration, a firewall block, three
measurement loops, and a failover engine — and they all have to agree with each
other. Those used to be wired together by ordering rules spread across a
2,400-line `main.cjs`, with each subsystem re-deriving whether it should be
running by inspecting a handful of module-level variables. Two of those
variables were written from outside the connection lock, which is how a
disconnect issued during a server-selection sweep could be quietly overwritten
by the connect the sweep went on to perform.

## The shape

```
       IPC / tray                    main.cjs
            |
            v
        VpnCore  (core.cjs)          coordination, and nothing else
            |
   +--------+---------+------------------+
   |        |         |                  |
machine   tunnel   session        the entourage:
(state,  (xray +   (one live      telemetry, tunnel status,
 epoch,   dispatch  tunnel, as    health + failover,
 activity) + routes) a value)     system proxy, kill switch
```

Three ideas carry the whole design:

- **session** — one frozen value describing the live tunnel, with an identity.
  "Is this still the tunnel I was looking at?" is `a.id === b.id`, everywhere.
  Every subsystem follows the session, so re-broadcasting state changes nothing.
- **state machine** — legal transitions only, illegal ones refused rather than
  applied. An `epoch` marks each attempt so a late result can be discarded.
- **activity** — the one cancellable span of long work (a selection sweep, an
  auto-reconnect countdown). At most one exists; starting another cancels the
  first. This is what makes "the user pressed disconnect" reliably stop work
  that has not reached the connection lock yet.

## Files

| file | responsibility |
| --- | --- |
| `core.cjs` | the lifecycle: connect, disconnect, drops, reconnect, failover. Builds nothing. |
| `index.cjs` | the composition root — the only file that knows the real implementations. |
| `machine.cjs` | connection states, epochs, activities, the exclusive lock. |
| `session.cjs` | one live tunnel, as a frozen value with an identity. |
| `tunnel.cjs` | bringing xray + dispatcher + routes up and down, in order, with rollback. |
| `ports.cjs` | the whole port layout, allocated in one pass so collisions are impossible. |
| `endpoints.cjs` | which address and port to dial, for which purpose. |
| `routingPlan.cjs` | dispatcher-or-not plus the compiled rule list, settled before ports. |
| `telemetry.cjs` | latency and traffic, bound to the session. |
| `tunnelStatus.cjs` | the exit IP, measured from the outside through the tunnel. |
| `killSwitchGuard.cjs` | when the outbound block goes on and off. |
| `reconnect.cjs` | how hard and how often to retry after a drop. |
| `dispatcherHost.cjs` | the Smart Routing dispatcher's lifetime. |

The leaf mechanics — how to write the registry, how to install a route, how to
score a probe — stay in `electron/lib/`, unchanged.

## Tests

`npm test` runs `test/*.test.cjs` on Node's built-in runner, with no
dependencies and no Windows: `core.cjs` receives every collaborator through its
constructor, so the ordering, cancellation and rollback are all exercisable
against fakes.
