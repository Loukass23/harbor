import { markTelevision } from "@/lib/platform";
import { safeFetch } from "@/lib/safe-fetch";
import { setBpPlatform } from "@/views/big-picture/bp-platform";
import { createTizenBpPlatform } from "./bp-platform";
import { createKeyTranslator, installKeyAdapter, registerRemoteKeys } from "./keys";
import { installLifecycle } from "./lifecycle";
import { tizenApi, type TvInputDevice } from "./tizen-api";

function tryRegister(input: TvInputDevice): Map<number, string> {
  try {
    return registerRemoteKeys(input);
  } catch (err) {
    console.error("[tizen] remote key registration failed", err);
    return new Map();
  }
}

/** Wires the TV into the shared app. Call before mountTvApp(). */
export function installTizenPlatform(): void {
  markTelevision();
  // Back works without the Tizen API, so the adapter goes in first and alone.
  const names = new Map<number, string>();
  installKeyAdapter(window, createKeyTranslator(names));
  installLifecycle(document);

  const tizen = tizenApi();
  setBpPlatform(
    createTizenBpPlatform(
      safeFetch,
      tizen ? () => tizen.application.getCurrentApplication().exit() : undefined,
    ),
  );
  if (!tizen) {
    console.warn("[tizen] tizen API missing: media keys and app exit are disabled");
    return;
  }
  const fill = () => {
    for (const [code, name] of tryRegister(tizen.tvinputdevice)) names.set(code, name);
  };
  fill();
  // Registration can fail silently this early in the page's life. Repeating it
  // once the page has loaded is harmless.
  window.addEventListener("load", fill, { once: true });
}
