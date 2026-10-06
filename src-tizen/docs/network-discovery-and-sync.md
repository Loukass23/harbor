# Tizen TV Network Discovery & Sync Features

## Overview

The Harbor Tizen TV application needs to discover and connect to Harbor Desktop instances running on the local network. This establishes the foundation for core synchronization features:

1. **Together (Watch Parties)**: Syncing playback state and interactions across devices.
2. **Casting Receiver**: Allowing the TV to act as a target for media cast from the Desktop or mobile remote.

## Implementation Strategy

Tizen Web Applications run in a sandboxed Chromium-based environment with strict network capability restrictions. Because of this, the TV app relies on an **HTTP Subnet Sweep** strategy to discover the Desktop server instead of standard UDP multicast.

### 1. Privileges

To calculate the local subnet, the application must determine its own IP address and subnet mask. This requires declaring the Samsung-specific public network privilege in `config.xml`:

```xml
<tizen:privilege name="http://developer.samsung.com/privilege/network.public"></tizen:privilege>
```

_(Note: The standard `http://tizen.org/privilege/internet` is insufficient for querying local network topology)._

### 2. HTTP Subnet Sweep

The TV discovers the Harbor Desktop server (which runs an Axum WebSocket server on port `11471`) by sweeping the local subnet:

- The app uses `webapis.network.getIp()` and `webapis.network.getSubnetMask()` to determine the local IP range.
- It iterates through the IP range (e.g., `.1` to `.254`), executing a `fetch` request to `http://<ip>:11471/api/remote`.
- **Important Polyfill**: Older Tizen browser versions do not support `AbortSignal.timeout()`. The sweep safely falls back to `AbortController` and `setTimeout(..., 500)` to fail fast on unresponsive IPs.
- A `400 Bad Request` (or `200 OK`) response confirms the presence of Harbor Desktop, as the `/api/remote` endpoint expects a WebSocket upgrade.

### 3. Connection & Pairing

Once the Desktop IP is identified, the TV app connects via a standard WebSocket to `ws://<desktop-ip>:11471/api/remote`. The TV app then operates as a remote client compatible with standard Harbor sync commands. UX validation matches standard Harbor conventions (e.g., no intrusive toasts, relying on in-UI connection states if present).

## Architecture Divergences

### Divergence from Android (Mobile/Android TV)

- **Permissions**: Android requires explicit manifest permissions (`ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, and `CHANGE_WIFI_MULTICAST_STATE`) to resolve network topology.
- **Discovery Mechanism**: Android apps (via Tauri plugins or native code) have access to UDP sockets. An Android TV app can passively listen for `_harbor._tcp.local` mDNS broadcasts natively, eliminating the need for a brute-force subnet sweep.
- **Cleartext Traffic Policies**: Modern Android enforces `usesCleartextTraffic="false"` by default, aggressively blocking `ws://` and `http://` connections to local IPs. Tizen's browser environment allows local cleartext connections as long as `<access origin="*" />` is defined in `config.xml`.

### Divergence from Desktop

- **Topology Role (Server vs. Client)**: Harbor Desktop acts as the central host, running an `axum` server on `0.0.0.0:11471` and actively announcing itself using the `mdns-sd` Rust crate. The Tizen app is structurally confined to a client role; it cannot bind to listen ports.
- **Casting Protocol**: The Desktop app uses the bundled `rust_cast` library to discover and push to DLNA/UPnP, Chromecast, AirPlay, and Roku. The Tizen TV app cannot perform outgoing native casts and serves purely as a passive display node brokered by the Desktop server.
