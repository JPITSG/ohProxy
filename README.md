# ohProxy

A modern, secure reverse proxy and web interface for [openHAB](https://www.openhab.org/) **1.8.3**. ohProxy provides a responsive Progressive Web App (PWA) with real-time updates, touch-optimized controls, and comprehensive security features.

This project is designed specifically for **openHAB 1.8.3** and its REST API. It is not compatible with openHAB 2.x, 3.x, or 4.x which use a different REST API structure.

## Overview

ohProxy sits between your users and openHAB, providing:

- **Modern UI**: Glass-morphism design with dark/light themes
- **Mobile-first**: Touch gestures, haptic feedback, PWA installation
- **Security**: Authentication, IP allowlists, auth lockout, security headers
- **Real-time**: WebSocket updates with intelligent polling fallback
- **Offline support**: Service worker caching for reliable access

## Screenshots

### Desktop (3-column layout)

| Dark Mode | Light Mode |
|-----------|------------|
| ![Desktop Dark](docs/screenshots/desktop-dark.png) | ![Desktop Light](docs/screenshots/desktop-light.png) |

### Tablet (2-column layout)

| Dark Mode | Light Mode |
|-----------|------------|
| ![Tablet Dark](docs/screenshots/tablet-dark.png) | ![Tablet Light](docs/screenshots/tablet-light.png) |

### Phone (1-column layout)

| Dark Mode | Light Mode |
|-----------|------------|
| ![Phone Dark](docs/screenshots/phone-dark.png) | ![Phone Light](docs/screenshots/phone-light.png) |

## Features

### User Interface

#### Themes & Layout
- **Dark/Light modes** with automatic theme color updates
- **Responsive grid**: 1-column mobile, 2-column tablet, 3-column desktop
- **Header modes**: Full, small, or hidden header for different use cases
- **Slim mode**: Minimal UI optimized for constrained devices or embedded displays
- **Glass-morphism styling** with backdrop blur effects

#### Navigation
- **Navigation stack** through sitemap hierarchy (Back/Home)
- **Back/Home buttons** for quick navigation
- **Browser history integration** (back/forward buttons work naturally)
- **Dynamic page titles** showing current location

#### Search
- **Real-time full-text search** across all items
- **Multi-criteria matching**: Search by name, label, state, or type
- **Background indexing** of entire sitemap hierarchy
- **Grouped results** by navigation path

### Interactive Controls

| Widget Type | Features |
|-------------|----------|
| **Switch** | Single toggle or multi-option buttons with active state highlighting |
| **Selection** | Custom dropdown on desktop; native overlay picker on small/touch and slim layouts |
| **Slider/Dimmer** | Real-time value display, debounced updates, smart activation detection |
| **Image** | Auto-refresh, MJPEG streaming, zoomable overlay viewer |
| **Video** | RTSP to MP4 streaming via FFmpeg, full-width display, 16:9 aspect ratio, auto-reconnect |
| **Chart** | Proxied through ohProxy with TTL caching, responsive width, zoomable overlay viewer, auto-refresh |
| **Webview** | Embedded iframe, full-width display, 16:9 aspect ratio (or custom height), proxied URL |
| **Text** | State-only display items |
| **Navigation** | Links to sub-pages with visual indicators |

### Real-Time Updates

#### Dual Update Modes
- **Polling mode**: Configurable intervals for REST API polling
- **Atmosphere mode**: openHAB's long-polling for instant updates

#### Smart Polling
- **Active/Idle intervals**: Faster polling when user is active (default: 2s active, 10s idle)
- **Background detection**: Reduced polling when app is not focused
- **Manual pause/resume**: User-controlled polling suspension (enable with `?pause=true`)
- **Delta updates**: Only transmit changed fields to minimize bandwidth

#### WebSocket Support
- Automatic reconnection with fixed backoff
- Graceful fallback to polling after connection failures
- Focus-aware connection management

### Visual Effects

#### Glow Effects
- **Value color glow**: Items with openHAB valueColor display colored glow
- **Per-widget glow rules**: Admin-configurable rules stored in SQLite (Ctrl/Cmd+click a widget)
- **State-based glow**: Configure different colors based on item state
  - Example: Door sensors glow green when closed, red when open
- **Section targeting**: Apply glow effects only to specific sitemap sections

#### Visibility & Roles
- **Widget visibility rules**: Admins can set per-widget visibility (all/normal/admin), applied to UI and search
- **Roles**: `admin` can edit glow/visibility rules; `normal` and `readonly` are filtered by visibility rules (roles do not block item commands)

#### Animations
- Smooth page transitions with configurable fade timing
- Status indicator with connection state
- Resume spinner when returning from background

### Touch Device Features

- **Haptic feedback**: Vibration on button presses and interactions
- **Pull-to-refresh**: Pull down gesture with bounce (non-slim mode)
- **Touch-optimized menus**: Native selection overlays on small/touch and slim layouts

### Progressive Web App (PWA)

- **Installable**: Add to home screen on mobile devices
- **Offline support**: Service worker caches critical assets
- **App-like experience**: Standalone display mode, theme colors
- **Automatic updates**: Version-based cache invalidation
- **Apple support**: Touch icons, status bar styling

### Security

#### Authentication
- **Dual auth modes**: HTTP Basic Auth or HTML form-based login (configurable)
- **CSRF protection**: Double-submit cookie pattern for HTML form auth
- **Cookie-based sessions**: Persistent login with signed HMAC cookies (configurable lifetime)
- **Auth lockout**: Automatic lockout after failed attempts (3 failures = 15-minute lockout)
- **Auth notifications**: Execute commands on failed auth attempts (e.g., send alerts)

#### Network Access Control
- **IP allowlists**: Restrict access to specific subnets (CIDR notation)

#### Security Headers
- **HSTS**: HTTP Strict Transport Security with configurable max-age
- **CSP**: Content Security Policy to prevent XSS attacks
- **Referrer-Policy**: Control referrer information leakage

#### TLS/HTTPS
- Native HTTPS support with certificate configuration
- Optional HTTP/2 support
- Secure context detection for PWA features

### Image Handling

- **Proxy endpoint**: Secure image proxying with domain allowlist
- **Icon caching**: PNG conversion and caching with ImageMagick
- **MJPEG streaming**: HTTP MJPEG streams proxied via `/proxy?url=` (allowlisted)
- **Responsive sizing**: Automatic width calculation based on viewport
- **Zoom viewer**: 90% viewport overlay with zoom toggle
- **Auto-refresh**: Configurable refresh intervals per image

### Session Management

- **SQLite-based storage**: Persistent session data with settings sync
- **Server-side settings**: User preferences synced across devices
- **Automatic cleanup**: Configurable max age (default 14 days)
- **CLI management tool**: List, inspect, modify, and purge sessions

### Logging & Diagnostics

- **Access logging**: Apache Combined Log format
- **Slow query logging**: Track requests exceeding configurable threshold
- **Configurable log levels**: Filter by status code (all or 400+ errors only)
- **Proxy middleware logging**: Debug upstream communication

## Installation

### Prerequisites

- Node.js 18+
- **openHAB 1.8.3** with REST API enabled
- ImageMagick (for icon conversion)
- (Optional) TLS certificates for HTTPS
- (Optional) MySQL/MariaDB for GPS presence map

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ohProxy.git
   cd ohProxy
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create configuration file:
   ```bash
   cp config.defaults.js config.local.js
   ```

4. Edit `config.local.js` with your settings (see [Configuration](#configuration))

5. Start the server:
   ```bash
   node server.js
   ```

### Running as a Service

Example systemd service file (`/etc/systemd/system/ohproxy.service`):

```ini
[Unit]
Description=ohProxy - openHAB Reverse Proxy
After=network.target

[Service]
Type=simple
User=openhab
WorkingDirectory=/opt/ohProxy
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Configuration

ohProxy uses a layered configuration system:
- `config.defaults.js`: Built-in defaults (don't modify)
- `config.local.js`: Your local overrides (deep-merged with defaults)
- Environment variables: Override sensitive values

### Config Reload

- Live config reload + auto-restart on `config.local.js` changes

### Server Configuration

```javascript
module.exports = {
  server: {
    http: {
      enabled: true,
      host: '0.0.0.0',
      port: 9080,
    },
    https: {
      enabled: true,
      http2: false,
      host: '0.0.0.0',
      port: 9443,
      certFile: '/path/to/fullchain.pem',
      keyFile: '/path/to/privkey.pem',
    },
    openhab: {
      target: 'http://localhost:8080',
      user: '',  // or use OH_USER env var
      pass: '',  // or use OH_PASS env var
    },
    allowSubnets: ['192.168.1.0/24', '10.0.0.0/8'],
    proxyAllowlist: ['camera.local:8080', 'example.com'],
  },
};
```

### Authentication Configuration

```javascript
module.exports = {
  server: {
    auth: {
      mode: 'basic',                     // 'basic' or 'html' (form login)
      realm: 'openHAB Proxy',            // Basic auth realm (basic mode only)
      cookieName: 'AuthStore',
      cookieDays: 365,                   // >0 required when cookieKey is set
      cookieKey: 'your-secret-key-here', // HMAC signing key
      authFailNotifyCmd: '/path/to/notify.sh {IP}',  // Optional
      authFailNotifyIntervalMins: 15,    // Optional rate limit
    },
    sessionMaxAgeDays: 14,               // Session cleanup threshold
  },
};
```

> **Note:** Users are managed via the `users-cli.js` utility (see [User Management](#user-management) below), not via config files.

### Security Headers Configuration

```javascript
module.exports = {
  server: {
    securityHeaders: {
      enabled: true,
      hsts: {
        enabled: true,
        maxAge: 31536000,
        includeSubDomains: true,
        preload: false,
      },
      csp: {
        enabled: true,
        reportOnly: false,
        policy: "default-src 'self'; img-src 'self' data: https: blob:; ...",
      },
      referrerPolicy: 'same-origin',
    },
  },
};
```

### Client Configuration

```javascript
module.exports = {
  client: {
    // Sections that display glow effects based on valueColor
    glowSections: ['Cameras', 'Device Information'],

    // State-based glow colors for specific sections
    stateGlowSections: [
      {
        section: 'Door Sensors',
        states: { Closed: 'green', Open: 'red' }
      },
    ],

    // Polling intervals (ms)
    pollIntervalsMs: {
      default: { active: 2000, idle: 10000 },
      slim: { active: 10000, idle: 20000 },
    },

    // UI timing (ms)
    pageFadeOutMs: 250,
    pageFadeInMs: 250,
    loadingDelayMs: 1000,
    idleAfterMs: 60000,

    // Image settings
    minImageRefreshMs: 5000,
    imageLoadTimeoutMs: 15000,

    // Hide titles for specific items
    hideTitleItems: ['Clock', 'Weather_Icon'],
  },
};
```

### WebSocket Configuration

```javascript
module.exports = {
  server: {
    websocket: {
      mode: 'polling',           // 'polling' or 'atmosphere'
      pollingIntervalMs: 500,    // Active polling interval
      pollingIntervalBgMs: 2000, // Background polling interval
    },
  },
};
```

### MySQL Configuration

ohProxy can optionally connect to a MySQL database to power additional features like the GPS presence map. The connection is established at startup and automatically reconnects on failure.

```javascript
module.exports = {
  server: {
    mysql: {
      socket: '/run/mysqld/mysqld.sock',  // Unix socket (if set, host/port ignored)
      host: '',                            // MySQL host (alternative to socket)
      port: '',                            // MySQL port (default: 3306)
      database: 'openhab',                 // Database name
      username: 'openhab',                 // MySQL username
      password: 'openhab',                 // MySQL password
    },
  },
};
```

**Connection options:**
- Use `socket` for local MySQL connections via Unix socket (recommended for performance)
- Use `host` and `port` for TCP connections (remote or local)
- If `socket` is set, `host` and `port` are ignored

**Logging:**
- `[MySQL] Connecting to {target}...` - Connection attempt
- `[MySQL] Connection to {target} established` - Successful connection
- `[MySQL] Connection to {target} failed: {error}` - Connection failure
- `[MySQL] Reconnecting to {target} in 5s...` - Auto-reconnect scheduled

If no `socket` or `host` is configured, the MySQL worker remains dormant.

### Asset Versioning

Update these versions to bust browser caches after changes:

```javascript
module.exports = {
  server: {
    assets: {
      jsVersion: 'v274',
      cssVersion: 'v229',
      appleTouchIconVersion: 'v200',
      iconVersion: 'v3',
    },
  },
};
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OH_TARGET` | openHAB target URL |
| `OH_USER` | openHAB basic auth username |
| `OH_PASS` | openHAB basic auth password |
| `ICON_VERSION` | override icon cache version |
| `USER_AGENT` | override proxy User-Agent |
| `PROXY_LOG_LEVEL` | override proxy middleware log level |
| `LOG_FILE` | override server log file path |
| `ACCESS_LOG` | override access log file path |
| `ACCESS_LOG_LEVEL` | override access log verbosity (`all` or `400+`) |
| `SITEMAP_REFRESH_MS` | override sitemap refresh interval (ms) |

## Usage

### URL Parameters

| Parameter | Values | Description |
|-----------|--------|-------------|
| `mode` | `dark`, `light` | Force theme mode |
| `slim` | `true` | Enable slim mode for minimal UI |
| `header` | `full`, `small`, `none` | Header display mode |
| `pause` | `true` | Show Pause/Resume button for polling |
| `fast` | `true` | Force fast mode (skip cache) and disable ping latency checks |

Examples:
```
https://your-proxy.com/?mode=dark
https://your-proxy.com/?slim=true&header=none
https://your-proxy.com/?mode=light&header=small
https://your-proxy.com/?pause=true
https://your-proxy.com/?fast=true
```

### Proxy Endpoint

Proxy external images through ohProxy (http/https only, with domain allowlist):

```
/proxy?url=https://allowed-domain.com/image.jpg
```

Configure allowed domains in `proxyAllowlist`:
```javascript
proxyAllowlist: [
  'example.com',
  'camera.local:8080',
],
```

### MJPEG Streams

For MJPEG camera streams, use a normal http/https URL in your openHAB sitemap (ohProxy will stream it via `/proxy?url=`). Ensure the host is in `proxyAllowlist`.

```
Image url="http://camera.local/stream"
```

### RTSP Streaming

ohProxy can convert RTSP streams to browser-playable MP4 via FFmpeg. Use the Video widget in your sitemap:

```
Video url="rtsp://user:pass@camera-ip:554/stream"
```

The RTSP host must be in `proxyAllowlist`:
```javascript
proxyAllowlist: [
  '192.168.1.40:554',  // camera IP:port
],
```

Features:
- Low-latency streaming (~1-2s with 1s keyframes)
- No transcoding (H264 passthrough)
- Auto-reconnect on stream errors
- FFmpeg process auto-terminates when client disconnects

Requirements:
- FFmpeg must be installed on the server

### Classic UI

Legacy openHAB Classic UI is proxied at `/openhab.app`, with a convenience redirect at `/classic`.

### GPS Presence Map

The `/presence` endpoint displays a map showing recent GPS location history. This requires MySQL to be configured (see [MySQL Configuration](#mysql-configuration)).

```
https://your-proxy.com/presence
```

**Features:**
- Displays last 20 GPS positions on an OpenLayers map with OSM tiles
- Most recent position marked with red marker, older positions in blue
- Consecutive duplicate coordinates are deduplicated
- Map centers on the most recent position at zoom level 15
- 10-second query timeout with graceful fallback

**Database Schema:**

The endpoint queries a `log_gps` table with the following structure:

```sql
CREATE TABLE log_gps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lat DECIMAL(10, 7) NOT NULL,
  lon DECIMAL(10, 7) NOT NULL,
  -- Additional columns are ignored
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | INT | Auto-increment primary key (used for ordering) |
| `lat` | DECIMAL(10,7) | Latitude coordinate |
| `lon` | DECIMAL(10,7) | Longitude coordinate |

**Error Responses:**
- `503` - Database connection unavailable (blank HTML page)
- `504` - Query timeout or failure (blank HTML page)

**Marker Images:**

The map expects marker images at:
- `/images/marker-red.png` - Current position
- `/images/marker-blue.png` - Historical positions

## User Management

Users are managed via the `users-cli.js` command-line utility. User data is stored in the SQLite database (`sessions.db`).

```bash
# List all users
node users-cli.js list

# Add a new user (roles: admin, normal, readonly)
node users-cli.js add alice mypassword normal

# Add an admin user
node users-cli.js add bob adminpass123 admin

# Change a user's password
node users-cli.js passwd alice newpassword

# Change a user's role
node users-cli.js role alice admin

# Delete a user (also removes their sessions)
node users-cli.js remove alice
```

Note: If the server is running, `users-cli.js` notifies it to disconnect active sessions on delete/password change.

**User Roles:**
- `admin` - Full access, can manage widget glow rules and visibility
- `normal` - Standard access; visibility rules apply
- `readonly` - Same visibility filtering as `normal` (role does not block item commands)

## Session CLI

Manage sessions from the command line:

```bash
# List all sessions
node session-cli.js list

# Show session details
node session-cli.js show <session_id>

# Update a session setting
node session-cli.js set <session_id> darkMode=true

# Delete a specific session
node session-cli.js delete <session_id>

# Run cleanup of expired sessions (uses sessionMaxAgeDays)
node session-cli.js cleanup

# Purge sessions older than a specific time
node session-cli.js purge 7days    # Also: Nsecs, Nmins, Nhours
```

## Browser Support

- Chrome/Edge 80+
- Firefox 75+
- Safari 13+
- iOS Safari 13+
- Android Chrome 80+

## Performance Tips

1. **Use Atmosphere mode** when openHAB supports it for lower latency (`server.websocket.mode = 'atmosphere'`)
2. **Enable slim mode** for embedded displays or low-power devices
3. **Tune polling intervals** based on your network and use case
4. **Use service worker** (HTTPS required) for offline resilience
5. **Configure delta cache** size based on number of pages browsed

## Testing

Run the test suite using Node.js built-in test runner:

```bash
# Run all tests
npm test

# Run specific test category
npm run test:unit
npm run test:integration
npm run test:security
```

Test categories:
- **Unit tests**: Utility functions, parsing, configuration validation
- **Integration tests**: Authentication flows, API endpoints, WebSocket handling
- **Security tests**: XSS prevention, CSRF protection, injection attacks, access control

## License

MIT License - See LICENSE file for details.
