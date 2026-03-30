# HearthNet

**Edge Multi-Agent Orchestration for Smart Homes**

<p align="center">
  <a href="https://www.youtube.com/watch?v=p3ZKDsKifRk">
    <img src="https://github.com/user-attachments/assets/defb7997-4e8d-4c85-be7b-52a21bbc472d" alt="HearthNet Demo Video" width="720">
  </a>
  <br>
  <sub>▶️ Watch the 3-minute demo on YouTube</sub>
</p>

> **ACM CAIS 2026 — System Demonstration**
>
> HearthNet is a protocol and reference implementation for coordinating multiple AI agents that manage smart-home devices. It uses Git as an append-only audit log and MQTT for real-time inter-agent communication, ensuring every actuation is authorized, conflict-free, and recoverable — all running on commodity edge hardware.

| | |
|---|---|
| 📄 **Paper** | _HearthNet: Edge Multi-Agent Orchestration for Smart Homes_ (CAIS 2026) |
| 🔧 **Framework** | [`hearthnet_framework`](https://github.com/zhonghaozhan/hearthnet_framework) — full protocol implementation (this repo is the standalone demo visualizer) |
| 🎬 **Demo Video** | [YouTube (3 min)](https://www.youtube.com/watch?v=p3ZKDsKifRk) |
| 🌐 **Interactive Demo** | [hearthnet.vercel.app](https://hearthnet.vercel.app/) — **no setup required; try it now** |

---

## Why HearthNet?

Most multi-agent smart-home work today puts all agents behind a single gateway — sub-agents of one LLM orchestrator, addressing non-physical layers like intent parsing or routine scheduling. None of them run as persistent, independent processes that directly actuate heterogeneous IoT hardware across separate edge nodes.

HearthNet fills this gap. It deploys four persistent agents with distinct roles (orchestrator, Home Assistant controller, mobile controller, librarian) across commodity devices, coordinating over MQTT and using Git as a shared append-only ledger. This design surfaces the hard problems that single-gateway setups never encounter: concurrent actuation conflicts, stale-state replay after a crash, and lease-based authorization when no single process owns the truth.

---

## Architecture

```
┌──────────┐  MQTT  ┌──────────┐  MQTT  ┌──────────┐
│  Rupert  │◄──────►│  Jeeves  │◄──────►│  Darcy   │
│  (root)  │        │ (HA mgr) │        │ (mobile) │
└────┬─────┘        └────┬─────┘        └────┬─────┘
     │                   │                   │
     │   ┌───────────────┴─────────────────┐ │
     └──►│       Dewey (Librarian)         │◄┘
         │  Git repo · Lease validation ·  │
         │  Conflict detection · Audit log │
         └─────────────────────────────────┘
```

| Agent | Role |
|-------|------|
| **Rupert** | Root orchestrator — receives user intent, decomposes into subtasks, arbitrates conflicts |
| **Jeeves** | Home Assistant manager — controls lights, speakers, and climate via the HA REST API |
| **Darcy** | Mobile device manager — controls phone settings via ADB |
| **Dewey** | Librarian — maintains the Git ground-truth repo, validates leases, detects conflicts, enforces freshness |

## Key Properties

| Property | Mechanism |
|----------|-----------|
| **Authorized actuation** | Agents must hold a valid, HMAC-signed lease before actuating any device |
| **Conflict resolution** | Dewey detects conflicting state changes; Rupert arbitrates using the Git timeline |
| **Freshness verification** | Every lease is bound to a `base_commit`; stale commits are rejected |
| **Full auditability** | Every event (task, response, lease, execution, conflict, resolution) is a Git commit |
| **Crash recovery** | Agents re-sync from Git HEAD; expired leases cannot be replayed |

---

## Demo Scenes

The demo trace contains **38 events** across the four agents managing real smart-home devices (Philips Hue lights, Sonos speakers, Android phone via ADB).

### Scene 1 — Intent-Driven Coordination

User says _"I'm working from home."_ Rupert decomposes the intent into four subtasks (lights, speakers, focus timer, DND), issues leases to Jeeves and Darcy, the agents execute in parallel, and every step is committed to Git.

### Scene 2 — Conflict Resolution

A scheduled "evening wind-down" routine fires while WFH mode is still active. Jeeves and Darcy both request conflicting state changes. Dewey detects the conflicts; Rupert queries the Git timeline, determines that user-explicit intent takes priority over scheduled routines, and denies both leases.

### Scene 3 — Freshness & Authorization Verification

Jeeves crashes and restarts with stale state. It attempts to replay a pre-crash command with an expired lease bound to an old commit. Dewey blocks it with a double safety gate (stale `base_commit` + expired lease). Even after re-syncing, Rupert denies the request on policy grounds — freshness alone is insufficient; policy coherence is required.

---

## Evaluation

Results from five repeated runs of each scene (`node demo/run-metrics.js`):

| Metric | Result |
|--------|--------|
| **Scene 1** — Task completion | 4/5 subtasks |
| **Scene 1** — End-to-end latency | 8 s |
| **Scene 2** — Conflicts detected | 5/5 |
| **Scene 2** — Conflicts resolved | 5/5 |
| **Scene 3** — Stale commands rejected | 5/5 |
| **Scene 3** — Expired leases rejected | 5/5 |
| **Scene 3** — False rejections | 0 |
| **Cross-cutting** — Events persisted | 153/153 |
| **Cross-cutting** — MQTT latency (local) | < 1 ms |
| **Cross-cutting** — Git integrity (`fsck`) | OK |

---

## Interactive Demo

> **No setup required.** The interactive demo at [**hearthnet.vercel.app**](https://hearthnet.vercel.app/) replays the full protocol trace from our physical deployment — you can explore every commit, conflict, and resolution right in the browser.

<details>
<summary><strong>How to explore the demo</strong></summary>

1. **Browse the timeline** — scroll through events across all three scenes. Each commit shows the agent (color-coded), message type, and payload.
2. **Inspect a commit** — click any event to open the detail panel (right side) with the full hash, timestamp, author, and changed files.
3. **Switch scenes** — use the tabs at the top: `All`, `1` (Coordinated Actuation), `2` (Conflict Resolution), `3` (Freshness Verification).
4. **Replay mode** — click ▶️▶️ in the toolbar, then use ▶️ to play with real-time pacing or ⏪/⏩ to step manually. Adjust speed from 0.5× to 4×.
5. **Topology graph** — the left panel shows a directed message-flow diagram between agents, animated during replay.

</details>

---

## Hardware

The entire prototype runs on commodity hardware (total: ≈ £400 for the edge-compute layer):

| Device | Role |
|--------|------|
| Mac mini M4 | Root agent (Rupert), MQTT broker |
| Intel NUC 11 | Home Assistant, Librarian (Dewey), Jeeves |
| Android phone | Mobile agent (Darcy) via ADB |
| Philips Hue bridge + bulbs | Smart lights |
| Network | Tailscale mesh (WireGuard) |

---

<details>
<summary><strong>Quick Start</strong></summary>

### Prerequisites

- Node.js ≥ 20
- MQTT broker (e.g., Mosquitto) on port 1883
- Git

### Install & configure

```bash
git clone https://github.com/zhonghaozhan/hearthnet.git
cd hearthnet
npm install

# HMAC signing secret (any string; must match across all agents)
export HEARTHNET_ROOT_SECRET=your-secret-here

# MQTT credentials
export MQTT_HOST=127.0.0.1
export MQTT_USER=your-user
export MQTT_PASS=your-password
```

### Run the demo

```bash
# Terminal 1 — start the librarian (must be up before scenes run)
npm run librarian

# Terminal 2 — run all three scenes interactively
npm run demo

# Or run scenes individually
npm run scene1   # Intent-Driven Coordination
npm run scene2   # Conflict Resolution
npm run scene3   # Freshness Verification

# Reset Git repo and run fresh
npm run demo:reset
```

### Launch the visualizer

```bash
npm run visualizer
# Open http://localhost:3456
```

### Collect metrics

```bash
node demo/run-metrics.js
```

</details>

<details>
<summary><strong>Project Structure</strong></summary>

```
hearthnet/
├── protocol/
│   ├── msg.js                # MQTT message construction + agent client factory
│   ├── lease.js              # Lease creation, validation, HMAC signing
│   └── message-schema.json   # Message envelope schema
├── librarian/
│   └── dewey-librarian.js    # Git-backed librarian: commit, validate, detect, enforce
├── demo/
│   ├── demo-common.js        # Shared helpers for demo scripts
│   ├── scene1-coordinated-actuation.js
│   ├── scene2-conflict-resolution.js
│   ├── scene3-freshness-verification.js
│   ├── run-all.sh            # Run all scenes interactively
│   └── run-metrics.js        # Batch metric collection (5 runs × 2 scenes)
├── visualizer/
│   ├── server.js             # Express + SSE server, fs.watch on Git repo
│   └── public/
│       ├── index.html
│       ├── style.css
│       ├── app.js            # Timeline, topology graph, replay controller
│       └── hearthnet-trace.json  # Pre-baked trace for static deployment
├── scripts/
│   └── test-lease.js         # Lease unit tests
├── package.json
└── README.md
```

</details>

---

## License

MIT — see [`LICENSE`](LICENSE).

## Citation

Coming soon — paper under review at ACM CAIS 2026.

## Contact

Built by [Zhonghao Zhan](https://x.com/paiqi_peccy) at Imperial College London.

Questions, collaborations, or ideas? Open an [issue](https://github.com/zhonghaozhan/hearthnet/issues) or reach out on [X](https://x.com/paiqi_peccy).
