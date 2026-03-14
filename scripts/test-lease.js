const assert = require('assert/strict');
const {
  createLease,
  validateLease,
  checkEnvelopeWithinBounds,
} = require('../protocol/lease');

const lease = createLease({
  grantee: 'jeeves',
  target_device: 'speakers',
  operation: 'set_state',
  parameter_envelope: { volume: [0, 10] },
  base_commit: 'abc1234',
  policy_commit: 'def5678',
  justification: 'self-test',
});

assert.equal(
  validateLease(lease, {
    agent_id: 'jeeves',
    target_device: 'speakers',
    operation: 'set_state',
    desired_state: { volume: 7 },
  }).valid,
  true
);

assert.equal(
  validateLease(lease, {
    agent_id: 'jeeves',
    target_device: 'speakers',
    operation: 'set_state',
    desired_state: { volume: 'LOUD' },
  }).valid,
  false
);

assert.equal(
  checkEnvelopeWithinBounds(
    { volume: [0, 999] },
    { volume: [0, 100] }
  ).valid,
  false
);

console.log('lease checks passed');
