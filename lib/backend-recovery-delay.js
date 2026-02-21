'use strict';

const CONN_REFUSED_DELAY_MS = 20000;
const FIRST_RECOVERY_DELAY_MS = 0;
const SUBSEQUENT_RECOVERY_DELAY_MS = 100;

function isConnRefusedErrorMessage(errorMessage) {
	const text = errorMessage === null || errorMessage === undefined ? '' : String(errorMessage);
	return /\bECONNREFUSED\b/i.test(text);
}

function getBackendRecoveryDelayMs(lastErrorMessage, recoveryAttemptInOutage) {
	if (isConnRefusedErrorMessage(lastErrorMessage)) {
		return CONN_REFUSED_DELAY_MS;
	}
	const attempt = Number.isFinite(Number(recoveryAttemptInOutage))
		? Math.max(0, Math.floor(Number(recoveryAttemptInOutage)))
		: 0;
	return attempt === 0 ? FIRST_RECOVERY_DELAY_MS : SUBSEQUENT_RECOVERY_DELAY_MS;
}

module.exports = {
	CONN_REFUSED_DELAY_MS,
	FIRST_RECOVERY_DELAY_MS,
	SUBSEQUENT_RECOVERY_DELAY_MS,
	isConnRefusedErrorMessage,
	getBackendRecoveryDelayMs,
};
