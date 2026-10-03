/**
 * Samsung Smart View SDK / MultiScreen Framework (MSF) Client
 *
 * Enables direct LAN discovery, app launch, and communication with
 * Samsung Smart TVs running Tizen via the Smart View REST and WebSocket APIs.
 */

export interface SamsungTvInfo {
  id: string;
  name: string;
  model?: string;
  modelName?: string;
  ip: string;
  uri: string;
  raw: Record<string, unknown>;
}

export interface SmartViewMessage {
  event: string;
  data?: unknown;
}

/**
 * Probes a given IP address on the standard Smart View port 8001
 * to check if an active Samsung Smart TV is reachable.
 */
export async function probeSamsungTv(ip: string, timeoutMs = 3000): Promise<SamsungTvInfo | null> {
  const url = `http://${ip}:8001/api/v2/`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const device = (json.device as Record<string, string>) || {};
    return {
      id: json.id || device.duid || ip,
      name: json.name || device.modelName || "Samsung Smart TV",
      model: device.model,
      modelName: device.modelName,
      ip,
      uri: url,
      raw: json,
    };
  } catch {
    return null;
  }
}

/**
 * Launches the Harbor Tizen application on the TV using Smart View REST API.
 */
export async function launchSamsungTvApp(
  tvIp: string,
  appId = "harborstrm.app",
  timeoutMs = 4000,
): Promise<boolean> {
  const url = `http://${tvIp}:8001/api/v2/applications/${appId}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200 || res.status === 201;
  } catch (e) {
    console.warn("[SmartView] Failed to launch TV app:", e);
    return false;
  }
}

/**
 * Creates a WebSocket channel to a Samsung TV receiver using MSF.
 */
export function connectSamsungTvChannel(
  tvIp: string,
  channelId = "samsung.smartview.harbor",
  clientName = "HarborSender",
  onMessage?: (msg: SmartViewMessage) => void,
): {
  send: (event: string, data?: unknown) => void;
  close: () => void;
} {
  const wsUrl = `ws://${tvIp}:8001/api/v2/channels/${channelId}?name=${encodeURIComponent(clientName)}`;
  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data));
        onMessage?.(parsed);
      } catch {}
    };
    ws.onerror = (err) => {
      console.warn("[SmartView] Channel socket error:", err);
    };
  } catch (err) {
    console.warn("[SmartView] Channel socket construction error:", err);
  }

  return {
    send: (event: string, data?: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, data }));
      }
    },
    close: () => {
      closed = true;
      try {
        ws?.close();
      } catch {}
      ws = null;
    },
  };
}
