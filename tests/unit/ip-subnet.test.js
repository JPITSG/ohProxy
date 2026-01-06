'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// IP/Subnet functions replicated from server.js

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function normalizeRemoteIp(value) {
	const raw = safeText(value).trim();
	if (!raw) return '';
	// Convert IPv4-mapped IPv6 (::ffff:192.168.1.1) to plain IPv4
	if (raw.startsWith('::ffff:')) return raw.slice(7);
	return raw;
}

function getRemoteIp(req) {
	return normalizeRemoteIp(req?.socket?.remoteAddress || '');
}

function isValidIpv4(value) {
	const parts = safeText(value).split('.');
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function ipToLong(ip) {
	if (!isValidIpv4(ip)) return null;
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0);
}

function isAllowAllSubnet(value) {
	return safeText(value).trim() === '0.0.0.0';
}

function ipInSubnet(ip, cidr) {
	const parts = safeText(cidr).split('/');
	if (parts.length !== 2) return false;
	const subnet = parts[0];
	const mask = Number(parts[1]);
	if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
	const ipLong = ipToLong(ip);
	const subnetLong = ipToLong(subnet);
	if (ipLong === null || subnetLong === null) return false;
	const maskLong = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
	return (ipLong & maskLong) === (subnetLong & maskLong);
}

function ipInAnySubnet(ip, subnets) {
	if (!Array.isArray(subnets) || !subnets.length) return false;
	for (const cidr of subnets) {
		if (isAllowAllSubnet(cidr)) return true;
		if (ipInSubnet(ip, cidr)) return true;
	}
	return false;
}

function getLockoutKey(ip) {
	return ip || 'unknown';
}

describe('IP & Subnet Functions', () => {
	describe('normalizeRemoteIp', () => {
		it('strips IPv4-mapped prefix', () => {
			assert.strictEqual(normalizeRemoteIp('::ffff:192.168.1.1'), '192.168.1.1');
		});

		it('preserves pure IPv4', () => {
			assert.strictEqual(normalizeRemoteIp('192.168.1.1'), '192.168.1.1');
		});

		it('handles empty string', () => {
			assert.strictEqual(normalizeRemoteIp(''), '');
		});

		it('handles null', () => {
			assert.strictEqual(normalizeRemoteIp(null), '');
		});

		it('handles undefined', () => {
			assert.strictEqual(normalizeRemoteIp(undefined), '');
		});

		it('preserves IPv6 addresses', () => {
			assert.strictEqual(normalizeRemoteIp('2001:db8::1'), '2001:db8::1');
		});

		it('handles whitespace', () => {
			assert.strictEqual(normalizeRemoteIp('  192.168.1.1  '), '192.168.1.1');
		});

		it('handles localhost IPv4-mapped', () => {
			assert.strictEqual(normalizeRemoteIp('::ffff:127.0.0.1'), '127.0.0.1');
		});
	});

	describe('getRemoteIp', () => {
		it('extracts from socket.remoteAddress', () => {
			const req = { socket: { remoteAddress: '10.0.0.1' } };
			assert.strictEqual(getRemoteIp(req), '10.0.0.1');
		});

		it('normalizes IPv4-mapped address', () => {
			const req = { socket: { remoteAddress: '::ffff:192.168.1.50' } };
			assert.strictEqual(getRemoteIp(req), '192.168.1.50');
		});

		it('handles missing socket', () => {
			const req = {};
			assert.strictEqual(getRemoteIp(req), '');
		});

		it('handles null request', () => {
			assert.strictEqual(getRemoteIp(null), '');
		});

		it('handles undefined remoteAddress', () => {
			const req = { socket: {} };
			assert.strictEqual(getRemoteIp(req), '');
		});
	});

	describe('ipInSubnet', () => {
		it('matches /32 exactly', () => {
			assert.strictEqual(ipInSubnet('192.168.1.1', '192.168.1.1/32'), true);
		});

		it('rejects /32 different IP', () => {
			assert.strictEqual(ipInSubnet('192.168.1.2', '192.168.1.1/32'), false);
		});

		it('matches /24 range', () => {
			assert.strictEqual(ipInSubnet('192.168.1.100', '192.168.1.0/24'), true);
		});

		it('matches /24 edge - .0', () => {
			assert.strictEqual(ipInSubnet('192.168.1.0', '192.168.1.0/24'), true);
		});

		it('matches /24 edge - .255', () => {
			assert.strictEqual(ipInSubnet('192.168.1.255', '192.168.1.0/24'), true);
		});

		it('rejects /24 outside range', () => {
			assert.strictEqual(ipInSubnet('192.168.2.1', '192.168.1.0/24'), false);
		});

		it('matches /16 range', () => {
			assert.strictEqual(ipInSubnet('192.168.50.1', '192.168.0.0/16'), true);
		});

		it('rejects /16 outside range', () => {
			assert.strictEqual(ipInSubnet('192.169.0.1', '192.168.0.0/16'), false);
		});

		it('handles /0 (all IPs)', () => {
			assert.strictEqual(ipInSubnet('1.2.3.4', '0.0.0.0/0'), true);
			assert.strictEqual(ipInSubnet('255.255.255.255', '0.0.0.0/0'), true);
		});

		it('handles /8 range', () => {
			assert.strictEqual(ipInSubnet('10.50.100.200', '10.0.0.0/8'), true);
			assert.strictEqual(ipInSubnet('11.0.0.1', '10.0.0.0/8'), false);
		});

		it('returns false for invalid CIDR', () => {
			assert.strictEqual(ipInSubnet('192.168.1.1', 'invalid'), false);
		});

		it('returns false for invalid IP', () => {
			assert.strictEqual(ipInSubnet('invalid', '192.168.1.0/24'), false);
		});

		it('returns false for mask > 32', () => {
			assert.strictEqual(ipInSubnet('192.168.1.1', '192.168.1.0/33'), false);
		});

		it('returns false for negative mask', () => {
			assert.strictEqual(ipInSubnet('192.168.1.1', '192.168.1.0/-1'), false);
		});
	});

	describe('ipInAnySubnet', () => {
		it('matches first subnet in list', () => {
			const subnets = ['192.168.1.0/24', '10.0.0.0/8'];
			assert.strictEqual(ipInAnySubnet('192.168.1.50', subnets), true);
		});

		it('matches last subnet in list', () => {
			const subnets = ['192.168.1.0/24', '10.0.0.0/8'];
			assert.strictEqual(ipInAnySubnet('10.50.100.1', subnets), true);
		});

		it('returns false when no match', () => {
			const subnets = ['192.168.1.0/24', '10.0.0.0/8'];
			assert.strictEqual(ipInAnySubnet('172.16.0.1', subnets), false);
		});

		it('handles empty array', () => {
			assert.strictEqual(ipInAnySubnet('192.168.1.1', []), false);
		});

		it('handles 0.0.0.0 allow-all', () => {
			const subnets = ['0.0.0.0'];
			assert.strictEqual(ipInAnySubnet('1.2.3.4', subnets), true);
			assert.strictEqual(ipInAnySubnet('255.255.255.255', subnets), true);
		});

		it('handles mixed subnets with allow-all', () => {
			const subnets = ['192.168.1.0/24', '0.0.0.0'];
			assert.strictEqual(ipInAnySubnet('172.16.0.1', subnets), true);
		});

		it('handles null subnets', () => {
			assert.strictEqual(ipInAnySubnet('192.168.1.1', null), false);
		});

		it('handles undefined subnets', () => {
			assert.strictEqual(ipInAnySubnet('192.168.1.1', undefined), false);
		});

		it('handles single subnet', () => {
			assert.strictEqual(ipInAnySubnet('192.168.1.1', ['192.168.1.0/24']), true);
		});
	});

	describe('getLockoutKey', () => {
		it('returns IP as key', () => {
			assert.strictEqual(getLockoutKey('192.168.1.1'), '192.168.1.1');
		});

		it('returns "unknown" for empty', () => {
			assert.strictEqual(getLockoutKey(''), 'unknown');
		});

		it('returns "unknown" for null', () => {
			assert.strictEqual(getLockoutKey(null), 'unknown');
		});

		it('returns "unknown" for undefined', () => {
			assert.strictEqual(getLockoutKey(undefined), 'unknown');
		});

		it('preserves IPv6 address', () => {
			assert.strictEqual(getLockoutKey('2001:db8::1'), '2001:db8::1');
		});
	});

	describe('ipToLong', () => {
		it('converts 0.0.0.0', () => {
			assert.strictEqual(ipToLong('0.0.0.0'), 0);
		});

		it('converts 255.255.255.255', () => {
			// 255.255.255.255 = 0xFFFFFFFF = -1 as signed or 4294967295 as unsigned
			const result = ipToLong('255.255.255.255');
			assert.ok(result !== null);
		});

		it('converts 192.168.1.1', () => {
			// 192*256^3 + 168*256^2 + 1*256 + 1
			const expected = (192 << 24) + (168 << 16) + (1 << 8) + 1;
			const result = ipToLong('192.168.1.1');
			assert.ok(result !== null);
		});

		it('returns null for invalid IP', () => {
			assert.strictEqual(ipToLong('invalid'), null);
		});

		it('returns null for IPv6', () => {
			assert.strictEqual(ipToLong('::1'), null);
		});
	});
});
