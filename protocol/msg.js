/**
 * HearthNet Message Helper
 * 
 * Creates well-formed messages for the HearthNet protocol.
 * Used by all agents and demo scripts.
 */

const crypto = require('crypto');

/**
 * Create a HearthNet message.
 * @param {Object} opts
 * @param {string} opts.from - Sender agent ID
 * @param {string} opts.to - Recipient agent ID or 'broadcast'
 * @param {string} opts.type - Message type
 * @param {string} opts.content - Human-readable content
 * @param {string} [opts.base_commit] - Git commit hash sender believes is HEAD
 * @param {string} [opts.target_device] - Device being acted upon
 * @param {string} [opts.operation] - Operation type (set_state, ui_automation, etc.)
 * @param {Object} [opts.desired_state] - Desired device state key-values
 * @param {Object} [opts.lease] - Actuation lease (for execute messages)
 * @param {string} [opts.parent_msg_id] - Parent message ID for threading
 * @param {string} [opts.scene] - Demo scene tag
 * @returns {Object} Complete message object
 */
function createMessage(opts) {
  if (!opts.from || !opts.to || !opts.type || !opts.content) {
    throw new Error('Missing required fields: from, to, type, content');
  }

  return {
    msg_id: crypto.randomUUID(),
    from: opts.from,
    to: opts.to,
    type: opts.type,
    content: opts.content,
    timestamp: new Date().toISOString(),
    ...(opts.base_commit && { base_commit: opts.base_commit }),
    ...(opts.target_device && { target_device: opts.target_device }),
    ...(opts.operation && { operation: opts.operation }),
    ...(opts.desired_state && { desired_state: opts.desired_state }),
    ...(opts.lease && { lease: opts.lease }),
    ...(opts.parent_msg_id && { parent_msg_id: opts.parent_msg_id }),
    ...(opts.scene && { scene: opts.scene }),
  };
}

/**
 * Create a task message (root → manager).
 * Tasks are proposals — they do NOT carry leases. Managers must request
 * a lease from root before executing.
 */
function createTask(from, to, content, opts = {}) {
  return createMessage({ from, to, type: 'task', content, ...opts });
}

/**
 * Create a lease request (manager → root).
 * Manager proposes a concrete device action and asks root for authorization.
 */
function createLeaseRequest(from, content, opts = {}) {
  return createMessage({ from, to: 'rupert', type: 'lease_request', content, ...opts });
}

/**
 * Create a lease grant (root → manager).
 * Root approves the action and attaches a signed lease.
 */
function createLeaseGrant(to, content, lease, parentMsgId, opts = {}) {
  return createMessage({
    from: 'rupert', to, type: 'lease_grant', content,
    lease, parent_msg_id: parentMsgId, ...opts,
  });
}

/**
 * Create a lease denial (root → manager).
 */
function createLeaseDenied(to, content, parentMsgId, opts = {}) {
  return createMessage({
    from: 'rupert', to, type: 'lease_denied', content,
    parent_msg_id: parentMsgId, ...opts,
  });
}

/**
 * Create an execute message (manager → device adapter).
 * MUST include a valid lease.
 */
function createExecute(from, content, lease, opts = {}) {
  if (!lease || !lease.lease_id) {
    throw new Error('Execute messages require a valid lease');
  }
  return createMessage({ from, to: 'device', type: 'execute', content, lease, ...opts });
}

/**
 * Create an execute result (manager → root, confirming actuation).
 */
function createExecuteResult(from, content, leaseId, opts = {}) {
  return createMessage({
    from, to: 'rupert', type: 'execute_result', content,
    ...(leaseId && { lease: { lease_id: leaseId } }),
    ...opts,
  });
}

/**
 * Create a response message (manager → root).
 */
function createResponse(from, to, content, parentMsgId, opts = {}) {
  return createMessage({ from, to, type: 'response', content, parent_msg_id: parentMsgId, ...opts });
}

/**
 * Create a conflict alert (dewey → root).
 */
function createConflict(content, opts = {}) {
  return createMessage({
    from: 'dewey', to: 'rupert', type: 'conflict', content, ...opts,
  });
}

/**
 * Create a rejection (root or dewey → sender).
 */
function createRejection(from, to, content, parentMsgId, opts = {}) {
  return createMessage({
    from, to, type: 'rejection', content,
    parent_msg_id: parentMsgId, ...opts,
  });
}

/**
 * Create a resolution (root → broadcast).
 */
function createResolution(content, parentMsgId, opts = {}) {
  return createMessage({
    from: 'rupert', to: 'broadcast', type: 'resolution', content,
    parent_msg_id: parentMsgId, ...opts,
  });
}

module.exports = {
  createMessage,
  createTask,
  createLeaseRequest,
  createLeaseGrant,
  createLeaseDenied,
  createExecute,
  createExecuteResult,
  createResponse,
  createConflict,
  createRejection,
  createResolution,
};
