'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
	CONN_REFUSED_DELAY_MS,
	FIRST_RECOVERY_DELAY_MS,
	SUBSEQUENT_RECOVERY_DELAY_MS,
	isConnRefusedErrorMessage,
	getBackendRecoveryDelayMs,
} = require('../../lib/backend-recovery-delay');

describe('Backend Recovery Delay Policy', () => {
	it('detects ECONNREFUSED messages', () => {
		assert.equal(isConnRefusedErrorMessage('connect ECONNREFUSED 192.168.1.29:8080'), true);
		assert.equal(isConnRefusedErrorMessage('CONNECT econnrefused upstream'), true);
		assert.equal(isConnRefusedErrorMessage('aborted'), false);
		assert.equal(isConnRefusedErrorMessage(''), false);
	});

	it('always returns ECONNREFUSED delay when refusal is detected', () => {
		assert.equal(getBackendRecoveryDelayMs('connect ECONNREFUSED 127.0.0.1:8080', 0), CONN_REFUSED_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('connect ECONNREFUSED 127.0.0.1:8080', 1), CONN_REFUSED_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('connect ECONNREFUSED 127.0.0.1:8080', 999), CONN_REFUSED_DELAY_MS);
	});

	it('returns immediate delay for first non-refused recovery attempt', () => {
		assert.equal(getBackendRecoveryDelayMs('aborted', 0), FIRST_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('HTTP 503', 0), FIRST_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('', 0), FIRST_RECOVERY_DELAY_MS);
	});

	it('returns 100ms for subsequent non-refused recovery attempts', () => {
		assert.equal(getBackendRecoveryDelayMs('aborted', 1), SUBSEQUENT_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('HTTP 500', 2), SUBSEQUENT_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('socket hang up', 200), SUBSEQUENT_RECOVERY_DELAY_MS);
	});

	it('treats invalid attempt values as first attempt for safety', () => {
		assert.equal(getBackendRecoveryDelayMs('aborted', NaN), FIRST_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('aborted', undefined), FIRST_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('aborted', -5), FIRST_RECOVERY_DELAY_MS);
		assert.equal(getBackendRecoveryDelayMs('aborted', 0.9), FIRST_RECOVERY_DELAY_MS);
	});
});
