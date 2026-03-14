# HearthNet

**Persistent Multi-Agent Orchestration for Smart Homes on Commodity Edge Hardware**

HearthNet is a protocol and reference implementation for coordinating multiple AI agents managing smart home devices. It uses Git as an append-only audit log and MQTT for real-time agent communication, ensuring every actuation is authorized, conflict-free, and recoverable.

📄 **Paper:** _HearthNet: Persistent Multi-Agent Orchestration for Smart Home on Commodity Edge Hardware_ (CAIS 2026)  
🎬 **Demo Video:** [Coming soon]  
🌐 **Interactive Demo:** https://hearthnet.vercel.app/: 
The interactive demo replays the full protocol trace from our deployed prototype. Since the physical lab cannot be accessed remotely, the demo uses a pre-recorded trace of all Git commits from a live run.

**How to use:**
1. **Browse the timeline** — scroll through all events across the three demo scenes. Each commit shows the agent (color-coded), message type, and content.
2. **Click any commit** to inspect it in the detail panel (right side) — see the full hash, timestamp, author, and changed files.
3. **Switch scenes** using the tabs at the top: `All`, `1` (Coordinated Actuation), `2` (Conflict Resolution), `3` (Freshness Verification).
4. **Replay mode** — click the ▶️▶️ button in the toolbar to enter replay. Use ▶️ to play through events with real-time pacing, or step manually with ⏪/⏩. Adjust speed (0.5×–4×) to watch the protocol unfold.
5. **Topology graph** (left panel) — shows directed message flow between agents, animated on each event during replay.

The trace contains 38 events across 4 agents (Rupert, Jeeves, Darcy, Dewey) managing real smart home devices.
---

## Architecture

```
┌──────────┐     MQTT      ┌──────────┐     MQTT      ┌──────────┐
│  Rupert  │◄────────────► │  Jeeves  │◄────────────► │  Darcy   │
│  (root)  │               │ (HA mgr) │               │ (mobile) │
└────┬─────┘               └────┬─────┘               └────┬─────┘
     │                          │                          │
     │         ┌────────────────┴──────────────────┐       │
     └────────►│           Dewey (Librarian)       │◄──────┘
               │  Git repo · Lease validation ·    │
               │  Conflict detection · Audit log   │
               └───────────────────────────────────┘
```

**Agents:**
- **Rupert** — Root orchestrator. Receives user intent, decomposes into subtasks, arbitrates conflicts.
- **Jeeves** — Home Assistant manager. Controls lights, speakers, climate via HA REST API.
- **Darcy** — Mobile device manager. Controls phone settings via ADB.
- **Dewey** — Librarian. Maintains the Git ground-truth repo, validates leases, detects conflicts, enforces freshness.

## Key Properties

| Property | Mechanism |
|----------|-----------|
| **Authorized actuation** | Lease system — agents must hold a valid lease before actuating any device |
| **Conflict resolution** | Dewey detects conflicting state changes; Rupert arbitrates using Git timeline |
| **Freshness verification** | Every lease is bound to a `base_commit`; stale commits are rejected |
| **Full auditability** | Every event (task, response, lease, execution, conflict, resolution) is a Git commit |
| **Crash recovery** | Agents re-sync from Git HEAD; expired leases cannot be replayed |

## Demo Scenes

### Scene 1: Intent-Driven Coordination
User says "I'm working from home." Rupert decomposes into 4 subtasks (lights, speakers, focus timer, DND), issues leases, agents execute in parallel, all committed to Git.

### Scene 2: Conflict Resolution
A scheduled "evening wind-down" routine fires while WFH mode is active. Jeeves and Darcy both request conflicting state changes. Dewey detects the conflicts, Rupert queries the Git timeline, determines user-explicit intent takes priority over scheduled routines, and denies both leases.

### Scene 3: Freshness & Authorization Verification
Jeeves crashes and restarts with stale state. It attempts to replay a pre-crash command with an expired lease bound to an old commit. Dewey blocks it with a double safety gate (stale base_commit + expired lease). Even after re-syncing, Rupert denies the request on policy grounds — freshness alone is insufficient; policy coherence is required.

## Quick Start

### Prerequisites
- Node.js ≥ 20
- MQTT broker (e.g., Mosquitto) running on port 1883
- Git

### Setup
```bash
git clone https://github.com/<owner>/hearthnet.git
cd hearthnet
npm install

# Set the HMAC signing secret (any string, must be consistent across agents)
export HEARTHNET_ROOT_SECRET=your-secret-here

# Configure MQTT credentials (edit protocol/msg.js or set env vars)
export MQTT_HOST=127.0.0.1
export MQTT_USER=rupert
export MQTT_PASS=agentcomms2026
```

### Run the Demo
```bash
# Start the librarian (must be running before demo scenes)
npm run librarian

# In another terminal — run all three scenes interactively
npm run demo

# Or run scenes individually
npm run scene1
npm run scene2
npm run scene3

# Run with a fresh Git repo
npm run demo:reset
```

### Live Visualizer
```bash
npm run visualizer
# Open http://localhost:3456
```

The visualizer shows the Git commit timeline in real-time as agents communicate. Features:
- **Color-coded agents** — each agent has a distinct color
- **Type badges** — TASK, RESPONSE, LEASE_GRANT, LEASE_DENIED, CONFLICT, RESOLUTION, etc.
- **Scene separators** — clear visual breaks between demo scenes
- **Topology graph** — SVG network diagram showing directed agent-to-agent message flow
- **Detail panel** — click any commit to inspect hash, author, timestamp, changed files
- **Replay mode** — step through commits with real-time pacing, adjustable speed (0.5×–4×)
- **Live SSE updates** — new commits appear within ~50ms via `fs.watch`

### Collect Metrics
```bash
node demo/run-metrics.js
```

Runs Scene 2 and Scene 3 five times each, reports completion rates, detection rates, and timing.

## Project Structure

```
hearthnet/
├── protocol/
│   ├── msg.js                  # MQTT message construction + agent client factory
│   ├── lease.js                # Lease creation, validation, HMAC signing
│   └── message-schema.json     # Message envelope schema
├── librarian/
│   └── dewey-librarian.js      # Git-backed librarian: commit events, validate leases,
│                                #   detect conflicts, enforce freshness
├── demo/
│   ├── demo-common.js          # Shared helpers for demo scripts
│   ├── scene1-coordinated-actuation.js
│   ├── scene2-conflict-resolution.js
│   ├── scene3-freshness-verification.js
│   ├── run-all.sh              # Run all scenes interactively
│   └── run-metrics.js          # Batch metric collection
├── visualizer/
│   ├── server.js               # Express + SSE server, fs.watch on Git repo
│   └── public/
│       ├── index.html
│       ├── style.css
│       ├── app.js              # Client: timeline, topology graph, replay controller
│       └── hearthnet-trace.json # Pre-baked snapshot for static deployment
├── scripts/
│   └── test-lease.js           # Lease unit tests
├── package.json
└── README.md
```

## Evaluation

| Metric | Result |
|--------|--------|
| **Scene 1** — Task completion | 4/4 subtasks |
| **Scene 1** — End-to-end latency | 8 s |
| **Scene 2** — Conflicts detected | 5/5 |
| **Scene 2** — Conflicts resolved | 5/5 |
| **Scene 3** — Stale commands rejected | 5/5 |
| **Scene 3** — Expired leases rejected | 5/5 |
| **Scene 3** — False rejections | 0 |
| **Cross-cutting** — Events persisted | 153/153 |
| **Cross-cutting** — MQTT latency (local) | <1 ms |
| **Cross-cutting** — Git integrity (`fsck`) | OK |

## Hardware

The prototype runs on commodity hardware:
- **Mac mini M4** — Root agent (Rupert), MQTT broker
- **Intel NUC N150** — Home Assistant, Librarian (Dewey), Jeeves
- **Android phone** — Mobile agent (Darcy) via ADB
- **Philips Hue** — Smart lights
- **Network** — Tailscale mesh (WireGuard)

Total cost: ~£400 for the edge compute layer.

## License

MIT

## Citation

```bibtex
@inproceedings{hearthnet2026,
  title={HearthNet: Persistent Multi-Agent Orchestration for Smart Home on Commodity Edge Hardware},
  booktitle={Proceedings of CAIS 2026},
  year={2026}
}
```
