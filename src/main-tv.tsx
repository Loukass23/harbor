import { mountTvApp } from "@/tv-mount";
import "@/index.css";

// The Android TV entry. index.html / main.tsx stay the desktop entry and must
// never import this file: pulling BpTvApp into that graph changes the desktop
// bundle, which is the one thing this build is not allowed to do.
//
// No pip, modal, hdr or remote branch here on purpose. Those are separate
// desktop windows, and Android has exactly one webview.

// No startup-ready ping here, and that is deliberate. Desktop sets
// visible:false on its window and reveals it from on_page_load inside the
// #[cfg(desktop)] run(); harbor_startup_ready only calls set_focus and is not
// registered in mobile.rs at all. Android is visible purely because
// tauri.android.conf.json replaces the whole windows array and omits the flag.
// Add visible:false there and the TV stays black forever, because none of the
// reveal machinery is compiled into the Android binary.

void mountTvApp();
