// What the TV remembers about the computer it paired with. The token is a
// LAN credential for that one computer and lives with the rest of the TV's
// settings in localStorage.

const COMPANION_KEY = "harbor.tizen.companion";
const DEVICE_KEY = "harbor.tizen.deviceId";

export type SavedCompanion = {
  instanceId: string;
  host: string;
  name: string;
  token: string;
  /** The streaming server address pairing wrote, so a later move only replaces its own value. */
  serverUrl: string;
};

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadCompanion(storage: KeyValue | null = store()): SavedCompanion | null {
  try {
    const raw = storage?.getItem(COMPANION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedCompanion>;
    if (typeof v.instanceId !== "string" || typeof v.host !== "string") return null;
    if (typeof v.token !== "string") return null;
    return {
      instanceId: v.instanceId,
      host: v.host,
      name: typeof v.name === "string" ? v.name : "Harbor",
      token: v.token,
      serverUrl: typeof v.serverUrl === "string" ? v.serverUrl : "",
    };
  } catch {
    return null;
  }
}

export function saveCompanion(value: SavedCompanion, storage: KeyValue | null = store()): void {
  try {
    storage?.setItem(COMPANION_KEY, JSON.stringify(value));
  } catch {
    /* A full quota costs the re-find at the next boot, nothing else. */
  }
}

export function clearCompanion(storage: KeyValue | null = store()): void {
  try {
    storage?.removeItem(COMPANION_KEY);
  } catch {
    /* noop */
  }
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stable id for this TV, so pairing again replaces the old entry on the computer. */
export function deviceId(storage: KeyValue | null = store()): string {
  try {
    const existing = storage?.getItem(DEVICE_KEY);
    if (existing && /^tv-[0-9a-f]{16}$/.test(existing)) return existing;
  } catch {
    /* fall through and mint one */
  }
  const id = `tv-${randomHex(8)}`;
  try {
    storage?.setItem(DEVICE_KEY, id);
  } catch {
    /* an unsaved id still pairs; the computer lists it twice at worst */
  }
  return id;
}
