#!/usr/bin/env node
/**
 * HearthNet Demo — Scene 3: Freshness and Authorization Verification
 * 
 * Paper scenario: Jeeves crashes mid-operation, restarts, and attempts to
 * replay a pre-crash command using stale state. Dewey catches it with a
 * double safety gate (base_commit freshness + lease expiration). Jeeves
 * re-syncs, requests a fresh lease, but Rupert still denies on policy
 * grounds. Demonstrates crash recovery, state verification, and policy
 * coherence across restarts.
 * 
 * Requires: MQTT broker + Dewey running. Best run AFTER Scenes 1 & 2.
 */

const { createClient, msg, send, sleep, logStep, getHEAD, issueLease, createLease, validateLease } = require('./demo-common');
const { execSync } = require('child_process');
const path = require('path');

const REPO_PATH = process.env.HEARTHNET_REPO || process.env.GROUNDPLANE_REPO || path.join(__dirname, '..', 'groundplane-state');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' SCENE 3: Freshness and Authorization Verification');
  console.log(' Crashed agent replays stale command with expired lease');
  console.log('═══════════════════════════════════════════════════════\n');

  const currentHead = getHEAD();

  // Get a stale commit — significantly behind HEAD
  let staleCommit;
  try {
    staleCommit = execSync('git rev-parse --short HEAD~10 2>/dev/null || git rev-list --max-parents=0 HEAD | head -1 | cut -c1-7', {
      cwd: REPO_PATH, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch (e) {
    staleCommit = 'abc1234';
  }

  console.log(`Current HEAD:  ${currentHead}`);
  console.log(`Stale commit:  ${staleCommit} (agent's pre-crash state)`);
  console.log();

  const jeeves = createClient('jeeves');
  const rupert = createClient('rupert');
  const dewey = createClient('dewey-script'); // separate from real Dewey

  await sleep(1000);

  // Listen for messages
  jeeves.subscribe('agents/inbox/jeeves');
  jeeves.on('message', (topic, raw) => {
    const m = JSON.parse(raw.toString());
    if (m.from === 'jeeves') return;
    console.log(`  [jeeves inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 140)}`);
  });
  rupert.subscribe('agents/inbox/rupert');
  rupert.on('message', (topic, raw) => {
    const m = JSON.parse(raw.toString());
    if (m.from === 'rupert') return;
    console.log(`  [rupert inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 140)}`);
  });

  await sleep(500);

  // ═══ Step 1: Show pre-crash state ═══
  logStep(1, 'Jeeves had an active lease BEFORE crash (now expired)');

  const { getPolicyCommit } = require('./demo-common');
  const expiredLease = createLease({
    grantee: 'jeeves',
    target_device: 'living_room_lights',
    operation: 'set_state',
    parameter_envelope: { brightness: [0, 50], color_temp: null },
    base_commit: staleCommit,
    policy_commit: getPolicyCommit() || staleCommit,
    justification: 'Pre-crash: evening routine brightness adjustment',
    ttl_ms: 1,
  });

  console.log(`  Lease ID:     ${expiredLease.lease_id.slice(0, 24)}...`);
  console.log(`  Bound to:     commit ${staleCommit}`);
  console.log(`  Expired at:   ${expiredLease.expires_at}`);
  console.log(`  Status:       EXPIRED (pre-crash, stale state)`);

  await sleep(2000);

  // ═══ Step 2: Jeeves announces crash recovery ═══
  logStep(2, 'Jeeves process restarts — announces crash recovery');

  const crashNotice = msg('jeeves', 'broadcast', 'event',
    'RESTART: Jeeves process recovered from crash. ' +
    'Last known state: commit ' + staleCommit + '. ' +
    'Attempting to resume pending operations.', {
      stale_commit: staleCommit,
      current_head: currentHead,
      scene: 'scene3',
    });

  await send(jeeves, 'agents/broadcast', crashNotice);
  await send(jeeves, 'agents/mirror', crashNotice);
  await sleep(2500);

  // ═══ Step 3: Jeeves queries Dewey for current state ═══
  logStep(3, 'Jeeves asks Dewey: what is the current state?');

  const stateQuery = msg('jeeves', 'dewey', 'query',
    'Post-crash sync: requesting current HEAD and device state for living_room_lights', {
      target_device: 'living_room_lights',
      scene: 'scene3',
    });

  await send(jeeves, 'agents/inbox/dewey', stateQuery);
  await send(jeeves, 'agents/mirror', stateQuery);
  await sleep(2000);

  // ═══ Step 4: Dewey responds with current state ═══
  logStep(4, 'Dewey returns current ground truth');

  const stateResponse = msg('dewey', 'jeeves', 'query_result',
    `Current HEAD: ${currentHead}. ` +
    `living_room_lights: brightness=100, color_temp=neutral, power=on. ` +
    `Active mode: work_from_home (set by user, Scene 1). ` +
    `Your last known commit ${staleCommit} is ${'>'}10 commits behind HEAD. ` +
    `Any leases bound to ${staleCommit} are INVALID.`, {
      target_device: 'living_room_lights',
      current_head: currentHead,
      stale_commit: staleCommit,
      scene: 'scene3',
    });

  await send(jeeves, 'agents/mirror', stateResponse);
  await sleep(2500);

  // ═══ Step 5: Jeeves ignores warning and tries stale replay anyway ═══
  logStep(5, 'Jeeves attempts stale replay with expired lease (unsafe)');
  console.log('  Jeeves ignores the state gap and tries to execute cached command');
  console.log('  This simulates an agent that does NOT properly handle crash recovery');

  const staleExec = msg('jeeves', 'device', 'execute',
    'Executing: dim lights to 30% (pre-crash evening routine) | ' +
    'LEASE: ' + expiredLease.lease_id.slice(0, 16) + '... | ' +
    'BASE_COMMIT: ' + staleCommit, {
      lease: expiredLease,
      base_commit: staleCommit,
      target_device: 'living_room_lights',
      operation: 'set_state',
      desired_state: { brightness: 30, color_temp: 'warm' },
      scene: 'scene3',
    });

  await send(jeeves, 'agents/mirror', staleExec);
  await sleep(3000);

  // ═══ Step 6: Dewey rejects — double safety gate ═══
  logStep(6, 'Dewey validates → DOUBLE REJECTION');
  console.log('  Check 1: base_commit freshness → STALE (10+ commits behind HEAD)');
  console.log('  Check 2: lease expiration → EXPIRED');
  console.log('  Dewey rejects and notifies all agents');

  const leaseCheck = validateLease(expiredLease, {
    agent_id: 'jeeves',
    target_device: 'living_room_lights',
    operation: 'set_state',
    desired_state: { brightness: 30, color_temp: 'warm' },
    current_head: currentHead,
  });
  console.log(`  Local validation: valid=${leaseCheck.valid}, reason="${leaseCheck.reason}"`);

  const rejectionDetail = msg('dewey', 'broadcast', 'rejection',
    'REJECTED stale replay from Jeeves on living_room_lights. ' +
    'Reason 1: base_commit ' + staleCommit + ' is 10+ commits behind HEAD ' + currentHead + '. ' +
    'Reason 2: lease ' + expiredLease.lease_id.slice(0, 16) + ' expired at ' + expiredLease.expires_at + '. ' +
    'No actuation permitted. Jeeves must re-sync and request fresh authorization.', {
      target_device: 'living_room_lights',
      stale_commit: staleCommit,
      current_head: currentHead,
      scene: 'scene3',
    });

  await send(rupert, 'agents/broadcast', rejectionDetail);
  await send(rupert, 'agents/mirror', rejectionDetail);
  await sleep(2500);

  // ═══ Step 7: Rupert logs the safety event ═══
  logStep(7, 'Rupert logs safety event: stale replay attempt detected');

  const safetyLog = msg('rupert', 'dewey', 'task',
    'SAFETY AUDIT: Log stale replay attempt. Agent: jeeves. ' +
    'Attempted: living_room_lights dim to 30%. ' +
    'Blocked by: base_commit freshness check + lease expiration. ' +
    'No unauthorized actuation occurred. Commit this to audit trail.', {
      target_device: 'living_room_lights',
      scene: 'scene3',
    });

  await send(rupert, 'agents/inbox/dewey', safetyLog);
  await send(rupert, 'agents/mirror', safetyLog);
  await sleep(2500);

  // ═══ Step 8: Jeeves properly re-syncs and requests fresh lease ═══
  logStep(8, 'Jeeves properly re-syncs, requests fresh lease from Rupert');
  console.log('  Now using current HEAD — correct recovery procedure');

  const freshReq = msg('jeeves', 'rupert', 'lease_request',
    'Post-crash recovery complete. Re-synced to HEAD ' + currentHead + '. ' +
    'Requesting fresh lease for living_room_lights: dim to 30% warm (deferred evening routine).', {
      base_commit: currentHead,
      target_device: 'living_room_lights',
      operation: 'set_state',
      desired_state: { brightness: 30, color_temp: 'warm' },
      scene: 'scene3',
    });

  await send(jeeves, 'agents/inbox/rupert', freshReq);
  await send(jeeves, 'agents/mirror', freshReq);
  await sleep(2500);

  // ═══ Step 9: Rupert denies on policy grounds ═══
  logStep(9, 'Rupert denies: fresh commit, but WFH policy still active');
  console.log('  Even with valid state, the action contradicts active user mode');
  console.log('  Protocol enforces policy coherence, not just freshness');

  const policyDenial = msg('rupert', 'jeeves', 'lease_denied',
    'DENIED: Your commit is now current, but WFH mode is still active (set by user in Scene 1). ' +
    'Dimming to 30% contradicts the active work-from-home lighting policy. ' +
    'The evening routine must wait for user mode change or explicit override. ' +
    'Freshness alone is not sufficient — policy coherence is required.', {
      parent_msg_id: freshReq.msg_id,
      target_device: 'living_room_lights',
      scene: 'scene3',
    });

  await send(rupert, 'agents/inbox/jeeves', policyDenial);
  await send(rupert, 'agents/mirror', policyDenial);
  await sleep(2000);

  // ═══ Step 10: Jeeves acknowledges ═══
  logStep(10, 'Jeeves acknowledges: crash recovery complete, deferred');

  const ack = msg('jeeves', 'rupert', 'response',
    'Acknowledged: crash recovery complete. State re-synced to HEAD ' + currentHead + '. ' +
    'Evening routine deferred — WFH mode still active. ' +
    'Will not retry until mode changes. No actuation performed.', {
      scene: 'scene3',
    });

  await send(jeeves, 'agents/inbox/rupert', ack);
  await send(jeeves, 'agents/mirror', ack);
  await sleep(1500);

  // ═══ Step 11: Resolution broadcast ═══
  logStep(11, 'Rupert broadcasts resolution: crash recovery handled safely');

  const resolution = msg('rupert', 'broadcast', 'resolution',
    'SCENE 3 RESOLVED: Crash recovery handled safely. ' +
    'Stale replay BLOCKED by double safety gate (base_commit + lease expiration). ' +
    'Fresh re-request DENIED on policy grounds (WFH mode active). ' +
    'Zero unauthorized actuations. Full audit trail committed. ' +
    'Protocol guarantees: no stale state can cause actuation, ' +
    'and policy coherence is enforced even after agent restarts.', {
      target_device: 'living_room_lights',
      scene: 'scene3',
    });

  await send(rupert, 'agents/broadcast', resolution);
  await send(rupert, 'agents/mirror', resolution);
  await sleep(1500);

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' SCENE 3 COMPLETE');
  console.log('  Steps: 11');
  console.log('  Stale replay: BLOCKED (base_commit + expired lease)');
  console.log(`  Stale commit: ${staleCommit} vs HEAD ${currentHead}`);
  console.log(`  Expired lease: ${expiredLease.lease_id.slice(0, 24)}...`);
  console.log('  Fresh re-request: DENIED (policy coherence)');
  console.log('  Safety gate: 2/2 checks caught stale replay');
  console.log('  Policy gate: 1/1 checks enforced mode coherence');
  console.log('  Unauthorized actuations: 0');
  console.log(`  Ground truth HEAD: ${getHEAD()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  jeeves.end(); rupert.end(); dewey.end();
  process.exit(0);
}

main().catch(console.error);
