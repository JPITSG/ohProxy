<?php
// Basic PHP reverse proxy for the openHAB modern wrapper.
// Example: https://example.com/path/ohProxy.php/... -> http://127.0.0.1:8081/...

$targetBase = '';
$configFile = __DIR__ . '/ohProxy.config.php';
if (is_file($configFile)) {
	include $configFile;
}

function requestScheme() {
	if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return 'https';
	if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) return $_SERVER['HTTP_X_FORWARDED_PROTO'];
	return 'http';
}

function ipInSubnet($ip, $cidr) {
	if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) return false;
	$parts = explode('/', $cidr);
	if (count($parts) !== 2) return false;
	$subnet = $parts[0];
	$mask = (int)$parts[1];
	if ($mask < 0 || $mask > 32) return false;
	$ipLong = ip2long($ip);
	$subnetLong = ip2long($subnet);
	if ($ipLong === false || $subnetLong === false) return false;
	$maskLong = $mask === 0 ? 0 : (-1 << (32 - $mask));
	return (($ipLong & $maskLong) === ($subnetLong & $maskLong));
}

function ipInAnySubnet($ip, $subnets) {
	if (!is_array($subnets) || empty($subnets)) return false;
	foreach ($subnets as $cidr) {
		$cidr = trim((string)$cidr);
		if ($cidr === '') continue;
		if (ipInSubnet($ip, $cidr)) return true;
	}
	return false;
}

function getClientIps() {
	$ips = [];
	if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
		$parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
		foreach ($parts as $part) {
			$ip = trim($part);
			if ($ip !== '') $ips[] = $ip;
		}
	}
	if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
		$ip = trim($_SERVER['HTTP_X_REAL_IP']);
		if ($ip !== '') $ips[] = $ip;
	}
	if (!empty($_SERVER['REMOTE_ADDR'])) {
		$ip = trim($_SERVER['REMOTE_ADDR']);
		if ($ip !== '') $ips[] = $ip;
	}
	$unique = [];
	foreach ($ips as $ip) {
		if (!in_array($ip, $unique, true)) $unique[] = $ip;
	}
	return $unique;
}

function parseBasicAuthHeader($value) {
	if (!$value) return [null, null];
	if (stripos($value, 'basic ') !== 0) return [null, null];
	$encoded = trim(substr($value, 6));
	$decoded = base64_decode($encoded, true);
	if ($decoded === false) return [null, null];
	$pos = strpos($decoded, ':');
	if ($pos === false) return [$decoded, ''];
	return [substr($decoded, 0, $pos), substr($decoded, $pos + 1)];
}

function base64UrlEncode($data) {
	return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64UrlDecode($data) {
	$raw = strtr($data, '-_', '+/');
	$pad = strlen($raw) % 4;
	if ($pad) $raw .= str_repeat('=', 4 - $pad);
	return base64_decode($raw, true);
}

function authCookiePath() {
	$script = $_SERVER['SCRIPT_NAME'] ?? '/';
	if ($script === '') return '/';
	return $script;
}

function configEndpointUrl($targetBase) {
	return rtrim($targetBase, '/') . '/ohproxy-config';
}

function readConfigStore($path) {
	if (!file_exists($path)) return null;
	$raw = @file_get_contents($path);
	if ($raw === false) {
		requireAuthConfigError();
	}
	$data = json_decode($raw, true);
	if (!is_array($data)) {
		requireAuthConfigError();
	}
	return $data;
}

function writeConfigStore($path, $store) {
	$payload = json_encode($store);
	if ($payload === false) {
		requireAuthConfigError();
	}
	$result = @file_put_contents($path, $payload, LOCK_EX);
	if ($result === false) {
		requireAuthConfigError();
	}
}

function normalizeStringList($list) {
	if (!is_array($list)) return null;
	$out = [];
	foreach ($list as $item) {
		$item = trim((string)$item);
		if ($item === '') continue;
		$out[] = $item;
	}
	return $out;
}

function normalizeOhProxySettings($settings) {
	if (!is_array($settings)) return null;
	$connectTimeout = isset($settings['connectTimeout']) ? (int)$settings['connectTimeout'] : 0;
	$requestTimeout = isset($settings['requestTimeout']) ? (int)$settings['requestTimeout'] : 0;
	$usersFile = trim((string)($settings['usersFile'] ?? ''));
	$whitelistSubnets = normalizeStringList($settings['whitelistSubnets'] ?? null);
	$authCookieName = trim((string)($settings['authCookieName'] ?? ''));
	$authCookieDays = isset($settings['authCookieDays']) ? (int)$settings['authCookieDays'] : 0;
	$authCookieKey = trim((string)($settings['authCookieKey'] ?? ''));
	$authFailNotifyCmd = $settings['authFailNotifyCmd'] ?? '';
	$authFailNotifyCmd = is_string($authFailNotifyCmd) ? trim($authFailNotifyCmd) : '';
	$authFailNotifyCooldown = isset($settings['authFailNotifyCooldown'])
		? (int)$settings['authFailNotifyCooldown']
		: 0;
	$configTtlSeconds = isset($settings['configTtlSeconds']) ? (int)$settings['configTtlSeconds'] : 0;

	if ($connectTimeout <= 0 || $requestTimeout <= 0) return null;
	if ($usersFile === '' || $authCookieName === '' || $authCookieKey === '') return null;
	if (!is_array($whitelistSubnets)) return null;
	if ($authCookieDays <= 0) return null;
	if ($configTtlSeconds <= 0) return null;
	if ($authFailNotifyCooldown < 0) return null;

	return [
		'connectTimeout' => $connectTimeout,
		'requestTimeout' => $requestTimeout,
		'usersFile' => $usersFile,
		'whitelistSubnets' => $whitelistSubnets,
		'authCookieName' => $authCookieName,
		'authCookieDays' => $authCookieDays,
		'authCookieKey' => $authCookieKey,
		'authFailNotifyCmd' => $authFailNotifyCmd,
		'authFailNotifyCooldown' => $authFailNotifyCooldown,
		'configTtlSeconds' => $configTtlSeconds,
	];
}

function fetchOhProxySettings($endpoint) {
	$context = stream_context_create([
		'http' => [
			'timeout' => 5,
			'ignore_errors' => true,
		],
	]);
	$raw = @file_get_contents($endpoint, false, $context);
	if ($raw === false) return null;
	if (isset($http_response_header) && is_array($http_response_header)) {
		foreach ($http_response_header as $header) {
			if (preg_match('/^HTTP\\/\\S+\\s+(\\d+)/', $header, $m)) {
				$code = (int)$m[1];
				if ($code >= 400) return null;
				break;
			}
		}
	}
	$data = json_decode($raw, true);
	if (!is_array($data)) return null;
	if (empty($data['version']) || (int)$data['version'] < 1) return null;
	$settings = $data['settings'] ?? null;
	return normalizeOhProxySettings($settings);
}

function loadOhProxyStore($targetBase, $storePath) {
	$store = readConfigStore($storePath);
	$existing = null;
	if ($store !== null) {
		if (!isset($store['settings']) || !isset($store['fetchedAt'])) {
			requireAuthConfigError();
		}
		$existing = normalizeOhProxySettings($store['settings']);
		if ($existing === null) {
			requireAuthConfigError();
		}
		$fetchedAt = (int)$store['fetchedAt'];
		if ($fetchedAt <= 0) {
			requireAuthConfigError();
		}
		$ttl = (int)$existing['configTtlSeconds'];
		if ($ttl <= 0) {
			requireAuthConfigError();
		}
		if ((time() - $fetchedAt) < $ttl) {
			$store['settings'] = $existing;
			$store['notifyLastAt'] = isset($store['notifyLastAt']) ? (int)$store['notifyLastAt'] : 0;
			return $store;
		}
	}

	$endpoint = configEndpointUrl($targetBase);
	$settings = fetchOhProxySettings($endpoint);
	if ($settings === null) {
		requireAuthConfigError();
	}
	$notifyLastAt = $store !== null && isset($store['notifyLastAt'])
		? (int)$store['notifyLastAt']
		: 0;
	$newStore = [
		'fetchedAt' => time(),
		'settings' => $settings,
		'notifyLastAt' => $notifyLastAt,
	];
	writeConfigStore($storePath, $newStore);
	return $newStore;
}

function sendAuthFailNotify($command, $cooldownSeconds, $clientIp, &$store, $storePath) {
	$cmd = trim((string)$command);
	if ($cmd === '' || $cmd === '0') return;
	$now = time();
	$last = isset($store['notifyLastAt']) ? (int)$store['notifyLastAt'] : 0;
	if ($cooldownSeconds > 0 && $last > 0 && ($now - $last) < $cooldownSeconds) return;
	$ip = trim((string)$clientIp);
	$cmd = str_replace('{IP}', $ip !== '' ? $ip : 'unknown', $cmd);
	$store['notifyLastAt'] = $now;
	writeConfigStore($storePath, $store);
	exec($cmd . ' 2>&1 >/dev/null &');
}

function buildAuthCookieValue($user, $pass, $key, $expiry) {
	$userEncoded = base64UrlEncode($user);
	$payload = $userEncoded . '|' . $expiry;
	$sig = hash_hmac('sha256', $payload . '|' . $pass, $key);
	return base64UrlEncode($payload . '|' . $sig);
}

function getAuthCookieUser($name, $users, $key) {
	if (empty($_COOKIE[$name])) return null;
	$decoded = base64UrlDecode($_COOKIE[$name]);
	if ($decoded === false) return null;
	$parts = explode('|', $decoded);
	if (count($parts) < 3) return null;

	// Handle both new format (3 parts, username encoded) and legacy format (3+ parts if username had pipes)
	$sig = array_pop($parts);
	$expiry = array_pop($parts);
	$userPart = implode('|', $parts); // Reassemble in case legacy username had pipes

	if ($userPart === '' || !preg_match('/^\d+$/', $expiry)) return null;
	$expiry = (int)$expiry;
	if ($expiry < time()) return null;

	// Try new format first: userPart is base64-encoded username
	$userDecoded = base64UrlDecode($userPart);
	if ($userDecoded !== false && $userDecoded !== '' && array_key_exists($userDecoded, $users)) {
		$payload = $userPart . '|' . $expiry;
		$expected = hash_hmac('sha256', $payload . '|' . $users[$userDecoded], $key);
		if (hash_equals($expected, $sig)) return $userDecoded;
	}

	// Fall back to legacy format: userPart is plain username
	if (array_key_exists($userPart, $users)) {
		$payload = $userPart . '|' . $expiry;
		$expected = hash_hmac('sha256', $payload . '|' . $users[$userPart], $key);
		if (hash_equals($expected, $sig)) return $userPart;
	}

	return null;
}

function setAuthCookie($name, $user, $pass, $key, $days) {
	$expiry = time() + ((int)$days * 86400);
	$value = buildAuthCookieValue($user, $pass, $key, $expiry);
	$options = [
		'expires' => $expiry,
		'path' => authCookiePath(),
		'secure' => requestScheme() === 'https',
		'httponly' => true,
		'samesite' => 'Lax',
	];
	setcookie($name, $value, $options);
}

function clearAuthCookie($name) {
	$options = [
		'expires' => time() - 3600,
		'path' => authCookiePath(),
		'secure' => requestScheme() === 'https',
		'httponly' => true,
		'samesite' => 'Lax',
	];
	setcookie($name, '', $options);
}

function getBasicAuthCredentials() {
	if (!empty($_SERVER['PHP_AUTH_USER'])) {
		return [$_SERVER['PHP_AUTH_USER'], $_SERVER['PHP_AUTH_PW'] ?? ''];
	}
	if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
		return parseBasicAuthHeader($_SERVER['HTTP_AUTHORIZATION']);
	}
	if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
		return parseBasicAuthHeader($_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
	}
	if (function_exists('getallheaders')) {
		$headers = getallheaders();
		if (is_array($headers)) {
			foreach ($headers as $name => $value) {
				if (strcasecmp($name, 'Authorization') === 0) {
					return parseBasicAuthHeader($value);
				}
			}
		}
	}
	return [null, null];
}

function loadAuthUsers($path) {
	if (!is_readable($path)) return null;
	$lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
	if ($lines === false) return null;
	$users = [];
	foreach ($lines as $line) {
		$line = trim($line);
		if ($line === '' || $line[0] === '#' || strpos($line, '//') === 0) continue;
		$pos = strpos($line, ':');
		if ($pos === false) $pos = strpos($line, '=');
		if ($pos === false) continue;
		$user = trim(substr($line, 0, $pos));
		$passPart = trim(substr($line, $pos + 1));
		$commaPos = strpos($passPart, ',');
		$pass = $commaPos === false ? $passPart : trim(substr($passPart, 0, $commaPos));
		if ($user === '') continue;
		$users[$user] = $pass;
	}
	return $users;
}

function requireBasicAuth() {
	header('WWW-Authenticate: Basic realm="openHAB Proxy"');
	header('HTTP/1.1 401 Unauthorized');
	echo 'Unauthorized';
	exit;
}

function requireAuthConfigError() {
	header('HTTP/1.1 500 Internal Server Error');
	header('Content-Type: text/plain');
	echo 'Auth config unavailable';
	exit;
}

function proxyBaseUrl() {
	$scheme = requestScheme();
	$host = $_SERVER['HTTP_HOST'] ?? 'localhost';
	$script = $_SERVER['SCRIPT_NAME'] ?? '';
	return $scheme . '://' . $host . $script;
}

function hopByHopHeaders() {
	return [
		'connection' => true,
		'keep-alive' => true,
		'proxy-authenticate' => true,
		'proxy-authorization' => true,
		'te' => true,
		'trailer' => true,
		'transfer-encoding' => true,
		'upgrade' => true,
		'content-length' => true,
	];
}

function getRequestHeadersSafe() {
	if (function_exists('getallheaders')) {
		return getallheaders();
	}
	$headers = [];
	foreach ($_SERVER as $key => $value) {
		if (strpos($key, 'HTTP_') === 0) {
			$name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($key, 5)))));
			$headers[$name] = $value;
		}
	}
	if (!empty($_SERVER['CONTENT_TYPE']) && !isset($headers['Content-Type'])) {
		$headers['Content-Type'] = $_SERVER['CONTENT_TYPE'];
	}
	if (!empty($_SERVER['CONTENT_LENGTH']) && !isset($headers['Content-Length'])) {
		$headers['Content-Length'] = $_SERVER['CONTENT_LENGTH'];
	}
	return $headers;
}

function buildTargetUrl($targetBase) {
	$targetBase = rtrim($targetBase, '/');
	$path = '';
	if (!empty($_SERVER['PATH_INFO'])) {
		$path = $_SERVER['PATH_INFO'];
	} else {
		$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
		$scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
		if ($scriptName && strpos($uriPath, $scriptName) === 0) {
			$path = substr($uriPath, strlen($scriptName));
		} else {
			$path = $uriPath;
		}
	}
	if ($path === '' || $path === false) $path = '/';
	if ($path[0] !== '/') $path = '/' . $path;
	$query = $_SERVER['QUERY_STRING'] ?? '';
	$url = $targetBase . $path;
	if ($query !== '') $url .= '?' . $query;
	return $url;
}

function rewriteLocation($location, $targetBase, $proxyBase) {
	if (strpos($location, '/') === 0) {
		return $proxyBase . $location;
	}
	$targetParts = parse_url($targetBase);
	$locationParts = parse_url($location);
	if ($targetParts === false || $locationParts === false) return $location;
	if (empty($targetParts['host']) || empty($locationParts['host'])) return $location;
	if (strcasecmp($targetParts['host'], $locationParts['host']) !== 0) return $location;

	$targetScheme = strtolower($targetParts['scheme'] ?? 'http');
	$locationScheme = strtolower($locationParts['scheme'] ?? $targetScheme);
	$targetPort = $targetParts['port'] ?? ($targetScheme === 'https' ? 443 : 80);
	$locationPort = $locationParts['port'] ?? ($locationScheme === 'https' ? 443 : 80);
	if ((string)$targetPort !== (string)$locationPort) return $location;

	$path = $locationParts['path'] ?? '/';
	$query = isset($locationParts['query']) ? '?' . $locationParts['query'] : '';
	return $proxyBase . $path . $query;
}

if ($targetBase === '') {
	requireAuthConfigError();
}
$configStorePath = '/tmp/ohProxy.conf';
$ohProxyStore = loadOhProxyStore($targetBase, $configStorePath);
$settings = $ohProxyStore['settings'] ?? null;
if (!is_array($settings)) {
	requireAuthConfigError();
}
$connectTimeout = $settings['connectTimeout'];
$requestTimeout = $settings['requestTimeout'];
$usersFile = $settings['usersFile'];
$whitelistSubnets = $settings['whitelistSubnets'];
$authCookieName = $settings['authCookieName'];
$authCookieDays = $settings['authCookieDays'];
$authCookieKey = $settings['authCookieKey'];
$authFailNotifyCmd = $settings['authFailNotifyCmd'];
$authFailNotifyCooldown = $settings['authFailNotifyCooldown'];

$clientIps = getClientIps();
$clientIpHeader = $_SERVER['REMOTE_ADDR'] ?? '';
if ($clientIpHeader === '' && !empty($clientIps)) $clientIpHeader = $clientIps[0];
$authState = 'unauthenticated';
$authHeaderUser = '';
header('X-OhProxy-ClientIP: ' . $clientIpHeader);
header('X-OhProxy-Auth: ' . $authState);
$requiresAuth = empty($clientIps);
foreach ($clientIps as $ip) {
	if (!ipInAnySubnet($ip, $whitelistSubnets)) {
		$requiresAuth = true;
		break;
	}
}
if ($requiresAuth) {
	$users = loadAuthUsers($usersFile);
	if ($users === null) {
		requireAuthConfigError();
	}
	if (empty($users)) {
		requireAuthConfigError();
	}
	list($authUser, $authPass) = getBasicAuthCredentials();
	$authenticatedUser = null;
	$cookieUser = null;
	if (!$authUser) {
		$cookieUser = getAuthCookieUser($authCookieName, $users, $authCookieKey);
		if (!$cookieUser && !empty($_COOKIE[$authCookieName])) {
			clearAuthCookie($authCookieName);
		}
	}
	if ($authUser) {
		if (!array_key_exists($authUser, $users) || $users[$authUser] !== $authPass) {
			sendAuthFailNotify(
				$authFailNotifyCmd,
				$authFailNotifyCooldown,
				$clientIpHeader,
				$ohProxyStore,
				$configStorePath
			);
			requireBasicAuth();
		}
		$authenticatedUser = $authUser;
	} elseif ($cookieUser) {
		$authenticatedUser = $cookieUser;
	} else {
		requireBasicAuth();
	}
	setAuthCookie(
		$authCookieName,
		$authenticatedUser,
		$users[$authenticatedUser],
		$authCookieKey,
		$authCookieDays
	);
	$authState = 'authenticated';
	header('X-OhProxy-Auth: ' . $authState);
	$authHeaderUser = str_replace(["\r", "\n"], '', $authenticatedUser);
	header('X-OhProxy-User: ' . $authHeaderUser);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$targetUrl = buildTargetUrl($targetBase);
$proxyBase = proxyBaseUrl();

$requestUri = $_SERVER['REQUEST_URI'] ?? '';
$requestPath = parse_url($requestUri, PHP_URL_PATH) ?: '';
$scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
if (empty($_SERVER['PATH_INFO']) && $requestPath !== '' && $requestPath === $scriptName) {
	$query = $_SERVER['QUERY_STRING'] ?? '';
	$redirect = $requestPath . '/';
	if ($query !== '') $redirect .= '?' . $query;
	header('Location: ' . $redirect, true, 301);
	exit;
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $connectTimeout);
curl_setopt($ch, CURLOPT_TIMEOUT, $requestTimeout);

$headers = getRequestHeadersSafe();
$hop = hopByHopHeaders();
$forwardHeaders = [];
foreach ($headers as $name => $value) {
	$lower = strtolower($name);
	if (isset($hop[$lower])) continue;
	if ($lower === 'host') continue;
	if ($lower === 'x-forwarded-for') {
		continue;
	}
	$forwardHeaders[] = $name . ': ' . $value;
}

$forwardHeaders[] = 'X-Forwarded-Proto: ' . requestScheme();
$forwardHeaders[] = 'X-OhProxy-ClientIP: ' . str_replace(["\r", "\n"], '', $clientIpHeader);
$forwardHeaders[] = 'X-OhProxy-Auth: ' . str_replace(["\r", "\n"], '', $authState);
if ($authState === 'authenticated' && $authHeaderUser !== '') {
	$forwardHeaders[] = 'X-OhProxy-User: ' . $authHeaderUser;
}
curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);

if ($method === 'HEAD') {
	curl_setopt($ch, CURLOPT_NOBODY, true);
} else {
	$body = file_get_contents('php://input');
	if ($body !== '' && $body !== false) {
		curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
	}
}

curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $headerLine) use ($targetBase, $proxyBase, $hop) {
	$len = strlen($headerLine);
	$trim = trim($headerLine);
	if ($trim === '') return $len;
	if (stripos($trim, 'HTTP/') === 0) {
		if (preg_match('/\\s(\\d{3})\\s/', $trim, $m)) {
			http_response_code((int)$m[1]);
		}
		return $len;
	}
	$parts = explode(':', $trim, 2);
	if (count($parts) !== 2) return $len;
	$name = trim($parts[0]);
	$value = trim($parts[1]);
	$value = str_replace(["\r", "\n"], '', $value);
	$lower = strtolower($name);
	if (isset($hop[$lower])) return $len;
	if ($lower === 'location') {
		$value = rewriteLocation($value, $targetBase, $proxyBase);
	}
	header($name . ': ' . $value, false);
	return $len;
});

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) {
	echo $data;
	return strlen($data);
});

$ok = curl_exec($ch);
if ($ok === false) {
	if (!headers_sent()) {
		http_response_code(502);
		header('Content-Type: text/plain');
	}
	error_log('ohProxy cURL error: ' . curl_error($ch));
	echo 'Proxy error';
}

curl_close($ch);
