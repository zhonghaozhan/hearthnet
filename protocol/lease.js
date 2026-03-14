/**
 * HearthNet Actuation Lease System
 * 
 * Root-issued, short-lived, machine-checkable authorizations.
 * Each lease binds a state-changing command to:
 *   1. grantee manager identity
 *   2. target device or device class
 *   3. permitted operation + parameter envelope
 *   4. current base_commit (state version)
 *   5. policy_commit (policy version under which decision was made)
 *   6. expiration time
 *   7. human-readable justification
 * 
 * Leases are HMAC-SHA256 signed by the root agent's secret.
 * Device adapters / managers MUST present a valid lease for any state change.
 */

const crypto = require('crypto');

// Default lease TTL: 30 seconds (short-lived by design)
const DEFAULT_LEASE_TTL_MS = 30_000;

// Root signing secret — MUST be injected via environment variable.
// No fallback: fail loud if not configured.
if (!process.env.HEARTHNET_ROOT_SECRET) {
  throw new Error('HEARTHNET_ROOT_SECRET environment variable is required (no default for security)');
}
const ROOT_SECRET = process.env.HEARTHNET_ROOT_SECRET;

/**
 * Create a signed actuation lease.
 * Only the root agent (Rupert) should call this.
 * 
 * @param {Object} opts
 * @param {string} opts.grantee       - Manager identity (e.g. 'jeeves', 'darcy')
 * @param {string} opts.target_device  - Device or device class (e.g. 'living_room_lights')
 * @param {string} opts.operation      - Permitted operation (e.g. 'set_state', 'ui_automation')
 * @param {Object} opts.parameter_envelope - Allowed parameter ranges { key: value | [min, max] }
 * @param {string} opts.base_commit    - Git HEAD at time of grant
 * @param {string} opts.policy_commit  - Policy file commit hash
 * @param {string} opts.justification  - Human-readable reason for audit
 * @param {number} [opts.ttl_ms]       - Lease TTL in ms (default: 30s)
 * @returns {Object} Signed lease object
 */
function createLease(opts) {
  if (!opts.grantee || !opts.target_device || !opts.operation || !opts.base_commit) {
    throw new Error('Lease requires: grantee, target_device, operation, base_commit');
  }
  
  // ISSUE 3: policy_commit must be explicit (don't default to base_commit)
  if (!opts.policy_commit) {
    throw new Error('Lease requires explicit policy_commit (do not default to base_commit)');
  }

  const now = Date.now();
  const ttl = opts.ttl_ms || DEFAULT_LEASE_TTL_MS;

  const lease = {
    lease_id: `lease-${crypto.randomUUID()}`,
    grantee: opts.grantee,
    target_device: opts.target_device,
    operation: opts.operation,
    parameter_envelope: opts.parameter_envelope || {},
    base_commit: opts.base_commit,
    policy_commit: opts.policy_commit,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
    justification: opts.justification || '',
  };

  // HMAC-SHA256 signature over the canonical lease fields
  lease.signature = signLease(lease);

  return lease;
}

/**
 * Compute HMAC-SHA256 signature for a lease.
 * Signs over canonical field ordering to prevent tampering.
 * 
 * ISSUE 1: justification now signed (10th field)
 * ISSUE 2: Use JSON.stringify instead of pipe delimiter to avoid field boundary ambiguity
 */
function signLease(lease) {
  const fields = [
    lease.lease_id,
    lease.grantee,
    lease.target_device,
    lease.operation,
    lease.parameter_envelope,  // Will be stringified as part of array
    lease.base_commit,
    lease.policy_commit,
    lease.issued_at,
    lease.expires_at,
    lease.justification,  // ISSUE 1: now signed
  ];
  
  // ISSUE 2: JSON.stringify avoids pipe delimiter ambiguity
  const payload = JSON.stringify(fields);

  return crypto.createHmac('sha256', ROOT_SECRET).update(payload).digest('hex');
}

/**
 * Validate a lease. Returns { valid: boolean, reason?: string }.
 * 
 * Checks:
 *   1. Signature integrity (HMAC verification)
 *   2. Expiration (not expired)
 *   3. Grantee matches the presenting agent
 *   4. Target device matches the command target
 *   5. Operation matches the command operation
 *   6. Parameter envelope (values within bounds)
 *   7. Base commit freshness (optional, requires current HEAD)
 */
function validateLease(lease, context = {}) {
  if (!lease || !lease.lease_id) {
    return { valid: false, reason: 'no lease provided' };
  }

  // 1. Signature check
  const expectedSig = signLease(lease);
  if (lease.signature !== expectedSig) {
    return { valid: false, reason: 'signature verification failed — lease may be forged or tampered' };
  }

  // 2. Expiration check
  const now = Date.now();
  const expiresAt = new Date(lease.expires_at).getTime();
  if (now > expiresAt) {
    const expiredAgo = Math.round((now - expiresAt) / 1000);
    return { valid: false, reason: `lease expired ${expiredAgo}s ago (expired: ${lease.expires_at})` };
  }

  // 3. Grantee check
  if (context.agent_id && lease.grantee !== context.agent_id) {
    return { valid: false, reason: `lease granted to '${lease.grantee}', presented by '${context.agent_id}'` };
  }

  // 4. Target device check
  if (context.target_device && lease.target_device !== context.target_device) {
    return { valid: false, reason: `lease targets '${lease.target_device}', command targets '${context.target_device}'` };
  }

  // 5. Operation check
  if (context.operation && lease.operation !== context.operation) {
    return { valid: false, reason: `lease permits '${lease.operation}', command requests '${context.operation}'` };
  }

  // 6. Parameter envelope check
  if (context.desired_state && lease.parameter_envelope) {
    const envCheck = checkParameterEnvelope(lease.parameter_envelope, context.desired_state);
    if (!envCheck.valid) {
      return { valid: false, reason: `parameter out of bounds: ${envCheck.reason}` };
    }
  }

  // 7. Base commit freshness (if current HEAD provided)
  if (context.current_head && lease.base_commit !== context.current_head) {
    return { valid: false, reason: `lease bound to commit ${lease.base_commit}, current HEAD is ${context.current_head}` };
  }

  return { valid: true };
}

/**
 * Check if desired_state values fall within the parameter envelope.
 * Envelope values can be:
 *   - exact value: must match exactly
 *   - [min, max] array: must be within range (inclusive)
 *   - null/undefined: any value allowed
 */
function checkParameterEnvelope(envelope, desiredState) {
  for (const [key, value] of Object.entries(desiredState)) {
    const bound = envelope[key];
    const boundCheck = checkValueAgainstBound(value, bound, key);
    if (!boundCheck.valid) {
      return boundCheck;
    }
  }
  return { valid: true };
}

function checkValueAgainstBound(value, bound, key = 'value') {
  if (bound === undefined || bound === null) {
    return { valid: true };
  }

  if (Array.isArray(bound)) {
    if (bound.length !== 2 || typeof bound[0] !== 'number' || typeof bound[1] !== 'number') {
      return { valid: false, reason: `${key} has invalid numeric range ${JSON.stringify(bound)}` };
    }
    if (typeof value !== 'number') {
      return { valid: false, reason: `${key}=${JSON.stringify(value)} must be numeric for range [${bound[0]}, ${bound[1]}]` };
    }
    if (value < bound[0] || value > bound[1]) {
      return { valid: false, reason: `${key}=${value} outside range [${bound[0]}, ${bound[1]}]` };
    }
    return { valid: true };
  }

  if (JSON.stringify(value) !== JSON.stringify(bound)) {
    return { valid: false, reason: `${key}=${JSON.stringify(value)} does not match required ${JSON.stringify(bound)}` };
  }

  return { valid: true };
}

/**
 * Check whether a requested parameter envelope stays within the policy bounds.
 * Requested values can be exact values or [min, max] ranges.
 */
function checkEnvelopeWithinBounds(requestedEnvelope, policyBounds) {
  for (const [key, requested] of Object.entries(requestedEnvelope || {})) {
    const allowed = policyBounds ? policyBounds[key] : undefined;
    if (allowed === undefined || allowed === null) continue;

    if (Array.isArray(requested)) {
      if (requested.length !== 2 || typeof requested[0] !== 'number' || typeof requested[1] !== 'number') {
        return { valid: false, reason: `${key} requested invalid range ${JSON.stringify(requested)}` };
      }
      if (requested[0] > requested[1]) {
        return { valid: false, reason: `${key} requested inverted range ${JSON.stringify(requested)}` };
      }

      const lowerBoundCheck = checkValueAgainstBound(requested[0], allowed, `${key}[min]`);
      if (!lowerBoundCheck.valid) {
        return lowerBoundCheck;
      }

      const upperBoundCheck = checkValueAgainstBound(requested[1], allowed, `${key}[max]`);
      if (!upperBoundCheck.valid) {
        return upperBoundCheck;
      }

      continue;
    }

    const requestedCheck = checkValueAgainstBound(requested, allowed, key);
    if (!requestedCheck.valid) {
      return requestedCheck;
    }
  }
  return { valid: true };
}

/**
 * Check if an operation is authorized by the policy for a given role.
 * 
 * @param {Object} policy - The full policy object
 * @param {string} role - Agent role (e.g. 'jeeves')
 * @param {string} targetDevice - Device being acted upon
 * @param {string} operation - Requested operation
 * @returns {{ authorized: boolean, reason?: string, parameter_bounds?: Object }}
 */
function checkPolicy(policy, role, targetDevice, operation) {
  if (!policy || !policy.roles || !policy.roles[role]) {
    return { authorized: false, reason: `no policy entry for role '${role}'` };
  }

  const rolePolicy = policy.roles[role];

  // Check device authorization
  if (rolePolicy.allowed_devices && !rolePolicy.allowed_devices.includes(targetDevice)) {
    return { authorized: false, reason: `role '${role}' not authorized for device '${targetDevice}'` };
  }

  // Check operation authorization
  if (rolePolicy.allowed_operations && !rolePolicy.allowed_operations.includes(operation)) {
    return { authorized: false, reason: `role '${role}' not authorized for operation '${operation}' on '${targetDevice}'` };
  }

  return {
    authorized: true,
    parameter_bounds: rolePolicy.parameter_bounds || {},
  };
}

module.exports = {
  createLease,
  validateLease,
  checkPolicy,
  checkParameterEnvelope,
  checkEnvelopeWithinBounds,
  signLease,
  DEFAULT_LEASE_TTL_MS,
};
