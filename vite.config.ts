import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

declare const process: { env: Record<string, string | undefined> };

function silenceMediapipeSourcemap() {
  return {
    name: "silence-mediapipe-sourcemap",
    enforce: "pre" as const,
    load(id: string) {
      const file = id.split("?")[0];
      if (file.includes("@mediapipe") && file.endsWith(".mjs")) {
        const code = readFileSync(file, "utf-8").replace(/\/\/#\s*sourceMappingURL=[^\n]*/g, "");
        return { code, map: null };
      }
      return null;
    },
  };
}

function servePublicMediapipe() {
  return {
    name: "serve-public-mediapipe",
    apply: "serve" as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!path.startsWith("/mp-wasm/") || path.includes("..") || !path.endsWith(".js")) {
          next();
          return;
        }
        let body: Buffer;
        try {
          body = readFileSync(`${server.config.root}/public${path}`);
        } catch {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(body);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const android = mode === "android" || process.env.HARBOR_TARGET === "android";
  const tizen = mode === "tizen" || process.env.HARBOR_TARGET === "tizen";
  const devHost = process.env.TAURI_DEV_HOST;
  return {
    base: tizen ? "./" : "/",
    publicDir: tizen ? false : "public",
    staged: { "*": "vp check --fix" },
    plugins: [
      react(),
      tailwindcss(),
      silenceMediapipeSourcemap(),
      servePublicMediapipe(),
      ...(tizen
        ? [
            {
              name: "tizen-remove-crossorigin",
              transformIndexHtml(html: string) {
                return html.replace(/\s*crossorigin(="[^"]*")?/g, "");
              },
            },
          ]
        : []),
    ],
    clearScreen: false,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // P3: lets shared modules drop desktop-only payload imports (awards
      // JSON) from the TV graph at build time — rollup folds the dead
      // branch, so the chunk is never emitted for tizen.
      __HARBOR_TV_BUILD__: JSON.stringify(tizen),
      __IS_BETA_BUILD__: JSON.stringify(process.env.HARBOR_CHANNEL !== "stable"),
      __BUILD_ID__: JSON.stringify(
        process.env.HARBOR_BUILD_ID ||
          (() => {
            try {
              return execSync("git rev-parse --short HEAD").toString().trim();
            } catch {
              return "local";
            }
          })(),
      ),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
      ...(process.env.VITE_HARBOR_SERVER_URL
        ? {
            "import.meta.env.VITE_HARBOR_SERVER_URL": JSON.stringify(
              process.env.VITE_HARBOR_SERVER_URL,
            ),
          }
        : {}),
    },
    // Both entries ship. index-tv.html is what the TV window loads; index.html
    // exists only so web_server.rs has a page to hand the phone for /remote,
    // which the QR hand-off in onboarding depends on. Listing tv alone left the
    // phone staring at "web assets are not available in this build".
    // Vite 7 defaults to baseline-widely-available, a chrome107 floor. Android
    // TV sticks and Fire TV ship a System WebView well below that, and the
    // failure is a bare SyntaxError before React mounts, with no error surface
    // on a device you cannot open devtools on. Pin a floor the hardware meets.
    // This lowers syntax only; esbuild adds no API polyfills.
    ...(tizen
      ? {
          build: {
            // Phase 4 — Tizen 9.0 ships a modern Chromium: target esnext to
            // drop legacy polyfills/transpiled helpers from the TV bundle.
            target: "esnext",
            // Inline critical shell assets (boot mark, fonts CSS) as base64
            // so first paint never waits on extra asset round-trips.
            assetsInlineLimit: 16384,
            rollupOptions: {
              input: { tv: "index-tv.html" },
              output: {
                // Aggressive manual chunking: the shell boots on react-core
                // alone; spatial D-pad navigation, the AVPlay media pipeline,
                // and heavy vendors defer until after first paint.
                manualChunks(id: string) {
                  if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
                    return "react-core";
                  }
                  // Spatial D-pad navigation engine — deferred module.
                  if (
                    id.includes("src/lib/keyboard-navigation") ||
                    id.includes("src/views/big-picture/bp-virtual-row") ||
                    id.includes("src/views/big-picture/bp-tv-gpu-nav")
                  ) {
                    return "tv-nav";
                  }
                  // AVPlay media pipeline (native bridge + off-thread
                  // stream selection) — deferred until playback starts.
                  if (
                    id.includes("src/lib/player/tizen-avplay") ||
                    id.includes("src/lib/tv-stream-select") ||
                    id.includes("src/workers/tv-stream-select")
                  ) {
                    return "avplay-pipeline";
                  }
                  if (id.includes("node_modules/@tanstack")) {
                    return "tanstack";
                  }
                  if (id.includes("node_modules/lucide-react")) {
                    return "icons";
                  }
                  if (id.includes("node_modules/lottie-web")) {
                    return "lottie";
                  }
                  if (id.includes("node_modules/hls.js") || id.includes("node_modules/mpegts.js")) {
                    // TV build: don't create a separate video-vendor chunk.
                    // The dynamic imports are guarded by __HARBOR_TV_BUILD__ and
                    // will be tree-shaken out; returning null lets them be
                    // bundled inline where the dead code eliminator removes them.
                    if (tizen) return null;
                    return "video-vendor";
                  }
                },
              },
            },
          },
        }
      : android
      ? {
          build: {
            target: "chrome87",
            rollupOptions: { input: { tv: "index-tv.html", main: "index.html" } },
          },
        }
      : {}),
    server: {
      host: devHost || "127.0.0.1",
      port: 1420,
      strictPort: true,
      ...(devHost ? { hmr: { protocol: "ws", host: devHost, port: 1421 } } : {}),
      watch: {
        ignored: [
          "**/src-tauri/**",
          "**/android-native/**",
          "**/android/**",
          "**/android-extension-compat/**",
          "**/.gradle/**",
          "**/target/**",
          "**/work/**",
          "**/scratchpad/**",
          "**/.firecrawl/**",
          "**/.diag/**",
          "**/_private/**",
          "**/harbor-install-recovery/**",
        ],
      },
      proxy: Object.fromEntries(
        [
          "graphql.anilist.co",
          "openlibrary.org",
          "covers.openlibrary.org",
          "www.googleapis.com",
          "www.wikidata.org",
          "api.deepseek.com",
        ].map((host) => [
          `/api-proxy/${host}`,
          {
            target: `https://${host}`,
            changeOrigin: true,
            rewrite: (path: string) => path.replace(`/api-proxy/${host}`, ""),
          },
        ]),
      ),
    },
    resolve: {
      // Tizen TV substitutes (P2): the X-Ray face engine pulls
      // onnxruntime-web (~13MB wasm), MediaPipe and desktop-only model
      // files that cannot run in the TV widget (publicDir is off for the
      // tizen build). The stub keeps the worker + hook contracts and
      // rejects with a clear message through the existing error channel.
      // Array form: first match wins, so the exact engine path resolves
      // before the "@" prefix.
      alias: tizen
        ? [
            {
              find: "@/lib/face/face-worker-engine",
              replacement: "/src/lib/face/face-worker-engine.tizen",
            },
            { find: "@", replacement: "/src" },
          ]
        : { "@": "/src" },
    },
    assetsInclude: ["**/*.onnx", "**/*.tflite"],
    optimizeDeps: {
      // Scan only app entries, not the installer or local HTML previews.
      entries: ["index.html", "index-tv.html"],
      // Reached only from a lazy route's own lazy child, so the scanner does not find it from an
      // entry. Discovered at runtime instead, it answers the first request with a 504 and a reload
      // the error boundary swallows, which strands that route until the dep cache is rebuilt.
      include: ["qrcode"],
      exclude: ["onnxruntime-web", "@mediapipe/tasks-vision"],
    },
    worker: { format: "es" },
  };
});
