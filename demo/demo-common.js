/**
 * HearthNet Demo — Shared utilities
 * 
 * MQTT connection + message helpers + lease integration used by all demo scenes.
 */

const mqtt = require('mqtt');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const {
  createLease,
  validateLease,
  checkPolicy,
  checkEnvelopeWithinBounds,
} = require('../protocol/lease');

const MQTT_HOST = process.env.MQTT_HOST || '100.96.102.7';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
const MQTT_USER = process.env.MQTT_USER || 'rupert';
const MQTT_PASS = process.env.MQTT_PASS || 'agentcomms2026';
const REPO_PATH = process.env.HEARTHNET_REPO || process.env.GROUNDPLANE_REPO || path.join(__dirname, '..', 'groundplane-state');

function getHEAD() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_PATH, encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

function getPolicyCommit() {
  try {
    return execSync('git log -1 --format=%h -- state/policies.json', { cwd: REPO_PATH, encoding: 'utf8', timeout: 5000 }).trim() || getHEAD();
  } catch (e) {
    return getHEAD();
  }
}

function loadPolicy() {
  try {
    const policyPath = path.join(REPO_PATH, 'state', 'policies.json');
    return JSON.parse(require('fs').readFileSync(policyPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadDeviceState() {
  try {
    const statePath = path.join(REPO_PATH, 'state', 'devices.json');
    return JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function createClient(agentId) {
  const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
    username: agentId,
    password: MQTT_PASS,
    clientId: `${agentId}-demo-${Date.now()}`,
  });
  return client;
}

function msg(from, to, type, content, extras = {}) {
  return {
    msg_id: crypto.randomUUID(),
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
    ...extras,
  };
}

function send(client, topic, message) {
  return new Promise((resolve) => {
    client.publish(topic, JSON.stringify(message), { qos: 1 }, resolve);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logStep(step, description) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`\n[${ts}] ── Step ${step} ──────────────────────`);
  console.log(`  ${description}`);
}

/**
 * Issue a lease as root agent (Rupert).
 * Checks policy, creates signed lease, returns it.
 */
function issueLease(grantee, targetDevice, operation, parameterEnvelope, justification, opts = {}) {
  const policy = loadPolicy();
  const baseCommit = getHEAD();
  const policyCommit = getPolicyCommit();

  // Policy check
  if (policy) {
    const policyResult = checkPolicy(policy, grantee, targetDevice, operation);
    if (!policyResult.authorized) {
      console.log(`  ✗ Policy denied: ${policyResult.reason}`);
      return null;
    }

    const boundsCheck = checkEnvelopeWithinBounds(parameterEnvelope, policyResult.parameter_bounds);
    if (!boundsCheck.valid) {
      console.log(`  ✗ Policy denied: ${boundsCheck.reason}`);
      return null;
    }

    console.log(`  ✓ Policy check passed for ${grantee} → ${targetDevice}.${operation}`);
  }

  const lease = createLease({
    grantee,
    target_device: targetDevice,
    operation,
    parameter_envelope: parameterEnvelope,
    base_commit: baseCommit,
    policy_commit: policyCommit,
    justification,
    ttl_ms: opts.ttl_ms,
  });

  console.log(`  ✓ Lease issued: ${lease.lease_id.slice(0, 24)}... (expires: ${lease.expires_at})`);
  return lease;
}

module.exports = {
  createClient, msg, send, sleep, logStep,
  getHEAD, getPolicyCommit, loadPolicy, loadDeviceState,
  issueLease, createLease, validateLease,
  REPO_PATH, MQTT_HOST,
};
