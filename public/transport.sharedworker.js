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

function closeSocket(key, code, reason) {
	const record = sockets.get(key);
	if (!record) return;
	try {
		record.ws.close(code, reason);
	} catch {
		cleanupSocket(key);
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

	closeSocket(key, 1000, 'Replaced');
	cleanupSocket(key);

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

function closePortSockets(portId, code, reason) {
	const prefix = `${portId}:`;
	for (const key of Array.from(sockets.keys())) {
		if (!key.startsWith(prefix)) continue;
		closeSocket(key, code, reason);
		cleanupSocket(key);
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
			closePortSockets(portId, 1001, safeText(data?.reason || 'Transport paused'));
			return;
		}
		if (type === 'transport-ws-resume') {
			pausedPorts.delete(portId);
			return;
		}
		if (type === 'transport-port-close') {
			closePortSockets(portId, 1001, 'Port closing');
		}
	};

	port.onmessageerror = () => {};
	port.addEventListener('close', () => {
		pausedPorts.delete(portId);
		closePortSockets(portId, 1001, 'Port closed');
	});
	port.start();
};
