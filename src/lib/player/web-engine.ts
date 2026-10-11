import type { PlayerBridge } from "./bridge";

type WebEngineFactory = () => PlayerBridge;

let factory: WebEngineFactory | null = null;

/**
 * Replaces the in-webview player (the HTML5 bridge) on a platform whose webview
 * has a better decoder of its own. Wherever the player would build the HTML5
 * bridge, it builds this instead, and the rest of the player still treats it
 * as the "html5" engine. The bridge must keep the HTML5 bridge's snapshot
 * contract, and it falls back to the HTML5 bridge itself when it cannot play.
 * Pass null to restore the default.
 */
export function setWebPlayerEngine(next: WebEngineFactory | null): void {
  factory = next;
}

/** The platform's in-webview engine, or null for the default HTML5 bridge. */
export function webPlayerEngine(): WebEngineFactory | null {
  return factory;
}
