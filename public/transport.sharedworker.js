'use strict';

const sockets = new Map();
let nextPortId = 1;
const pausedPorts = new Set();

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function socketKey(portId, socketId) {
	return `${portId}:${socketId}`;
}

function normalizeProtocols(protocols) {
	if (!Array.isArray(protocols)) return [];
	const out = [];
	for (const entry of protocols) {
		const value = safeText(entry).trim();
		if (!value) continue;
		out.push(value);
	}
	return out;
}

function post(port, payload) {
	try {
		port.postMessage(payload);
	} catch {}
}

function cleanupSocket(key) {
	const record = sockets.get(key);
	if (!record) return;
	sockets.delete(key);
	try {
		record.ws.onopen = null;
		record.ws.onmessage = null;
		record.ws.onerror = null;
		record.ws.onclose = null;
	} catch {}
}

function browserSafeCloseCode(code) {
	// Browsers only permit close() with 1000 or 3000-4999; anything else throws
	// and would leave the socket dangling open with its handlers detached.
	return code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999) ? code : 1000;
}

function browserSafeCloseReason(reason) {
	// close() rejects reasons longer than 123 UTF-8 bytes.
	return safeText(reason).slice(0, 120);
}

function closeSocket(key, code, reason) {
	const record = sockets.get(key);
	if (!record) return;
	try {
		record.ws.close(browserSafeCloseCode(code), browserSafeCloseReason(reason));
	} catch {
		cleanupSocket(key);
	}
}

function forceCloseSocket(key, code, reason, notifyPort) {
	const record = sockets.get(key);
	if (!record) return;
	// Detach first so the eventual onclose cannot double-report, then tell the
	// owning page immediately so its socket facade never dangles half-open.
	cleanupSocket(key);
	if (notifyPort) {
		post(record.port, {
			type: 'transport-ws-event',
			id: record.socketId,
			event: 'close',
			code: Number(code) || 1001,
			reason: safeText(reason),
			wasClean: true,
		});
	}
	try {
		record.ws.close(browserSafeCloseCode(code), browserSafeCloseReason(reason));
	} catch {
		try { record.ws.close(); } catch {}
	}
}

function openSocket(portId, port, data) {
	const socketId = safeText(data?.id).trim();
	const targetUrl = safeText(data?.url).trim();
	if (!socketId || !targetUrl) return;
	if (pausedPorts.has(portId)) {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'close',
			code: 1001,
			reason: 'Transport paused',
			wasClean: true,
		});
		return;
	}
	const key = socketKey(portId, socketId);

	// Silent discard: the same id is being reopened, so a synthetic close
	// event would be misread as belonging to the replacement socket.
	forceCloseSocket(key, 1000, 'Replaced', false);

	const protocols = normalizeProtocols(data?.protocols);
	let ws;
	try {
		ws = protocols.length
			? new WebSocket(targetUrl, protocols)
			: new WebSocket(targetUrl);
	} catch (err) {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'error',
			message: safeText(err?.message || 'Failed to create WebSocket'),
		});
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'close',
			code: 1006,
			reason: 'Transport open failed',
			wasClean: false,
		});
		return;
	}

	sockets.set(key, { port, portId, socketId, ws });

	ws.onopen = () => {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'open',
			protocol: safeText(ws.protocol),
			extensions: safeText(ws.extensions),
		});
	};

	ws.onmessage = (event) => {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'message',
			data: event?.data,
		});
	};

	ws.onerror = (event) => {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'error',
			message: safeText(event?.message || ''),
		});
	};

	ws.onclose = (event) => {
		post(port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'close',
			code: event?.code || 1000,
			reason: safeText(event?.reason || ''),
			wasClean: event?.wasClean === true,
		});
		cleanupSocket(key);
	};
}

function sendSocket(portId, data) {
	const socketId = safeText(data?.id).trim();
	if (!socketId) return;
	const key = socketKey(portId, socketId);
	const record = sockets.get(key);
	if (!record) return;
	try {
		record.ws.send(data?.data);
	} catch (err) {
		post(record.port, {
			type: 'transport-ws-event',
			id: socketId,
			event: 'error',
			message: safeText(err?.message || 'WebSocket send failed'),
		});
	}
}

function closePortSockets(portId, code, reason, notifyPort) {
	const prefix = `${portId}:`;
	for (const key of Array.from(sockets.keys())) {
		if (!key.startsWith(prefix)) continue;
		forceCloseSocket(key, code, reason, notifyPort);
	}
}

self.onconnect = (connectEvent) => {
	const port = connectEvent?.ports?.[0];
	if (!port) return;
	const portId = nextPortId++;

	port.onmessage = (event) => {
		const data = event?.data || {};
		const type = safeText(data.type).trim();
		if (type === 'transport-worker-init') {
			post(port, { type: 'transport-worker-ack', portId });
			return;
		}
		if (type === 'transport-ws-open') {
			openSocket(portId, port, data);
			return;
		}
		if (type === 'transport-ws-send') {
			sendSocket(portId, data);
			return;
		}
		if (type === 'transport-ws-close') {
			const socketId = safeText(data?.id).trim();
			if (!socketId) return;
			const key = socketKey(portId, socketId);
			closeSocket(key, data?.code, data?.reason);
			return;
		}
		if (type === 'transport-ws-pause') {
			pausedPorts.add(portId);
			// Notify the page: its facade must observe the close so reconnect
			// logic starts cleanly on resume instead of sending into a void.
			closePortSockets(portId, 1001, safeText(data?.reason || 'Transport paused'), true);
			return;
		}
		if (type === 'transport-ws-resume') {
			pausedPorts.delete(portId);
			return;
		}
		if (type === 'transport-port-close') {
			closePortSockets(portId, 1001, 'Port closing', false);
		}
	};

	port.onmessageerror = () => {};
	port.addEventListener('close', () => {
		pausedPorts.delete(portId);
		closePortSockets(portId, 1001, 'Port closed', false);
	});
	port.start();
};
