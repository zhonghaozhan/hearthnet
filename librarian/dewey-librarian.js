#!/usr/bin/env node
/**
 * HearthNet Librarian Service (Dewey)
 * 
 * Subscribes to all MQTT traffic, records every event as a git commit,
 * detects conflicts (same device, incompatible states, short window),
 * verifies base_commit freshness, and validates actuation leases.
 * 
 * Runs on the NUC alongside Jeeves, as an independent process.
 * 
 * Environment:
 *   HEARTHNET_REPO       - Path to the ground-truth git repo (default: ./groundplane-state)
 *   MQTT_HOST             - Broker IP (default: 100.96.102.7)
 *   MQTT_PORT             - Broker port (default: 1883)
 *   MQTT_USER             - Broker username (default: dewey)
 *   MQTT_PASS             - Broker password (default: agentcomms2026)
 *   CONFLICT_WINDOW_MS    - Time window for conflict detection (default: 60000 = 60s)
 *   HEARTHNET_ROOT_SECRET - Shared HMAC key for lease verification
 */

const mqtt = require('mqtt');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateLease } = require('../protocol/lease');

// --- Config ---
const REPO_PATH = process.env.HEARTHNET_REPO || process.env.GROUNDPLANE_REPO || path.join(__dirname, '..', 'groundplane-state');
const MQTT_HOST = process.env.MQTT_HOST || '100.96.102.7';  // ISSUE 6: TODO hardcoded for demo, inject in production
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_USER = process.env.MQTT_USER || 'dewey';  // ISSUE 6: TODO hardcoded for demo, inject in production
const MQTT_PASS = process.env.MQTT_PASS || 'agentcomms2026';  // ISSUE 6: TODO hardcoded for demo, inject in production
const CONFLICT_WINDOW_MS = parseInt(process.env.CONFLICT_WINDOW_MS || '60000');

// Persistent state file paths
const CONSUMED_LEASES_FILE = path.join(REPO_PATH, 'consumed-leases.jsonl');
const CONFLICT_STATE_FILE = path.join(REPO_PATH, 'conflict-state.json');

// --- State ---
const recentCommands = {};
const seenMsgIds = new Set();
const SEEN_MAX = 500;
// Track active leases for audit trail
const activeLeases = new Map();
const LEASE_HISTORY_MAX = 200;
// ISSUE 1: Track consumed leases to prevent replay attacks
const consumedLeases = new Set();

// --- Git helpers ---
function git(cmd, opts = {}) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: REPO_PATH,
      encoding: 'utf8',
      timeout: 10000,
      ...opts,
    }).trim();
  } catch (e) {
    console.error(`[dewey] git error: ${e.message}`);
    return null;
  }
}

function getHEAD() {
  return git('rev-parse --short HEAD');
}

function getFullHEAD() {
  return git('rev-parse HEAD');
}

// --- Persistent state helpers (ISSUE 1, ISSUE 5) ---

function loadConsumedLeases() {
  if (!fs.existsSync(CONSUMED_LEASES_FILE)) return;
  try {
    const lines = fs.readFileSync(CONSUMED_LEASES_FILE, 'utf8').trim().split('\n').filter(l => l);
    lines.forEach(line => {
      const entry = JSON.parse(line);
      if (entry.lease_id) consumedLeases.add(entry.lease_id);
    });
    console.log(`[dewey] Loaded ${consumedLeases.size} consumed lease IDs from ${CONSUMED_LEASES_FILE}`);
  } catch (e) {
    console.error(`[dewey] Error loading consumed leases: ${e.message}`);
  }
}

function persistConsumedLease(lease_id, detail = '') {
  const entry = {
    lease_id,
    consumed_at: new Date().toISOString(),
    detail,
  };
  fs.appendFileSync(CONSUMED_LEASES_FILE, JSON.stringify(entry) + '\n');
  consumedLeases.add(lease_id);
}

function loadConflictState() {
  if (!fs.existsSync(CONFLICT_STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(CONFLICT_STATE_FILE, 'utf8'));
    const now = Date.now();
    
    // Restore recentCommands, pruning stale entries
    for (const [device, entries] of Object.entries(data)) {
      recentCommands[device] = entries.filter(e => (now - e.timestamp) < CONFLICT_WINDOW_MS);
    }
    
    const totalEntries = Object.values(recentCommands).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`[dewey] Loaded conflict state: ${totalEntries} recent commands across ${Object.keys(recentCommands).length} devices`);
  } catch (e) {
    console.error(`[dewey] Error loading conflict state: ${e.message}`);
  }
}

function persistConflictState() {
  try {
    fs.writeFileSync(CONFLICT_STATE_FILE, JSON.stringify(recentCommands, null, 2));
  } catch (e) {
    console.error(`[dewey] Error persisting conflict state: ${e.message}`);
  }
}

function initRepo() {
  if (!fs.existsSync(REPO_PATH)) {
    fs.mkdirSync(REPO_PATH, { recursive: true });
  }
  if (!fs.existsSync(path.join(REPO_PATH, '.git'))) {
    git('init');
    git('config user.name "Dewey (Librarian)"');
    git('config user.email "dewey@hearthnet.local"');

    const dirs = ['state', 'events', 'leases'];
    dirs.forEach(d => fs.mkdirSync(path.join(REPO_PATH, d), { recursive: true }));

    // Initial device state
    const initialState = {
      living_room_lights: { brightness: 50, color_temp: 'neutral', power: 'on' },
      speakers: { volume: 30, source: 'idle' },
      tv: { power: 'off', app: null },
      camera: { recording: true, mode: 'auto' },
      phone_dnd: { enabled: false },
      phone_focus_timer: { active: false, duration_min: 0 },
    };
    fs.writeFileSync(
      path.join(REPO_PATH, 'state', 'devices.json'),
      JSON.stringify(initialState, null, 2)
    );

    // Role-based policies
    const policies = {
      roles: {
        jeeves: {
          description: 'Home Assistant manager — lights, switches, climate, media',
          allowed_devices: ['living_room_lights', 'speakers', 'tv', 'camera', 'thermostat'],
          allowed_operations: ['set_state', 'get_state', 'toggle'],
          parameter_bounds: { brightness: [0, 100], volume: [0, 100], color_temp: null },
        },
        darcy: {
          description: 'Mobile app manager — UI automation, on-device sensors',
          allowed_devices: ['phone', 'phone_dnd', 'phone_focus_timer'],
          allowed_operations: ['ui_automation', 'app_launch', 'set_state', 'get_state'],
          parameter_bounds: {},
        },
      },
      modes: {
        work_from_home: {
          living_room_lights: { brightness: 100, color_temp: 'neutral' },
          speakers: { volume: 15, source: 'ambient' },
          phone_dnd: { enabled: true },
          phone_focus_timer: { active: true, duration_min: 60 },
        },
        evening_wind_down: {
          living_room_lights: { brightness: 20, color_temp: 'warm' },
          speakers: { volume: 30, source: 'relaxing' },
          phone_dnd: { enabled: false },
        },
      },
      active_mode: null,
      policy_version: '1.0.0',
    };
    fs.writeFileSync(
      path.join(REPO_PATH, 'state', 'policies.json'),
      JSON.stringify(policies, null, 2)
    );

    fs.writeFileSync(
      path.join(REPO_PATH, 'README.md'),
      '# HearthNet State\n\nCanonical ground truth maintained by Dewey (librarian agent).\nEvery change is a git commit with attribution.\n'
    );

    git('add -A');
    git('commit -m "Initial state: devices, policies, structure"');
    console.log(`[dewey] Initialized ground-truth repo at ${REPO_PATH}`);
  } else {
    console.log(`[dewey] Ground-truth repo exists at ${REPO_PATH} (HEAD: ${getHEAD()})`);
  }
  
  // Load persistent state on boot
  loadConsumedLeases();
  loadConflictState();
}

// --- Event logging ---
function logEvent(msg, extra = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const eventsDir = path.join(REPO_PATH, 'events');
  if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true });

  const logFile = path.join(eventsDir, `${date}.jsonl`);
  const entry = {
    logged_at: new Date().toISOString(),
    msg_id: msg.msg_id || crypto.randomUUID(),
    from: msg.from,
    to: msg.to,
    type: msg.type,
    content_preview: (msg.content || '').substring(0, 200),
    target_device: msg.target_device || null,
    desired_state: msg.desired_state || null,
    operation: msg.operation || null,
    base_commit: msg.base_commit || null,
    lease_id: (msg.lease && msg.lease.lease_id) || null,
    head_at_log: getHEAD(),
    ...extra,
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  return entry;
}

function commitEvent(msg, extraInfo = '') {
  logEvent(msg);
  const sanitized = sanitizeForShell((msg.content || '').substring(0, 80));
  const safeFrom = sanitizeForShell(msg.from);
  const safeTo = sanitizeForShell(msg.to);
  const safeType = sanitizeForShell(msg.type);
  const leaseTag = (msg.lease && msg.lease.lease_id && isValidCommitHash(msg.lease.lease_id.replace('lease-', '')))
    ? ` [${msg.lease.lease_id.slice(0, 18)}]`
    : '';
  const safeExtra = sanitizeForShell(extraInfo);
  const commitMsg = `[${safeType}] ${safeFrom} → ${safeTo}: ${sanitized}${leaseTag}${safeExtra ? ' | ' + safeExtra : ''}`;

  git('add -A');
  const author = `${safeFrom} <${safeFrom}@hearthnet.local>`;
  git(`commit --allow-empty -m "${commitMsg}" --author="${author}"`);

  const newHead = getHEAD();
  console.log(`[dewey] Committed: ${newHead} — ${commitMsg.substring(0, 120)}`);
  return newHead;
}

// --- Lease logging ---
function logLease(lease, action, detail = '') {
  const leasesDir = path.join(REPO_PATH, 'leases');
  if (!fs.existsSync(leasesDir)) fs.mkdirSync(leasesDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(leasesDir, `${date}.jsonl`);
  const entry = {
    logged_at: new Date().toISOString(),
    action, // 'issued', 'used', 'rejected', 'expired'
    lease_id: lease.lease_id,
    grantee: lease.grantee,
    target_device: lease.target_device,
    operation: lease.operation,
    base_commit: lease.base_commit,
    policy_commit: lease.policy_commit,
    expires_at: lease.expires_at,
    signature: lease.signature,  // ISSUE 7: include full signature for independent verification
    detail,
  };

  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

  // ISSUE 3: Auto-commit audit logs (crash-safe)
  git(`add leases/${date}.jsonl`);
  const safeAction = sanitizeForShell(action);
  const safeGrantee = sanitizeForShell(lease.grantee);
  const safeTarget = sanitizeForShell(lease.target_device);
  const safeLeaseSlice = sanitizeForShell(lease.lease_id.slice(0, 16));
  const commitMsg = `lease: ${safeAction} ${safeLeaseSlice} ${safeGrantee}→${safeTarget}`;
  git(`commit -m "${commitMsg}" --author="Dewey <dewey@hearthnet.local>"`);
  console.log(`[dewey] Lease audit committed: ${getHEAD()} — ${commitMsg}`);

  // Track in memory
  activeLeases.set(lease.lease_id, { lease, action, timestamp: Date.now() });
  if (activeLeases.size > LEASE_HISTORY_MAX) {
    const oldest = activeLeases.keys().next().value;
    activeLeases.delete(oldest);
  }
}

// --- Device state updates ---
function updateDeviceState(device, newState) {
  const stateFile = path.join(REPO_PATH, 'state', 'devices.json');
  let devices = {};
  try {
    devices = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    devices = {};
  }

  if (!devices[device]) devices[device] = {};
  Object.assign(devices[device], newState);

  fs.writeFileSync(stateFile, JSON.stringify(devices, null, 2));
  return devices;
}

function updateActiveMode(mode) {
  const policyFile = path.join(REPO_PATH, 'state', 'policies.json');
  let policies = {};
  try {
    policies = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  } catch (e) {
    policies = { roles: {}, modes: {}, active_mode: null };
  }
  policies.active_mode = mode;
  fs.writeFileSync(policyFile, JSON.stringify(policies, null, 2));
}

// --- Conflict detection ---
function checkConflict(msg) {
  if (!msg.target_device || !msg.desired_state) return null;

  const device = msg.target_device;
  const now = Date.now();

  if (recentCommands[device]) {
    recentCommands[device] = recentCommands[device].filter(
      e => (now - e.timestamp) < CONFLICT_WINDOW_MS
    );
  }

  if (recentCommands[device] && recentCommands[device].length > 0) {
    for (const prev of recentCommands[device]) {
      if (prev.msg.from === msg.from) continue;

      for (const key of Object.keys(msg.desired_state)) {
        if (prev.msg.desired_state && prev.msg.desired_state[key] !== undefined) {
          if (JSON.stringify(prev.msg.desired_state[key]) !== JSON.stringify(msg.desired_state[key])) {
            return {
              device,
              key,
              existing: { from: prev.msg.from, value: prev.msg.desired_state[key], msg_id: prev.msg.msg_id },
              incoming: { from: msg.from, value: msg.desired_state[key], msg_id: msg.msg_id },
            };
          }
        }
      }
    }
  }

  if (!recentCommands[device]) recentCommands[device] = [];
  recentCommands[device].push({ msg, timestamp: now });

  // ISSUE 5: Persist conflict window state (crash-safe)
  persistConflictState();

  return null;
}

// --- Input sanitization ---
const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/;

function isValidCommitHash(hash) {
  return typeof hash === 'string' && COMMIT_HASH_RE.test(hash);
}

function sanitizeForShell(str) {
  // Remove all shell metacharacters — only allow safe printable ASCII
  return (str || '').replace(/[^a-zA-Z0-9 _.,:;!?@#%+=\-/()[\]{}]/g, '');
}

// --- Base commit verification ---
function checkBaseCommit(msg) {
  if (!msg.base_commit) return { valid: true, reason: 'no base_commit provided' };

  // Validate format before passing to git commands (prevent injection)
  if (!isValidCommitHash(msg.base_commit)) {
    return { valid: false, reason: `base_commit '${sanitizeForShell(msg.base_commit)}' is not a valid hex hash` };
  }

  const head = getHEAD();
  if (!head) return { valid: false, reason: 'could not determine HEAD' };

  try {
    execSync(`git merge-base --is-ancestor ${msg.base_commit} HEAD`, {
      cwd: REPO_PATH,
      timeout: 5000,
    });
  } catch (e) {
    return {
      valid: false,
      reason: `base_commit ${msg.base_commit} is not an ancestor of HEAD ${head}`,
      head,
      base: msg.base_commit,
    };
  }

  try {
    const distance = execSync(
      `git rev-list --count ${msg.base_commit}..HEAD`,
      { cwd: REPO_PATH, encoding: 'utf8', timeout: 5000 }
    ).trim();

    const commitsBehind = parseInt(distance);
    if (commitsBehind > 10) {
      return {
        valid: false,
        reason: `base_commit ${msg.base_commit} is ${commitsBehind} commits behind HEAD ${head} — stale state`,
        head,
        base: msg.base_commit,
        commits_behind: commitsBehind,
      };
    }

    return { valid: true, commits_behind: commitsBehind, head };
  } catch (e) {
    return { valid: true, reason: 'distance check failed, allowing' };
  }
}

// --- Lease verification for execute messages ---
function verifyExecuteLease(msg) {
  if (!msg.lease) {
    return { valid: false, reason: 'execute message has no lease — actuation requires root authorization' };
  }

  // ISSUE 1: Check for replay attacks (consumed lease IDs)
  if (consumedLeases.has(msg.lease.lease_id)) {
    const result = { valid: false, reason: `lease ${msg.lease.lease_id} already consumed (replay attack detected)` };
    logLease(msg.lease, 'rejected', result.reason);
    return result;
  }

  // Validate lease signature, expiration, grantee, target, operation, params.
  // NOTE: Do NOT pass current_head here — strict equality would always fail
  // because Dewey's own commits advance HEAD between lease issuance and
  // execute arrival. The message-level checkBaseCommit() already handles
  // freshness with git-ancestor tolerance. The lease's base_commit is
  // integrity-protected by the HMAC signature.
  const result = validateLease(msg.lease, {
    agent_id: msg.from,
    target_device: msg.target_device,
    operation: msg.operation,
    desired_state: msg.desired_state,
  });

  // Separate lease commit freshness check using git ancestry (same tolerance
  // as checkBaseCommit) — catches leases bound to very old state.
  if (result.valid && msg.lease.base_commit) {
    const leaseCommitCheck = checkBaseCommit({ base_commit: msg.lease.base_commit });
    if (!leaseCommitCheck.valid) {
      const reason = `lease bound to stale commit: ${leaseCommitCheck.reason}`;
      logLease(msg.lease, 'rejected', reason);
      return { valid: false, reason };
    }
  }

  // Log the lease check
  logLease(msg.lease, result.valid ? 'used' : 'rejected', result.reason || 'valid');

  // ISSUE 1: Mark lease as consumed if valid
  if (result.valid) {
    persistConsumedLease(msg.lease.lease_id, `used by ${msg.from} for ${msg.target_device}`);
  }

  return result;
}

// --- MQTT helpers ---
let mqttClient = null;

function publish(topic, msg) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, JSON.stringify(msg), { qos: 1 });
  }
}

function sendConflictAlert(conflict, originalMsg) {
  const alertContent = `CONFLICT on ${conflict.device}.${conflict.key}: ` +
    `${conflict.existing.from} set ${JSON.stringify(conflict.existing.value)}, ` +
    `${conflict.incoming.from} wants ${JSON.stringify(conflict.incoming.value)}. ` +
    `Escalating to root for arbitration.`;

  const alertMsg = {
    msg_id: crypto.randomUUID(),
    from: 'dewey',
    to: 'rupert',
    type: 'conflict',
    content: alertContent,
    timestamp: new Date().toISOString(),
    target_device: conflict.device,
    conflict_detail: conflict,
  };

  publish('agents/inbox/rupert', alertMsg);
  publish('agents/mirror', alertMsg);
  console.log(`[dewey] CONFLICT ALERT: ${alertContent.substring(0, 120)}`);
  return alertMsg;
}

function sendRejection(msg, reason) {
  const rejMsg = {
    msg_id: crypto.randomUUID(),
    from: 'dewey',
    to: msg.from,
    type: 'rejection',
    content: `REJECTED: ${reason}`,
    timestamp: new Date().toISOString(),
    parent_msg_id: msg.msg_id,
    ...(msg.lease && { rejected_lease_id: msg.lease.lease_id }),
  };

  publish(`agents/inbox/${msg.from}`, rejMsg);
  publish('agents/inbox/rupert', rejMsg); // Always notify root of rejections
  publish('agents/mirror', rejMsg);
  console.log(`[dewey] REJECTED ${msg.from}: ${reason.substring(0, 120)}`);
  return rejMsg;
}

// --- Main message handler ---
function handleMessage(topic, rawMessage) {
  let msg;
  try {
    msg = JSON.parse(rawMessage.toString());
  } catch (e) {
    console.error(`[dewey] Parse error on ${topic}:`, e.message);
    return;
  }

  // Skip own messages
  if (msg.from === 'dewey') return;
  // Skip acks
  if (msg.type === 'ack') return;
  // Deduplicate
  const msgId = msg.msg_id;
  if (msgId && seenMsgIds.has(msgId)) return;
  if (msgId) {
    seenMsgIds.add(msgId);
    if (seenMsgIds.size > SEEN_MAX) {
      const first = seenMsgIds.values().next().value;
      seenMsgIds.delete(first);
    }
  }

  console.log(`[dewey] ← [${topic}] ${msg.from} → ${msg.to} (${msg.type}): ${(msg.content || '').substring(0, 80)}`);

  // --- Verification pipeline ---

  // 1. Base commit freshness (for task/lease_request/execute messages)
  //    Execute messages MUST carry base_commit (paper Section 2.3).
  //    Tasks are allowed without it (root may omit for initial dispatch).
  if (msg.type === 'execute' && !msg.base_commit) {
    commitEvent(msg, 'REJECTED: execute message missing base_commit');
    sendRejection(msg, 'execute messages must include base_commit for freshness verification');
    return;
  }
  if ((msg.type === 'task' || msg.type === 'lease_request' || msg.type === 'execute') && msg.base_commit) {
    const commitCheck = checkBaseCommit(msg);
    if (!commitCheck.valid) {
      commitEvent(msg, `STALE: ${commitCheck.reason}`);
      sendRejection(msg, commitCheck.reason);
      return;
    }
  }

  // 2. Lease verification (for execute messages — the critical gate)
  if (msg.type === 'execute') {
    const leaseCheck = verifyExecuteLease(msg);
    if (!leaseCheck.valid) {
      commitEvent(msg, `LEASE_REJECTED: ${leaseCheck.reason}`);
      sendRejection(msg, `Lease validation failed: ${leaseCheck.reason}`);
      return;
    }
    console.log(`[dewey] ✓ Lease ${msg.lease.lease_id.slice(0, 18)} valid for ${msg.from} → ${msg.target_device}`);
  }

  // 3. Conflict detection (for tasks/lease requests/executes with device targets)
  if ((msg.type === 'task' || msg.type === 'lease_request' || msg.type === 'execute') && msg.target_device && msg.desired_state) {
    const conflict = checkConflict(msg);
    if (conflict) {
      commitEvent(msg, `CONFLICT: ${conflict.device}.${conflict.key}`);
      sendConflictAlert(conflict, msg);
    }
  }

  // 4. Update device state on confirmed execution — only if the lease was actually used
  if (msg.type === 'execute_result' && msg.target_device && msg.desired_state) {
    const leaseId = msg.lease && msg.lease.lease_id;
    if (!leaseId || !consumedLeases.has(leaseId)) {
      console.log(`[dewey] WARN: execute_result from ${sanitizeForShell(msg.from)} references unknown/unconsumed lease ${sanitizeForShell(leaseId || 'none')} — device state NOT updated`);
      // Still log the event but don't update ground truth
    } else {
      updateDeviceState(msg.target_device, msg.desired_state);
    }
  }

  // 5. Track lease grants from root
  if (msg.type === 'lease_grant' && msg.lease) {
    logLease(msg.lease, 'issued', `granted to ${msg.lease.grantee} for ${msg.lease.target_device}`);
  }

  // 6. Update active mode on resolution
  if (msg.type === 'resolution' && msg.content) {
    const modeMatch = msg.content.match(/mode:\s*(\w+)/i);
    if (modeMatch) updateActiveMode(modeMatch[1].toLowerCase());
  }

  // 7. Log and commit everything
  commitEvent(msg);
}

// --- Main ---
function main() {
  console.log('[dewey] HearthNet Librarian starting...');
  initRepo();

  mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: `dewey-librarian-${Date.now()}`,
    reconnectPeriod: 5000,
    will: {
      topic: 'agents/status/dewey',
      payload: JSON.stringify({ status: 'offline', role: 'librarian', timestamp: new Date().toISOString() }),
      qos: 1,
      retain: true,
    },
  });

  mqttClient.on('connect', () => {
    console.log(`[dewey] Connected to MQTT broker ${MQTT_HOST}:${MQTT_PORT}`);

    mqttClient.subscribe('agents/mirror', { qos: 1 });
    mqttClient.subscribe('agents/broadcast', { qos: 1 });
    mqttClient.subscribe('agents/inbox/dewey', { qos: 1 });
    mqttClient.subscribe('agents/inbox/+', { qos: 1 });

    mqttClient.publish('agents/status/dewey', JSON.stringify({
      status: 'online',
      role: 'librarian',
      head: getHEAD(),
      timestamp: new Date().toISOString(),
    }), { qos: 1, retain: true });

    console.log(`[dewey] Librarian online. HEAD: ${getHEAD()}. Watching all channels.`);
  });

  mqttClient.on('message', handleMessage);

  mqttClient.on('error', (err) => console.error(`[dewey] MQTT error:`, err.message));
  mqttClient.on('offline', () => console.log('[dewey] MQTT offline, reconnecting...'));

  function shutdown() {
    console.log('[dewey] Shutting down...');
    mqttClient.publish('agents/status/dewey', JSON.stringify({
      status: 'offline',
      role: 'librarian',
      timestamp: new Date().toISOString(),
    }), { qos: 1, retain: true });
    setTimeout(() => { mqttClient.end(); process.exit(0); }, 500);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
