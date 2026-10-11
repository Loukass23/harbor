import type { TvInputDevice } from "./tizen-api";

// Remote keys the app reacts to. Registering a key takes it from the system,
// so only keys with a handler in the shared app are listed. Back is always
// delivered and needs no registration.
export const REMOTE_KEYS = [
  "MediaPlayPause",
  "MediaPlay",
  "MediaPause",
  "MediaStop",
  "MediaFastForward",
  "MediaRewind",
  "MediaTrackPrevious",
  "MediaTrackNext",
];

export const BACK_KEYCODE = 10009;
export const BACK_DEBOUNCE_MS = 250;

/** Registers the remote keys the TV supports and returns their keyCode → key name map. */
export function registerRemoteKeys(input: TvInputDevice): Map<number, string> {
  const keys = input.getSupportedKeys().filter((k) => REMOTE_KEYS.includes(k.name));
  const names = keys.map((k) => k.name);
  if (input.registerKeyBatch) {
    input.registerKeyBatch(names, null, (err) => console.warn("[tizen] registerKeyBatch", err));
  } else {
    for (const name of names) {
      try {
        input.registerKey(name);
      } catch (err) {
        console.warn(`[tizen] registerKey ${name}`, err);
      }
    }
  }
  return new Map(keys.map((k) => [k.code, k.name]));
}

type KeyLike = { type: string; key: string; keyCode: number; repeat: boolean };

export type KeyAction =
  | { kind: "pass" }
  | { kind: "drop" }
  | { kind: "send"; key: string; keyCode: number };

/**
 * Maps Tizen remote events onto the keys the shared app already handles.
 *
 * Back arrives as keyCode 10009 (`XF86Back`). It becomes Escape, the key every
 * Big Picture layer closes on, so overlays, dialogs and the root exit confirm
 * all work unchanged. Only this keydown is used: `tizenhwkey` fires for the
 * same press and is ignored. Repeats and presses inside 250ms are dropped, or
 * one press closes the overlay and the layer under it.
 */
export function createKeyTranslator(names: ReadonlyMap<number, string>) {
  let lastBack = Number.NEGATIVE_INFINITY;
  return (e: KeyLike, now: number): KeyAction => {
    if (e.keyCode === BACK_KEYCODE) {
      if (e.type !== "keydown" || e.repeat || now - lastBack < BACK_DEBOUNCE_MS) {
        return { kind: "drop" };
      }
      lastBack = now;
      return { kind: "send", key: "Escape", keyCode: 27 };
    }
    const name = names.get(e.keyCode);
    if (!name || e.key === name) return { kind: "pass" };
    return { kind: "send", key: name, keyCode: e.keyCode };
  };
}

/**
 * Installs the translator ahead of every app listener: it must be the first
 * capture listener on window, so call it before the app mounts.
 */
export function installKeyAdapter(win: Window, translate: ReturnType<typeof createKeyTranslator>) {
  const onKey = (e: KeyboardEvent) => {
    const action = translate(e, performance.now());
    if (action.kind === "pass") return;
    // Also stops the webview's own Back navigation, which can close the app.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action.kind === "drop") return;
    const target = e.target instanceof EventTarget ? e.target : win.document;
    target.dispatchEvent(
      new KeyboardEvent(e.type, {
        key: action.key,
        code: action.key,
        keyCode: action.keyCode,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  };
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("keyup", onKey, true);
}
