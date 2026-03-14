#!/usr/bin/env node
/**
 * HearthNet Demo — Scene 1: Intent-Driven Multi-Agent Coordination
 * 
 * Paper scenario: "I'm working from home today, get the room ready."
 * 
 * Four-stage protocol:
 *   1. GROUND   — Agents load current state from Git
 *   2. PROPOSE  — Rupert decomposes, managers propose concrete actions
 *   3. VERIFY   — Rupert checks freshness + policy, issues leases
 *   4. EXECUTE  — Managers actuate with lease, Dewey records
 * 
 * Requires: MQTT broker running, Dewey librarian running
 */

const { createClient, msg, send, sleep, logStep, getHEAD, issueLease, loadDeviceState } = require('./demo-common');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' SCENE 1: Intent-Driven Multi-Agent Coordination');
  console.log(' "I\'m working from home today, get the room ready."');
  console.log('═══════════════════════════════════════════════════════\n');

  const baseCommit = getHEAD();
  const deviceState = loadDeviceState();
  console.log(`Ground truth HEAD: ${baseCommit}`);
  console.log(`Current device state:`, JSON.stringify(deviceState, null, 2), '\n');

  const rupert = createClient('rupert');
  const jeeves = createClient('jeeves');
  const darcy = createClient('darcy');

  await sleep(1000);

  // Subscribe to inboxes
  const received = { rupert: [], jeeves: [], darcy: [] };
  for (const [name, client] of [['rupert', rupert], ['jeeves', jeeves], ['darcy', darcy]]) {
    client.subscribe(`agents/inbox/${name}`);
    client.on('message', (topic, raw) => {
      const m = JSON.parse(raw.toString());
      if (m.from === name) return;
      received[name].push(m);
      console.log(`  [${name} inbox] ← ${m.from} (${m.type}): ${(m.content || '').substring(0, 100)}`);
    });
  }
  await sleep(500);

  // ═══ STAGE 1: GROUND ═══
  logStep('1 [GROUND]', 'User command arrives. Agents load current state from Git.');

  const userCmd = msg('user', 'rupert', 'task',
    "I'm working from home today, get the room ready.", { scene: 'scene1' });
  await send(rupert, 'agents/mirror', userCmd);
  await sleep(500);

  // ═══ STAGE 2: PROPOSE ═══
  logStep('2 [PROPOSE]', 'Rupert decomposes intent → dispatches subtasks to managers');

  const task1 = msg('rupert', 'jeeves', 'task',
    'Set living room lights to bright neutral for video calls', {
      base_commit: baseCommit,
      target_device: 'living_room_lights',
      desired_state: { brightness: 100, color_temp: 'neutral' },
      operation: 'set_state',
      scene: 'scene1',
    });

  const task2 = msg('rupert', 'jeeves', 'task',
    'Set speakers to low ambient background', {
      base_commit: baseCommit,
      target_device: 'speakers',
      desired_state: { volume: 15, source: 'ambient' },
      operation: 'set_state',
      scene: 'scene1',
    });

  const task3 = msg('rupert', 'darcy', 'task',
    'Launch focus timer app and enable do-not-disturb', {
      base_commit: baseCommit,
      target_device: 'phone_focus_timer',
      desired_state: { active: true, duration_min: 60 },
      operation: 'app_launch',
      scene: 'scene1',
    });

  const task4 = msg('rupert', 'darcy', 'task',
    'Enable do-not-disturb mode on phone', {
      base_commit: baseCommit,
      target_device: 'phone_dnd',
      desired_state: { enabled: true },
      operation: 'set_state',
      scene: 'scene1',
    });

  for (const [task, target] of [[task1, 'jeeves'], [task2, 'jeeves'], [task3, 'darcy'], [task4, 'darcy']]) {
    await send(rupert, `agents/inbox/${target}`, task);
    await send(rupert, 'agents/mirror', task);
    await sleep(300);
  }
  await sleep(1000);

  // ═══ STAGE 3: VERIFY & GRANT ═══
  logStep('3 [VERIFY & GRANT]', 'Rupert checks freshness + policy, issues actuation leases');

  // Issue leases for each approved action
  const lease1 = issueLease('jeeves', 'living_room_lights', 'set_state',
    { brightness: [80, 100], color_temp: null },
    'WFH mode: bright neutral lighting for video calls');

  const lease2 = issueLease('jeeves', 'speakers', 'set_state',
    { volume: [0, 30] },
    'WFH mode: low ambient background audio');

  const lease3 = issueLease('darcy', 'phone_focus_timer', 'app_launch',
    { active: true, duration_min: [30, 120] },
    'WFH mode: focus timer to reduce distractions');

  const lease4 = issueLease('darcy', 'phone_dnd', 'set_state',
    { enabled: true },
    'WFH mode: silence notifications during work');

  // Send lease grants
  const grant1 = msg('rupert', 'jeeves', 'lease_grant',
    'Lease granted: living_room_lights set_state', {
      lease: lease1, parent_msg_id: task1.msg_id, scene: 'scene1',
    });
  const grant2 = msg('rupert', 'jeeves', 'lease_grant',
    'Lease granted: speakers set_state', {
      lease: lease2, parent_msg_id: task2.msg_id, scene: 'scene1',
    });
  const grant3 = msg('rupert', 'darcy', 'lease_grant',
    'Lease granted: phone_focus_timer app_launch', {
      lease: lease3, parent_msg_id: task3.msg_id, scene: 'scene1',
    });
  const grant4 = msg('rupert', 'darcy', 'lease_grant',
    'Lease granted: phone_dnd set_state', {
      lease: lease4, parent_msg_id: task4.msg_id, scene: 'scene1',
    });

  for (const [grant, target] of [[grant1, 'jeeves'], [grant2, 'jeeves'], [grant3, 'darcy'], [grant4, 'darcy']]) {
    await send(rupert, `agents/inbox/${target}`, grant);
    await send(rupert, 'agents/mirror', grant);
    await sleep(300);
  }
  await sleep(1000);

  // ═══ STAGE 4: EXECUTE & RECORD ═══
  logStep('4 [EXECUTE & RECORD]', 'Managers execute with leases, confirm results');

  // Jeeves executes with leases
  const exec1 = msg('jeeves', 'device', 'execute',
    'Executing: lights to 100% neutral via Home Assistant', {
      lease: lease1, target_device: 'living_room_lights', operation: 'set_state',
      desired_state: { brightness: 100, color_temp: 'neutral' },
      base_commit: getHEAD(), scene: 'scene1',
    });
  await send(jeeves, 'agents/mirror', exec1);
  await sleep(300);

  const result1 = msg('jeeves', 'rupert', 'execute_result',
    'Lights set to 100% bright, neutral white', {
      lease: { lease_id: lease1.lease_id },
      target_device: 'living_room_lights',
      desired_state: { brightness: 100, color_temp: 'neutral' },
      resulting_commit: getHEAD(),  // ISSUE 6: include resulting commit to close the loop
      scene: 'scene1',
    });
  await send(jeeves, 'agents/inbox/rupert', result1);
  await send(jeeves, 'agents/mirror', result1);
  await sleep(300);

  const exec2 = msg('jeeves', 'device', 'execute',
    'Executing: speakers to 15% ambient', {
      lease: lease2, target_device: 'speakers', operation: 'set_state',
      desired_state: { volume: 15, source: 'ambient' },
      base_commit: getHEAD(), scene: 'scene1',
    });
  await send(jeeves, 'agents/mirror', exec2);
  await sleep(300);

  const result2 = msg('jeeves', 'rupert', 'execute_result',
    'Speakers set to 15%, ambient source', {
      lease: { lease_id: lease2.lease_id },
      target_device: 'speakers',
      desired_state: { volume: 15, source: 'ambient' },
      resulting_commit: getHEAD(),  // ISSUE 6: include resulting commit to close the loop
      scene: 'scene1',
    });
  await send(jeeves, 'agents/inbox/rupert', result2);
  await send(jeeves, 'agents/mirror', result2);
  await sleep(300);

  // Darcy executes
  const exec3 = msg('darcy', 'device', 'execute',
    'Executing: focus timer launched via UI automation', {
      lease: lease3, target_device: 'phone_focus_timer', operation: 'app_launch',
      desired_state: { active: true, duration_min: 60 },
      base_commit: getHEAD(), scene: 'scene1',
    });
  await send(darcy, 'agents/mirror', exec3);
  await sleep(300);

  const result3 = msg('darcy', 'rupert', 'execute_result',
    'Focus timer active (60 min)', {
      lease: { lease_id: lease3.lease_id },
      target_device: 'phone_focus_timer',
      desired_state: { active: true, duration_min: 60 },
      resulting_commit: getHEAD(),  // ISSUE 6: include resulting commit to close the loop
      scene: 'scene1',
    });
  await send(darcy, 'agents/inbox/rupert', result3);
  await send(darcy, 'agents/mirror', result3);
  await sleep(300);

  const exec4 = msg('darcy', 'device', 'execute',
    'Executing: DND enabled', {
      lease: lease4, target_device: 'phone_dnd', operation: 'set_state',
      desired_state: { enabled: true },
      base_commit: getHEAD(), scene: 'scene1',
    });
  await send(darcy, 'agents/mirror', exec4);
  await sleep(300);

  const result4 = msg('darcy', 'rupert', 'execute_result',
    'Do-not-disturb enabled', {
      lease: { lease_id: lease4.lease_id },
      target_device: 'phone_dnd',
      desired_state: { enabled: true },
      resulting_commit: getHEAD(),  // ISSUE 6: include resulting commit to close the loop
      scene: 'scene1',
    });
  await send(darcy, 'agents/inbox/rupert', result4);
  await send(darcy, 'agents/mirror', result4);
  await sleep(1000);

  // Rupert confirms completion
  logStep('5 [COMPLETE]', 'Rupert confirms: Work-from-home mode active');

  const completion = msg('rupert', 'broadcast', 'resolution',
    'Work-from-home mode active. Mode: work_from_home. ' +
    '4 devices confirmed: lights (100% neutral), speakers (15% ambient), focus timer (60min), DND (on). ' +
    '4 leases issued and consumed.',
    { scene: 'scene1' });
  await send(rupert, 'agents/broadcast', completion);
  await send(rupert, 'agents/mirror', completion);
  await sleep(1500);

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' SCENE 1 COMPLETE');
  console.log(`  Protocol: Ground → Propose → Verify/Grant → Execute`);
  console.log(`  Subtasks: 4 (2 Jeeves, 2 Darcy)`);
  console.log(`  Leases issued: 4 (all consumed)`);
  console.log(`  Devices actuated: living_room_lights, speakers, phone_focus_timer, phone_dnd`);
  console.log(`  Ground truth HEAD: ${getHEAD()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  rupert.end(); jeeves.end(); darcy.end();
  process.exit(0);
}

main().catch(console.error);
