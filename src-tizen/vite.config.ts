import { readFileSync } from "node:fs";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import rootConfig from "../vite.config";

// Tizen build: the same index-tv.html and app as Android TV, packaged as a .wgt
// that the TV loads over file://. Kept apart from the root config so upstream
// edits there never conflict with this target.

const ENTRY = '<script type="module" src="/src/main-tv.tsx"></script>';
const TIZEN_ENTRY = '<script type="module" src="/src-tizen/main.tsx"></script>';

function tizenHtml(): Plugin[] {
  const watchdog = readFileSync(new URL("./boot-watchdog.js", import.meta.url), "utf8");
  return [
    {
      name: "harbor-tizen-entry",
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          if (!html.includes(ENTRY)) {
            throw new Error(
              `index-tv.html no longer contains ${ENTRY}; update src-tizen/vite.config.ts`,
            );
          }
          const inlined = `<head>\n<script>\n${watchdog}</script>`;
          return html.replace(ENTRY, TIZEN_ENTRY).replace("<head>", inlined);
        },
      },
    },
    {
      name: "harbor-tizen-file-urls",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          // A crossorigin attribute on a file:// asset blocks it and the TV boots black.
          const out = html.replace(/<(?:script|link)\b[^>]*>/g, (tag) =>
            /\s(?:src|href)="\.\//.test(tag)
              ? tag.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'))?/, "")
              : tag,
          );
          // An absolute path resolves to the filesystem root under file://.
          const absolute = out.match(/\s(?:src|href)="\/(?!\/)[^"]*"/g);
          if (absolute) {
            throw new Error(`absolute asset paths break file:// loading: ${absolute.join(", ")}`);
          }
          return out;
        },
      },
    },
  ];
}

export default defineConfig(async (env) => {
  const base: UserConfig =
    typeof rootConfig === "function" ? await rootConfig(env) : await rootConfig;
  return {
    ...base,
    base: "./",
    plugins: [...(base.plugins ?? []), ...tizenHtml()],
    build: {
      outDir: "src-tizen/dist",
      emptyOutDir: true,
      // Tizen 9.0 ships Chromium 120. Its own floor, independent of Android TV.
      target: "chrome120",
      // Vite's runtime preloader marks the <link> tags it injects for lazy
      // chunks crossorigin, which the HTML transform above cannot reach. With
      // one stylesheet and no module preload it has nothing left to inject.
      modulePreload: false,
      cssCodeSplit: false,
      rollupOptions: { input: { tv: "index-tv.html" } },
    },
  };
});
