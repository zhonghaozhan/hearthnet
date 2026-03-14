/**
 * HearthNet Live Visualizer — Client
 *
 * Two modes:
 *   Live Monitor — shows only SSE events arriving since page load
 *   Replay — shows all historical commits with scene filtering + transport controls
 */

const timeline = document.getElementById('timeline');
const headBadge = document.getElementById('head-value');
const commitCountEl = document.getElementById('commit-count');
const liveDot = document.getElementById('live-dot');
const detailPanel = document.getElementById('detail-panel');
const sceneTabs = document.getElementById('scene-tabs');
const btnScrollBottom = document.getElementById('btn-scroll-bottom');
const modeTabs = document.getElementById('mode-tabs');
const liveToolbar = document.getElementById('live-toolbar');
const replayBar = document.getElementById('replay-bar');

let allCommits = [];    // Full history from /api/commits (for replay)
let liveCommits = [];   // Only commits arriving via SSE since page load
let currentMode = 'replay'; // 'live' or 'replay'
let activeScene = 'all';
let autoScroll = true;

/* ───────────────────────────────────────
   Agent Metadata
   ─────────────────────────────────────── */
const AGENTS = {
  user:   { label: 'User',   short: 'U',  role: 'Human' },
  rupert: { label: 'Rupert', short: 'R',  role: 'Root Agent' },
  jeeves: { label: 'Jeeves', short: 'J',  role: 'HA Manager' },
  darcy:  { label: 'Darcy',  short: 'D',  role: 'Mobile Manager' },
  dewey:  { label: 'Dewey',  short: 'Dw', role: 'Librarian' },
  system: { label: 'System', short: 'S',  role: 'Internal' },
};

/* ───────────────────────────────────────
   Scene Detection — order-based
   ─────────────────────────────────────── */

// Scene trigger keywords — these mark the START of a scene.
// Once triggered, all subsequent commits belong to that scene
// until a new scene trigger is found.
function isSceneTrigger(subject) {
  const s = subject.toLowerCase();

  // Scene 1 triggers: first user intent that starts the coordination
  if (s.includes('set up movie mode') || s.includes('get the room ready') ||
      s.includes('work from home') || s.includes('wfh') ||
      s.includes('working from home')) {
    return 'scene1';
  }

  // Scene 2 triggers: conflict / scheduled routine clash
  if (s.includes('evening wind-down') || s.includes('morning routine') ||
      s.includes('scheduled') && s.includes('conflict')) {
    return 'scene2';
  }

  // Scene 3 triggers: crash recovery / stale state
  if (s.includes('crash recovery') || s.includes('post-crash') ||
      s.includes('freshness') || (s.includes('stale') && s.includes('commit'))) {
    return 'scene3';
  }

  return null;
}

// Build a hash→scene map from the ordered commit list.
// "Initial state" and anything before the first trigger get null.
// Once a scene trigger fires, all subsequent commits inherit that scene.
const sceneMap = new Map();

function buildSceneMap(commits) {
  sceneMap.clear();
  let currentScene = null;

  for (const commit of commits) {
    const trigger = isSceneTrigger(commit.subject);
    if (trigger) {
      currentScene = trigger;
    }
    // First commit (initial state) stays null
    if (currentScene) {
      sceneMap.set(commit.hash, currentScene);
    }
  }
}

function detectScene(commit) {
  return sceneMap.get(commit.hash) || null;
}

/* ───────────────────────────────────────
   Subject Parsing
   ─────────────────────────────────────── */
function parseSubject(subject) {
  const match = subject.match(/^\[(\w+)\]\s+(.+?)\s*→\s*(.+?):\s*(.*)/);
  if (match) {
    const [, type, from, to, content] = match;
    return { type, from: from.trim(), to: to.trim(), content, raw: subject };
  }
  const leaseMatch = subject.match(/^lease:\s+(\w+)\s+(.*)/);
  if (leaseMatch) {
    return { type: 'lease', from: 'dewey', to: '', content: leaseMatch[2], raw: subject };
  }
  return { type: 'event', from: '', to: '', content: subject, raw: subject };
}

/* ───────────────────────────────────────
   Rendering
   ─────────────────────────────────────── */
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCommit(commit, isNew = false) {
  const parsed = parseSubject(commit.subject);
  const scene = detectScene(commit);

  const node = document.createElement('div');
  node.className = 'commit-node' + (isNew ? ' new-commit' : '');
  node.dataset.hash = commit.hash;
  node.dataset.agent = commit.agent;
  node.dataset.type = parsed.type;
  if (scene) node.dataset.scene = scene;

  // Scene filtering (replay mode only) — hide anything that doesn't match
  if (currentMode === 'replay' && activeScene !== 'all' && scene !== activeScene) {
    node.style.display = 'none';
  }

  let flowHtml = '';
  if (parsed.from && parsed.to) {
    flowHtml = `
      <span class="commit-author" data-agent="${commit.agent}">${parsed.from}</span>
      <span class="commit-arrow">&rarr;</span>
      <span class="commit-target">${parsed.to}</span>
    `;
  } else {
    flowHtml = `<span class="commit-author" data-agent="${commit.agent}">${commit.agent}</span>`;
  }

  node.innerHTML = `
    <div class="commit-dot" data-agent="${commit.agent}"></div>
    <div class="commit-body">
      <div class="commit-meta">
        <span class="commit-hash">${commit.short}</span>
        ${flowHtml}
        <span class="type-badge ${parsed.type}">${formatTypeBadge(parsed.type)}</span>
        <span class="commit-time">${formatTime(commit.timestamp)}</span>
      </div>
      <div class="commit-subject">${escapeHtml(parsed.content || commit.subject)}</div>
    </div>
  `;

  node.addEventListener('click', () => selectCommit(commit, node));
  return node;
}

function formatTypeBadge(type) {
  const labels = {
    task: 'task', response: 'response', execute: 'execute',
    execute_result: 'result', resolution: 'resolution', conflict: 'conflict',
    rejection: 'rejected', lease: 'lease', lease_request: 'lease req',
    lease_grant: 'granted', lease_denied: 'denied', event: 'event',
  };
  return labels[type] || type;
}

function renderCommitList(commits) {
  timeline.innerHTML = '';
  let lastScene = null;

  for (const commit of commits) {
    const scene = detectScene(commit);

    if (scene && scene !== lastScene && activeScene === 'all') {
      const sep = document.createElement('div');
      sep.className = 'scene-separator';
      const labels = {
        scene1: 'Scene 1 \u2014 Coordinated Actuation',
        scene2: 'Scene 2 \u2014 Conflict Resolution',
        scene3: 'Scene 3 \u2014 Freshness Verification',
      };
      sep.innerHTML = `
        <span class="scene-separator-label">${labels[scene] || scene}</span>
        <span class="scene-separator-line"></span>
      `;
      timeline.appendChild(sep);
      lastScene = scene;
    }

    timeline.appendChild(renderCommit(commit));
  }

  scrollToBottom();
}

function updateStatus() {
  const count = currentMode === 'live' ? liveCommits.length : allCommits.length;
  commitCountEl.textContent = count;
  const source = currentMode === 'live' ? liveCommits : allCommits;
  if (source.length > 0) {
    headBadge.textContent = source[source.length - 1].short;
  }
}

function scrollToBottom() {
  if (autoScroll) {
    timeline.scrollTop = timeline.scrollHeight;
  }
}

timeline.addEventListener('scroll', () => {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60;
  autoScroll = atBottom;
});

btnScrollBottom.addEventListener('click', () => {
  autoScroll = true;
  timeline.scrollTop = timeline.scrollHeight;
});

/* ───────────────────────────────────────
   Mode Switching
   ─────────────────────────────────────── */
function switchMode(mode, force = false) {
  if (mode === currentMode && !force) return;
  currentMode = mode;

  // Stop replay playback if leaving replay
  if (mode === 'live') {
    replayPlaying = false;
    clearTimeout(replayTimer);
  }

  // Update tab visuals
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.mode-tab[data-mode="${mode}"]`).classList.add('active');

  // Toggle toolbar sections
  liveToolbar.style.display = mode === 'live' ? 'flex' : 'none';
  sceneTabs.style.display = mode === 'replay' ? 'flex' : 'none';
  replayBar.style.display = mode === 'replay' ? 'flex' : 'none';

  // Clear topo
  topoEdges.innerHTML = '';

  // Clear detail panel
  detailPanel.innerHTML = '<div class="detail-empty"><p>Select an event to inspect</p></div>';

  if (mode === 'live') {
    renderLive();
  } else {
    enterReplay();
  }

  updateStatus();
}

function renderLive() {
  if (liveCommits.length === 0) {
    timeline.innerHTML = `
      <div class="timeline-empty">
        <span class="live-mode-dot" style="width:10px;height:10px;display:inline-block;border-radius:50%;background:var(--brand);animation:live-pulse 3s ease-in-out infinite;margin-bottom:4px"></span>
        <span>Waiting for live events&hellip;</span>
        <span style="color:var(--text-muted);font-size:11px">New commits will appear here in real time</span>
      </div>
    `;
  } else {
    renderCommitList(liveCommits);
  }
}

modeTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.mode-tab');
  if (!tab) return;
  switchMode(tab.dataset.mode);
});

/* ───────────────────────────────────────
   Agent Pip Highlighting
   ─────────────────────────────────────── */
function flashAgentChip(agent) {
  const chip = document.querySelector(`.agent-chip[data-agent="${agent}"]`);
  if (!chip) return;
  chip.classList.add('active');
  setTimeout(() => chip.classList.remove('active'), 1500);
}

/* ───────────────────────────────────────
   Detail Panel
   ─────────────────────────────────────── */
async function selectCommit(commit, node) {
  document.querySelectorAll('.commit-node.selected').forEach(n => n.classList.remove('selected'));
  node.classList.add('selected');

  const parsed = parseSubject(commit.subject);
  const agentInfo = AGENTS[commit.agent] || AGENTS.system;
  const agentColor = `var(--agent-${commit.agent})`;

  let diffData = { diff: '', body: '' };
  try {
    const res = await fetch(`/api/diff?hash=${commit.hash}`);
    diffData = await res.json();
  } catch (e) { /* ok */ }

  let flowHtml = '';
  if (parsed.from && parsed.to) {
    flowHtml = `
      <div class="detail-flow">
        <span class="flow-agent" style="color:${agentColor}">${parsed.from}</span>
        <span class="flow-arrow">&rarr;</span>
        <span class="flow-agent">${parsed.to}</span>
        <span class="type-badge ${parsed.type} flow-type-badge">${formatTypeBadge(parsed.type)}</span>
      </div>
    `;
  }

  const ts = new Date(commit.timestamp);
  const timeStr = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  detailPanel.innerHTML = `
    <div class="detail-content">
      ${flowHtml || `
        <div class="detail-header">
          <div class="detail-agent-dot" style="background:${agentColor}">${agentInfo.short}</div>
          <div class="detail-header-text">
            <h3>${agentInfo.label}</h3>
            <span class="detail-subtitle">${agentInfo.role}</span>
          </div>
          <span class="type-badge ${parsed.type}" style="margin-left:auto">${formatTypeBadge(parsed.type)}</span>
        </div>
      `}
      <div class="detail-meta-row">
        <span class="meta-item"><span class="meta-label">hash</span> <span class="meta-value">${commit.short}</span></span>
        <span class="meta-item"><span class="meta-label">time</span> <span class="meta-value">${timeStr}</span></span>
        <span class="meta-item"><span class="meta-label">by</span> <span class="meta-value">${escapeHtml(commit.author)}</span></span>
      </div>
      <div class="detail-section">
        <div class="detail-field">
          <label>Message</label>
          <div class="value">${escapeHtml(commit.subject)}</div>
        </div>
      </div>
      ${diffData.body ? `
      <div class="detail-section">
        <div class="detail-section-title">Body</div>
        <div class="detail-field"><div class="value mono">${escapeHtml(diffData.body)}</div></div>
      </div>` : ''}
      ${diffData.diff ? `
      <div class="detail-section">
        <div class="detail-section-title">Changed Files</div>
        <div class="detail-field"><div class="value mono">${escapeHtml(diffData.diff)}</div></div>
      </div>` : ''}
    </div>
  `;
}

/* ───────────────────────────────────────
   Scene Tab Filtering (replay only)
   ─────────────────────────────────────── */
sceneTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.scene-tab');
  if (!tab) return;

  document.querySelectorAll('.scene-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  activeScene = tab.dataset.scene;

  // Re-render replay at current position
  if (replayStepMode) {
    replayTo(replayIndex);
  } else {
    renderCommitList(allCommits);
  }
});

/* ───────────────────────────────────────
   SSE Live Updates
   ─────────────────────────────────────── */
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('commit', (e) => {
    const commit = JSON.parse(e.data);

    // Always store in allCommits for replay
    allCommits.push(commit);
    buildSceneMap(allCommits);

    // Always store in liveCommits
    liveCommits.push(commit);

    // Only render to timeline if in live mode
    if (currentMode === 'live') {
      // If this is the first live commit, clear the empty state
      if (liveCommits.length === 1) {
        timeline.innerHTML = '';
      }
      const node = renderCommit(commit, true);
      timeline.appendChild(node);
      scrollToBottom();
    }

    // Update replay slider max if in replay and showing all
    if (currentMode === 'replay' && !replayStepMode) {
      // Silently update, don't re-render
    }

    updateStatus();
    flashAgentChip(commit.agent);

    // Topo graph — animate in live mode only
    if (currentMode === 'live') topoForCommit(commit);

    // Pulse live dot
    const core = liveDot.querySelector('.live-core');
    const ring = liveDot.querySelector('.live-ring');
    const c = `var(--agent-${commit.agent})`;
    core.style.background = c;
    ring.style.borderColor = c;
    setTimeout(() => {
      core.style.background = 'var(--brand)';
      ring.style.borderColor = 'var(--brand)';
    }, 1200);
  });

  es.addEventListener('head', (e) => {
    const data = JSON.parse(e.data);
    if (currentMode === 'live') {
      headBadge.textContent = data.hash?.slice(0, 8) || '...';
    }
  });

  es.onerror = () => {
    const core = liveDot.querySelector('.live-core');
    const ring = liveDot.querySelector('.live-ring');
    core.style.background = 'var(--type-conflict)';
    ring.style.borderColor = 'var(--type-conflict)';
    es.close();
    setTimeout(() => connectSSE(), 3000);
  };
}

/* ───────────────────────────────────────
   Topology Graph
   ─────────────────────────────────────── */
const topoEdges = document.getElementById('topo-edges');

const TOPO_POS = {
  user:   { x: 130, y: 40 },
  rupert: { x: 130, y: 130 },
  jeeves: { x: 50,  y: 230 },
  darcy:  { x: 210, y: 230 },
  dewey:  { x: 130, y: 310 },
};

function resolveTopoAgent(name) {
  const n = (name || '').toLowerCase().trim();
  if (n.includes('user')) return 'user';
  if (n.includes('rupert') || n === 'root') return 'rupert';
  if (n.includes('jeeves')) return 'jeeves';
  if (n.includes('darcy')) return 'darcy';
  if (n.includes('dewey') || n.includes('librarian')) return 'dewey';
  if (n.includes('broadcast')) return null;
  return null;
}

function agentColor(agent) {
  const colors = {
    user: '#c8884a', rupert: '#5b8fbf', jeeves: '#5ea87a',
    darcy: '#bf6878', dewey: '#9578b5',
  };
  return colors[agent] || '#666';
}

let edgeCounter = 0;
const MAX_VISIBLE_EDGES = 6;

function drawTopoEdge(fromAgent, toAgent, type) {
  const from = TOPO_POS[fromAgent];
  const to = TOPO_POS[toAgent];
  if (!from || !to) return;

  edgeCounter++;
  const id = `edge-${edgeCounter}`;
  const color = agentColor(fromAgent);

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const offset = Math.min(len * 0.2, 30);
  const cx = mx + (-dy / len) * offset;
  const cy = my + (dx / len) * offset;

  const r1 = fromAgent === 'rupert' ? 22 : 18;
  const r2 = toAgent === 'rupert' ? 22 : 18;
  const angle1 = Math.atan2(cy - from.y, cx - from.x);
  const angle2 = Math.atan2(to.y - cy, to.x - cx);
  const sx = from.x + Math.cos(angle1) * r1;
  const sy = from.y + Math.sin(angle1) * r1;
  const ex = to.x - Math.cos(angle2) * r2;
  const ey = to.y - Math.sin(angle2) * r2;

  const arrowSize = 6;
  const aAngle = Math.atan2(to.y - cy, to.x - cx);
  const ax1 = ex - arrowSize * Math.cos(aAngle - 0.4);
  const ay1 = ey - arrowSize * Math.sin(aAngle - 0.4);
  const ax2 = ex - arrowSize * Math.cos(aAngle + 0.4);
  const ay2 = ey - arrowSize * Math.sin(aAngle + 0.4);

  const pathD = `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
  const pathLen = len;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.id = id;

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-dasharray', pathLen);
  path.setAttribute('stroke-dashoffset', pathLen);
  path.classList.add('topo-edge');
  g.appendChild(path);

  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  arrow.setAttribute('points', `${ex},${ey} ${ax1},${ay1} ${ax2},${ay2}`);
  arrow.setAttribute('fill', color);
  arrow.setAttribute('opacity', '0');
  arrow.classList.add('topo-edge');
  g.appendChild(arrow);

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', cx);
  label.setAttribute('y', cy - 6);
  label.setAttribute('text-anchor', 'middle');
  label.classList.add('topo-label');
  label.textContent = type;
  g.appendChild(label);

  topoEdges.appendChild(g);

  const srcCircle = document.getElementById(`topo-${fromAgent}`);
  if (srcCircle) {
    srcCircle.classList.remove('topo-agent-active');
    void srcCircle.offsetWidth;
    srcCircle.classList.add('topo-agent-active');
  }

  setTimeout(() => {
    path.classList.add('topo-edge-fade');
    arrow.classList.add('topo-edge-fade');
    label.classList.add('topo-label-fade');
  }, 2500);

  setTimeout(() => g.remove(), 4200);

  while (topoEdges.children.length > MAX_VISIBLE_EDGES) {
    topoEdges.firstChild.remove();
  }
}

function topoForCommit(commit) {
  const parsed = parseSubject(commit.subject);
  const fromAgent = resolveTopoAgent(parsed.from) || commit.agent;
  const toAgent = resolveTopoAgent(parsed.to);

  if (parsed.to === 'broadcast') {
    for (const target of ['rupert', 'jeeves', 'darcy', 'dewey']) {
      if (target !== fromAgent) {
        setTimeout(() => drawTopoEdge(fromAgent, target, parsed.type), Math.random() * 200);
      }
    }
  } else if (toAgent && fromAgent !== toAgent) {
    drawTopoEdge(fromAgent, toAgent, parsed.type);
  }
}

/* ───────────────────────────────────────
   Replay Controller
   ─────────────────────────────────────── */
const replaySlider = document.getElementById('replay-slider');
const replayCounter = document.getElementById('replay-counter');
const replayToggle = document.getElementById('replay-toggle');
const replaySpeedSelect = document.getElementById('replay-speed');

let replayPlaying = false;
let replayStepMode = false; // true when using transport controls (step-by-step)
let replayIndex = 0;
let replayTimer = null;

function updateSliderFill() {
  const max = parseInt(replaySlider.max) || 1;
  const val = parseInt(replaySlider.value) || 0;
  const pct = (val / max) * 100;
  replaySlider.style.setProperty('--progress', pct + '%');
}

function enterReplay() {
  replayStepMode = false;
  replayIndex = allCommits.length - 1;
  replayPlaying = false;

  replaySlider.max = Math.max(0, allCommits.length - 1);
  replaySlider.value = replayIndex;
  updateSliderFill();
  replayToggle.textContent = '▶';
  replayToggle.classList.remove('playing');

  // Show full commit list
  renderCommitList(allCommits);
  updateReplayCounter();
}

function replayTo(index) {
  replayStepMode = true;
  replayIndex = Math.max(0, Math.min(index, allCommits.length - 1));
  replaySlider.value = replayIndex;
  updateSliderFill();

  timeline.innerHTML = '';
  let lastScene = null;

  for (let i = 0; i <= replayIndex; i++) {
    const commit = allCommits[i];
    const scene = detectScene(commit);

    if (scene && scene !== lastScene && activeScene === 'all') {
      const sep = document.createElement('div');
      sep.className = 'scene-separator';
      const labels = {
        scene1: 'Scene 1 \u2014 Coordinated Actuation',
        scene2: 'Scene 2 \u2014 Conflict Resolution',
        scene3: 'Scene 3 \u2014 Freshness Verification',
      };
      sep.innerHTML = `<span class="scene-separator-label">${labels[scene] || scene}</span><span class="scene-separator-line"></span>`;
      timeline.appendChild(sep);
      lastScene = scene;
    }

    const isLatest = (i === replayIndex);
    timeline.appendChild(renderCommit(commit, isLatest));
  }

  // Topo edge for current commit
  topoEdges.innerHTML = '';
  if (allCommits[replayIndex]) {
    topoForCommit(allCommits[replayIndex]);
    flashAgentChip(allCommits[replayIndex].agent);
  }

  updateReplayCounter();
  timeline.scrollTop = timeline.scrollHeight;
}

function updateReplayCounter() {
  const total = allCommits.length;
  const current = replayStepMode ? replayIndex + 1 : total;
  replayCounter.textContent = `${current} / ${total}`;
}

function replayStep() {
  if (replayIndex < allCommits.length - 1) {
    replayTo(replayIndex + 1);
  } else {
    replayPlaying = false;
    clearTimeout(replayTimer);
    replayToggle.textContent = '▶';
    replayToggle.classList.remove('playing');
  }
}

function scheduleNextStep() {
  if (!replayPlaying || replayIndex >= allCommits.length - 1) {
    replayPlaying = false;
    clearTimeout(replayTimer);
    replayToggle.textContent = '▶';
    replayToggle.classList.remove('playing');
    return;
  }

  const speedMultiplier = parseInt(replaySpeedSelect.value);
  const current = allCommits[replayIndex];
  const next = allCommits[replayIndex + 1];

  let realGapMs = next.timestamp - current.timestamp;
  realGapMs = Math.max(realGapMs, 200);
  realGapMs = Math.min(realGapMs, 5000);

  const scaledDelay = (realGapMs * speedMultiplier) / 1000;

  replayTimer = setTimeout(() => {
    replayStep();
    scheduleNextStep();
  }, scaledDelay);
}

function toggleReplayPlay() {
  if (replayPlaying) {
    replayPlaying = false;
    clearTimeout(replayTimer);
    replayToggle.textContent = '▶';
    replayToggle.classList.remove('playing');
  } else {
    if (!replayStepMode || replayIndex >= allCommits.length - 1) {
      replayTo(0);
    }
    replayPlaying = true;
    replayToggle.textContent = '⏸';
    replayToggle.classList.add('playing');
    scheduleNextStep();
  }
}

// Replay event listeners
document.getElementById('replay-reset').addEventListener('click', () => replayTo(0));
document.getElementById('replay-prev').addEventListener('click', () => replayTo(replayIndex - 1));
document.getElementById('replay-next').addEventListener('click', () => replayTo(replayIndex + 1));
document.getElementById('replay-end').addEventListener('click', () => replayTo(allCommits.length - 1));
replayToggle.addEventListener('click', toggleReplayPlay);
replaySlider.addEventListener('input', (e) => {
  replayTo(parseInt(e.target.value));
  updateSliderFill();
});
replaySpeedSelect.addEventListener('change', () => {
  if (replayPlaying) {
    clearTimeout(replayTimer);
    scheduleNextStep();
  }
});

/* ───────────────────────────────────────
   Init
   ─────────────────────────────────────── */
async function init() {
  // Fetch full history for replay
  try {
    const res = await fetch('/api/commits');
    allCommits = await res.json();
  } catch (e) {
    allCommits = [];
  }

  // Build scene map from ordered commits
  buildSceneMap(allCommits);

  // Start in replay mode — show full history (force: skip same-mode guard)
  switchMode('replay', true);
  connectSSE();
}

init();
