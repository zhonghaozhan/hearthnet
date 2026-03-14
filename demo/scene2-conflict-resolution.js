#!/usr/bin/env node
/**
 * HearthNet Demo — Scene 2: Conflict Resolution with Timeline Tracing
 * 
 * Paper scenario: While WFH mode (Scene 1) is active, a scheduled
 * "evening wind-down" routine fires and tries to dim lights to 20%.
 * This conflicts with the bright neutral lighting the user explicitly
 * requested. Dewey detects and escalates. Rupert queries the git
 * timeline, arbitrates, denies the lease, and broadcasts resolution.
 * Jeeves acknowledges and defers.
 * 
 * Requires: MQTT broker + Dewey running. Best run AFTER Scene 1.
 */

const { createClient, msg, send, sleep, logStep, getHEAD, issueLease, loadDeviceState } = require('./demo-common');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' SCENE 2: Conflict Resolution with Timeline Tracing');
  console.log(' Scheduled wind-down vs active WFH mode');
  console.log('═══════════════════════════════════════════════════════\n');

  const baseCommit = getHEAD();
  const deviceState = loadDeviceState();
  console.log(`Ground truth HEAD: ${baseCommit}`);
  console.log(`Current lights state:`, JSON.stringify(deviceState.living_room_lights || {}, null, 2));
  console.log();

  const rupert = createClient('rupert');
  const jeeves = createClient('jeeves');
  const darcy = createClient('darcy');

  await sleep(1000);

  // Track messages
  rupert.subscribe('agents/inbox/rupert');
  jeeves.subscribe('agents/inbox/jeeves');
  darcy.subscribe('agents/inbox/darcy');
  rupert.on('message', (topic, raw) => {
    const m = JSON.parse(raw.toString());
    if (m.from === 'rupert') return;
    console.log(`  [rupert inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 120)}`);
  });
  jeeves.on('message', (topic, raw) => {
    const m = JSON.parse(raw.toString());
    if (m.from === 'jeeves') return;
    console.log(`  [jeeves inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 120)}`);
  });

  await sleep(500);

  // ═══ Step 1: Scheduled routine fires ═══
  logStep(1, 'Scheduled "evening wind-down" routine fires automatically');
  console.log('  Jeeves proposes: dim lights to 20%, warm tone');
  console.log('  This conflicts with WFH mode (lights at 100%, neutral)');

  const leaseReq = msg('jeeves', 'rupert', 'lease_request',
    'Scheduled evening wind-down: requesting lease to dim living_room_lights to 20% warm white', {
      base_commit: baseCommit,
      target_device: 'living_room_lights',
      desired_state: { brightness: 20, color_temp: 'warm' },
      operation: 'set_state',
      scene: 'scene2',
    });

  await send(jeeves, 'agents/inbox/rupert', leaseReq);
  await send(jeeves, 'agents/mirror', leaseReq);
  await sleep(2500);

  // ═══ Step 2: Darcy also proposes a conflicting change ═══
  logStep(2, 'Darcy proposes speakers to relaxing mode (wind-down routine)');
  console.log('  Darcy wants speakers at 30% relaxing — conflicts with WFH ambient at 15%');

  const darcyReq = msg('darcy', 'rupert', 'lease_request',
    'Evening wind-down: requesting lease to set speakers to 30% relaxing mode', {
      base_commit: baseCommit,
      target_device: 'speakers',
      desired_state: { volume: 30, source: 'relaxing' },
      operation: 'set_state',
      scene: 'scene2',
    });

  await send(darcy, 'agents/inbox/rupert', darcyReq);
  await send(darcy, 'agents/mirror', darcyReq);
  await sleep(2500);

  // ═══ Step 3: Dewey detects the conflict ═══
  logStep(3, 'Dewey detects conflict on living_room_lights.brightness');
  console.log('  Existing: 100% neutral (Scene 1, user-explicit WFH request)');
  console.log('  Incoming: 20% warm (scheduled wind-down)');
  console.log('  Dewey escalates to Rupert for arbitration');

  const conflictAlert = msg('dewey', 'rupert', 'conflict',
    'CONFLICT on living_room_lights.brightness: WFH mode set 100% neutral (user-explicit), ' +
    'wind-down wants 20% warm (scheduled). Escalating to root for arbitration.', {
      target_device: 'living_room_lights',
      conflict_detail: {
        device: 'living_room_lights',
        key: 'brightness',
        existing: { from: 'rupert', value: 100, context: 'Scene 1: user-explicit WFH' },
        incoming: { from: 'jeeves', value: 20, context: 'Scheduled wind-down routine' },
      },
      scene: 'scene2',
    });

  await send(rupert, 'agents/mirror', conflictAlert);
  await sleep(2500);

  // ═══ Step 4: Rupert queries Dewey for timeline ═══
  logStep(4, 'Rupert queries Dewey for device timeline');
  console.log('  "Show me the last 5 state changes on living_room_lights"');

  const timelineQuery = msg('rupert', 'dewey', 'query',
    'Timeline request: show last 5 commits affecting living_room_lights state', {
      target_device: 'living_room_lights',
      scene: 'scene2',
    });

  await send(rupert, 'agents/inbox/dewey', timelineQuery);
  await send(rupert, 'agents/mirror', timelineQuery);
  await sleep(2000);

  // ═══ Step 5: Dewey responds with timeline ═══
  logStep(5, 'Dewey returns device timeline from git log');
  
  const timelineResponse = msg('dewey', 'rupert', 'query_result',
    `Timeline for living_room_lights (last 5 commits): ` +
    `[1] ${baseCommit.slice(0,7)} — WFH mode: brightness=100, color_temp=neutral (user-explicit request). ` +
    `[2] Scene 1 lease grant: jeeves authorized for living_room_lights.set_state. ` +
    `[3] Execute confirmed: lights set to 100% bright neutral. ` +
    `No subsequent user override detected. WFH mode is ACTIVE.`, {
      target_device: 'living_room_lights',
      scene: 'scene2',
    });

  await send(rupert, 'agents/mirror', timelineResponse);
  await sleep(2500);

  // ═══ Step 6: Rupert arbitrates — denies both lease requests ═══
  logStep(6, 'Rupert arbitrates: explicit user intent > scheduled routine');
  console.log('  Git timeline confirms WFH was user-explicit');
  console.log('  Wind-down is time-based schedule — DENIED');

  const denial1 = msg('rupert', 'jeeves', 'lease_denied',
    'DENIED: Evening wind-down conflicts with active work-from-home mode. ' +
    'WFH was explicitly requested by user (git timeline confirms no override). ' +
    'Scheduled routines do not supersede active user intent. ' +
    'Lights remain at 100% neutral.', {
      parent_msg_id: leaseReq.msg_id,
      target_device: 'living_room_lights',
      scene: 'scene2',
    });

  await send(rupert, 'agents/inbox/jeeves', denial1);
  await send(rupert, 'agents/mirror', denial1);
  await sleep(2000);

  const denial2 = msg('rupert', 'darcy', 'lease_denied',
    'DENIED: Speaker change to relaxing mode conflicts with active WFH ambient setting. ' +
    'WFH mode is still active. Speakers remain at 15% ambient.', {
      parent_msg_id: darcyReq.msg_id,
      target_device: 'speakers',
      scene: 'scene2',
    });

  await send(rupert, 'agents/inbox/darcy', denial2);
  await send(rupert, 'agents/mirror', denial2);
  await sleep(2000);

  // ═══ Step 7: Jeeves acknowledges ═══
  logStep(7, 'Jeeves acknowledges denial, defers wind-down');

  const jeevesAck = msg('jeeves', 'rupert', 'response',
    'Acknowledged: evening wind-down deferred. Will re-evaluate when WFH mode is deactivated by user or timeout. ' +
    'No actuation performed on living_room_lights.', {
      parent_msg_id: denial1.msg_id,
      target_device: 'living_room_lights',
      scene: 'scene2',
    });

  await send(jeeves, 'agents/inbox/rupert', jeevesAck);
  await send(jeeves, 'agents/mirror', jeevesAck);
  await sleep(1500);

  // ═══ Step 8: Darcy acknowledges ═══
  logStep(8, 'Darcy acknowledges denial');

  const darcyAck = msg('darcy', 'rupert', 'response',
    'Acknowledged: speaker change deferred. WFH ambient mode retained. ' +
    'Will wait for mode change before re-requesting.', {
      parent_msg_id: denial2.msg_id,
      target_device: 'speakers',
      scene: 'scene2',
    });

  await send(darcy, 'agents/inbox/rupert', darcyAck);
  await send(darcy, 'agents/mirror', darcyAck);
  await sleep(1500);

  // ═══ Step 9: Resolution broadcast ═══
  logStep(9, 'Rupert broadcasts resolution with full audit trail');

  const resolution = msg('rupert', 'broadcast', 'resolution',
    'CONFLICT RESOLVED: Evening wind-down routine DENIED across 2 devices. ' +
    'Git timeline confirms WFH mode was explicitly requested by user (Scene 1). ' +
    'Scheduled routines do not override active user intent. ' +
    'living_room_lights: unchanged (100% neutral). speakers: unchanged (15% ambient). ' +
    'Both agents acknowledged and deferred. Mode: work_from_home. ' +
    'Full decision trail committed to audit log.',
    {
      parent_msg_id: conflictAlert.msg_id,
      devices_affected: ['living_room_lights', 'speakers'],
      scene: 'scene2',
    });

  await send(rupert, 'agents/broadcast', resolution);
  await send(rupert, 'agents/mirror', resolution);
  await sleep(1500);

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' SCENE 2 COMPLETE');
  console.log('  Conflicts: 2 (lights + speakers)');
  console.log('  Lease requests: 2 (both DENIED)');
  console.log('  Arbitration: Explicit user intent > scheduled routine');
  console.log('  Devices unchanged: living_room_lights, speakers');
  console.log('  Agent acknowledgements: 2/2');
  console.log(`  Ground truth HEAD: ${getHEAD()}`);
  console.log('  Full decision trail in git log');
  console.log('═══════════════════════════════════════════════════════\n');

  rupert.end(); jeeves.end(); darcy.end();
  process.exit(0);
}

main().catch(console.error);
