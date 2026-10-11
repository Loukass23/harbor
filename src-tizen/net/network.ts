// The TV's own address, which the companion sweep works out its subnet from.
// Both APIs need the network.public privilege (config.xml.tpl). Each is
// feature-detected and may throw, so every call is guarded.

export type WebapisNetwork = {
  getIp?(): string;
  getSubnetMask?(): string;
};

type NetworkInfo = { ipAddress?: string; subnetMask?: string };

export type SystemInfo = {
  getPropertyValue(
    property: string,
    onSuccess: (info: NetworkInfo) => void,
    onError?: (err: unknown) => void,
  ): void;
};

export type NetworkEnv = {
  network?: WebapisNetwork | null;
  systeminfo?: SystemInfo | null;
};

export type LocalAddress = { ip: string; mask: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SYSTEMINFO_TIMEOUT_MS = 2000;

function toInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function toIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function usable(ip: string | undefined): ip is string {
  const n = ip ? toInt(ip) : null;
  return n !== null && n !== 0 && ip !== "127.0.0.1";
}

export function tizenNetworkEnv(): NetworkEnv {
  const g = globalThis as {
    webapis?: { network?: WebapisNetwork };
    tizen?: { systeminfo?: SystemInfo };
  };
  return { network: g.webapis?.network ?? null, systeminfo: g.tizen?.systeminfo ?? null };
}

function readSystemInfo(info: SystemInfo, property: string): Promise<NetworkInfo | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SYSTEMINFO_TIMEOUT_MS);
    const done = (v: NetworkInfo | null) => {
      clearTimeout(timer);
      resolve(v);
    };
    try {
      info.getPropertyValue(property, done, () => done(null));
    } catch {
      done(null);
    }
  });
}

/** The TV's IPv4 address and mask, or null when neither API answers. */
export async function localAddress(
  env: NetworkEnv = tizenNetworkEnv(),
): Promise<LocalAddress | null> {
  try {
    const ip = env.network?.getIp?.();
    if (usable(ip)) {
      let mask = "";
      try {
        mask = env.network?.getSubnetMask?.() ?? "";
      } catch {
        mask = "";
      }
      return { ip, mask };
    }
  } catch {
    /* fall through to systeminfo */
  }
  if (!env.systeminfo) return null;
  for (const property of ["ETHERNET_NETWORK", "WIFI_NETWORK"]) {
    const info = await readSystemInfo(env.systeminfo, property);
    if (usable(info?.ipAddress)) return { ip: info.ipAddress, mask: info.subnetMask ?? "" };
  }
  return null;
}

/**
 * Every other host on the TV's subnet, capped at a /24 so a wide mask never
 * turns into tens of thousands of requests. The /24 holds the TV, which is
 * where a home router puts its other devices.
 */
export function sweepHosts({ ip, mask }: LocalAddress): string[] {
  const self = toInt(ip);
  if (self === null) return [];
  const maskInt = toInt(mask);
  let bits = 24;
  if (maskInt !== null) {
    // A real mask is ones then zeros, so the host part plus one is a power of two.
    const host = ~maskInt >>> 0;
    if ((host & (host + 1)) === 0) {
      const prefix = 32 - Math.log2(host + 1);
      if (prefix > 24 && prefix <= 30) bits = prefix;
    }
  }
  const size = 2 ** (32 - bits);
  const network = Math.floor(self / size) * size;
  const hosts: string[] = [];
  for (let n = network + 1; n < network + size - 1; n += 1) {
    if (n !== self) hosts.push(toIp(n));
  }
  return hosts;
}
