# ohProxy

A modern, secure reverse proxy and web interface for [openHAB](https://www.openhab.org/). ohProxy provides a responsive Progressive Web App (PWA) with real-time updates, touch-optimized controls, and comprehensive security features.

## Overview

ohProxy sits between your users and openHAB, providing:

- **Modern UI**: Glass-morphism design with dark/light themes
- **Mobile-first**: Touch gestures, haptic feedback, PWA installation
- **Security**: Authentication, IP allowlists, auth lockout, security headers
- **Real-time**: WebSocket updates with intelligent polling fallback
- **Offline support**: Service worker caching for reliable access

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
| **Selection** | Native dropdown on desktop, custom touch menu on mobile, overlay in slim mode |
| **Slider/Dimmer** | Real-time value display, debounced updates, smart activation detection |
| **Roller Shutter** | UP/STOP/DOWN button controls |
| **Image** | Auto-refresh, MJPEG streaming, zoomable overlay viewer |
| **Text** | State-only display items |
| **Navigation** | Links to sub-pages with visual indicators |

### Real-Time Updates

#### Dual Update Modes
- **Polling mode**: Configurable intervals for REST API polling
- **Atmosphere mode**: openHAB's long-polling for instant updates

#### Smart Polling
- **Active/Idle intervals**: Faster polling when user is active (default: 2s active, 10s idle)
- **Background detection**: Reduced polling when app is not focused
- **Manual pause/resume**: User-controlled polling suspension
- **Delta updates**: Only transmit changed fields to minimize bandwidth

#### WebSocket Support
- Automatic reconnection with fixed backoff
- Graceful fallback to polling after connection failures
- Focus-aware connection management

### Visual Effects

#### Glow Effects
- **Value color glow**: Items with openHAB valueColor display colored glow
- **State-based glow**: Configure different colors based on item state
  - Example: Door sensors glow green when closed, red when open
- **Section targeting**: Apply glow effects only to specific sitemap sections

#### Animations
- Smooth page transitions with configurable fade timing
- Status indicator with connection state
- Pull-to-refresh with bounce animation (touch devices, non-slim mode)
- Resume spinner when returning from background

### Touch Device Features

- **Haptic feedback**: Vibration on button presses and interactions
- **Pull-to-refresh**: Pull down gesture to refresh current page (non-slim mode)
- **Resume spinner**: Loading indicator when app resumes from background
- **Touch-optimized menus**: Full-screen selection overlays in slim mode
- **Bounce-back animation**: Visual feedback during pull gestures

### Progressive Web App (PWA)

- **Installable**: Add to home screen on mobile devices
- **Offline support**: Service worker caches critical assets
- **App-like experience**: Standalone display mode, theme colors
- **Automatic updates**: Version-based cache invalidation
- **Apple support**: Touch icons, status bar styling

### Security

#### Authentication
- **HTTP Basic Auth** with simple user:password file
- **Cookie-based sessions**: Persistent login with signed HMAC cookies (configurable lifetime)
- **Auth lockout**: Automatic lockout after failed attempts (3 failures = 15-minute lockout)
- **Auth notifications**: Execute commands on failed auth attempts (e.g., send alerts)

#### Network Access Control
- **IP allowlists**: Restrict access to specific subnets (CIDR notation)
- **LAN bypass**: Skip authentication for local network requests
- **Whitelist subnets**: Trusted networks that bypass auth

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
- **MJPEG streaming**: Support for `mjpeg://` protocol URLs
- **Responsive sizing**: Automatic width calculation based on viewport
- **Zoom viewer**: 90% viewport overlay with zoom toggle
- **Auto-refresh**: Configurable refresh intervals per image

### Logging & Diagnostics

- **Access logging**: Apache Combined Log format
- **Slow query logging**: Track requests exceeding configurable threshold
- **Configurable log levels**: Filter by status code (all or 400+ errors only)
- **Proxy middleware logging**: Debug upstream communication

## Installation

### Prerequisites

- Node.js 18+
- openHAB instance with REST API enabled
- ImageMagick (for icon conversion)
- (Optional) TLS certificates for HTTPS

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
    lanSubnets: ['192.168.1.0/24'],
  },
};
```

### Authentication Configuration

```javascript
module.exports = {
  server: {
    auth: {
      usersFile: '/path/to/users.cfg',  // htpasswd format
      whitelistSubnets: [],              // Skip auth for these subnets
      realm: 'openHAB Proxy',
      cookieName: 'AuthStore',
      cookieDays: 365,                   // >0 required when cookieKey is set
      cookieKey: 'your-secret-key-here', // HMAC signing key
      authFailNotifyCmd: '/path/to/notify.sh {IP}',  // Optional
    },
  },
};
```

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

## Usage

### URL Parameters

| Parameter | Values | Description |
|-----------|--------|-------------|
| `mode` | `dark`, `light` | Force theme mode |
| `slim` | `true` | Enable slim mode for minimal UI |
| `header` | `full`, `small`, `none` | Header display mode |

Examples:
```
https://your-proxy.com/?mode=dark
https://your-proxy.com/?slim=true&header=none
https://your-proxy.com/?mode=light&header=small
```

### Proxy Endpoint

Proxy external images through ohProxy (with domain allowlist):

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

For MJPEG camera streams, use the `mjpeg://` protocol in your openHAB sitemap:

```
Image url="mjpeg://camera.local/stream"
```

## User File Format

The users file is a simple `username:password` (or `username=password`) format. Example:

```bash
echo "alice:secret" > /path/to/users.cfg
echo "bob:password123" >> /path/to/users.cfg
```

## Browser Support

- Chrome/Edge 80+
- Firefox 75+
- Safari 13+
- iOS Safari 13+
- Android Chrome 80+

## Performance Tips

1. **Use WebSocket mode** when openHAB supports Atmosphere for lower latency
2. **Enable slim mode** for embedded displays or low-power devices
3. **Tune polling intervals** based on your network and use case
4. **Use service worker** (HTTPS required) for offline resilience
5. **Configure delta cache** size based on number of pages browsed

## Troubleshooting

### Common Issues

**"Connection error" status**
- Verify openHAB is running and accessible
- Check `openhab.target` configuration
- Verify network/firewall allows connection

**Icons not loading**
- Ensure ImageMagick is installed (`convert` command available)
- Check icon cache directory permissions
- Verify openHAB icon URLs are accessible

**Authentication not working**
- Verify users file path and permissions
- Check htpasswd format is correct
- Ensure cookie key is set for persistent sessions

**WebSocket not connecting**
- Check browser console for connection errors
- Verify WebSocket upgrade is not blocked by proxy/firewall
- Try polling mode as fallback

### Debug Mode

Enable verbose proxy logging:
```javascript
proxyMiddlewareLogLevel: 'debug',
```

Enable slow query logging:
```javascript
slowQueryMs: 100,  // Log requests taking >100ms
```

## License

MIT License - See LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
