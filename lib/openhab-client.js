'use strict';

const http = require('http');
const https = require('https');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function safeNumber(value, fallback = 0) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function buildOpenhabAuthHeader({ apiToken = '', user = '', pass = '' } = {}) {
	const token = safeText(apiToken);
	if (token) return `Bearer ${token}`;
	const username = safeText(user);
	const password = safeText(pass);
	if (!username || !password) return null;
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function buildRequestPath(target, pathname) {
	const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
	const relPath = safeText(pathname);
	if (!relPath) return basePath || '/';
	return `${basePath}${relPath.startsWith('/') ? relPath : `/${relPath}`}`;
}

function toRequestBody(body) {
	if (body === null || body === undefined) return null;
	if (Buffer.isBuffer(body)) return body;
	if (typeof body === 'string') return body;
	return String(body);
}

function hasHeader(headers, name) {
	const lower = String(name || '').toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function buildOpenhabClient(options = {}) {
	const baseTarget = safeText(options.target || 'http://localhost:8080');
	const baseUser = safeText(options.user || '');
	const basePass = safeText(options.pass || '');
	const baseApiToken = safeText(options.apiToken || '');
	const baseUserAgent = safeText(options.userAgent || 'ohProxy/1.0');
	const baseTimeoutMs = safeNumber(options.timeoutMs, 0);
	const baseAgent = options.agent;

	function request(pathname, reqOptions = {}) {
		return new Promise((resolve, reject) => {
			let target;
			try {
				target = new URL(baseTarget);
			} catch (err) {
				reject(err);
				return;
			}

			const isHttps = target.protocol === 'https:';
			const client = isHttps ? https : http;
			const method = safeText(reqOptions.method || 'GET').toUpperCase() || 'GET';
			const requestPath = buildRequestPath(target, pathname);
			const timeoutMs = safeNumber(reqOptions.timeoutMs, baseTimeoutMs);
			const timeoutLabel = safeText(reqOptions.timeoutLabel || 'request') || 'request';
			const requestBody = toRequestBody(reqOptions.body);

			const headers = { ...(reqOptions.headers || {}) };
			if (!hasHeader(headers, 'Accept')) {
				headers.Accept = safeText(reqOptions.accept || 'application/json');
			}
			if (!hasHeader(headers, 'User-Agent')) {
				headers['User-Agent'] = baseUserAgent;
			}
			const authHeader = buildOpenhabAuthHeader({
				apiToken: reqOptions.apiToken ?? baseApiToken,
				user: reqOptions.user ?? baseUser,
				pass: reqOptions.pass ?? basePass,
			});
			if (authHeader && !hasHeader(headers, 'Authorization')) {
				headers.Authorization = authHeader;
			}
			if (requestBody !== null && !hasHeader(headers, 'Content-Length')) {
				headers['Content-Length'] = Buffer.byteLength(requestBody);
			}

			const resolvedAgent = typeof baseAgent === 'function' ? baseAgent() : baseAgent;
			const req = client.request({
				method,
				hostname: target.hostname,
				port: target.port || (isHttps ? 443 : 80),
				path: requestPath,
				headers,
				agent: resolvedAgent,
			}, (res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => { body += chunk; });
				res.on('error', reject);
				res.on('end', () => {
					const status = res.statusCode || 500;
					const ok = status >= 200 && status < 300;
					if (reqOptions.throwOnHttpError && !ok) {
						reject(new Error(`HTTP ${status}: ${body}`));
						return;
					}
					if (reqOptions.parseJson) {
						try {
							const parsed = JSON.parse(body);
							resolve({ status, ok, body, json: parsed });
							return;
						} catch {
							reject(new Error('Non-JSON response from openHAB'));
							return;
						}
					}
					resolve({ status, ok, body, json: null });
				});
			});

			if (timeoutMs > 0) {
				req.setTimeout(timeoutMs, () => {
					req.destroy(new Error(`${timeoutLabel} timed out`));
				});
			}
			req.on('error', reject);
			if (requestBody !== null) req.write(requestBody);
			req.end();
		});
	}

	function get(pathname, options = {}) {
		return request(pathname, { ...options, method: 'GET' });
	}

	function post(pathname, body, options = {}) {
		return request(pathname, { ...options, method: 'POST', body });
	}

	return { request, get, post };
}

module.exports = {
	buildOpenhabAuthHeader,
	buildOpenhabClient,
};
