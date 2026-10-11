import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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
          // Samsung's webapis (AVPlay) exist only once the TV's own copy is
          // loaded. Added after bundling so Vite never tries to resolve it, and
          // after the inlined watchdog so a failure there is still reported.
          const at = out.indexOf("</script>");
          if (at < 0) throw new Error("boot watchdog script missing from index-tv.html");
          const end = at + "</script>".length;
          return `${out.slice(0, end)}\n<script src="$WEBAPIS/webapis/webapis.js"></script>${out.slice(end)}`;
        },
      },
    },
  ];
}

const slash = (p: string) => p.replace(/\\/g, "/");

// Shared modules the TV never runs, swapped for small stand-ins in build/.
// installTizenPlatform turns off the features that would have used them.
function tizenStubs(): Plugin {
  const faceStub = fileURLToPath(new URL("./build/face-engine.ts", import.meta.url));
  const emptyCatalog = fileURLToPath(new URL("./build/empty-catalog.ts", import.meta.url));
  return {
    name: "harbor-tizen-stubs",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!/face-engine$|\/locales\/[a-z]{2}$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = slash(resolved.id);
      if (id.endsWith("/src/lib/face/face-engine.ts")) return faceStub;
      const locale = /\/src\/lib\/i18n\/locales\/([a-z]{2})\.ts$/.exec(id);
      if (locale && locale[1] !== "en") return emptyCatalog;
      return null;
    },
    // The match above is on specifiers. One it misses would ship the real
    // module silently, so check what actually got bundled.
    generateBundle(_options, bundle) {
      const leaked =
        /\/src\/lib\/face\/face-engine\.ts$|\/src\/lib\/i18n\/locales\/(?!en[/.])[a-z]{2}[/.]/;
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        const id = Object.keys(item.modules)
          .map(slash)
          .find((m) => leaked.test(m));
        if (id) this.error(`${item.fileName} bundles ${id}, which the Tizen build stubs out`);
      }
    },
  };
}

// Entries of public/ the TV never loads, each with the text that would show up
// in the bundle if something started to. The face engine's wasm and models go
// with the stubbed engine; the rest belong to views outside Big Picture
// (mobile, manga, the desktop ebook reader) or to nothing at all.
const PUBLIC_EXCLUDED: Record<string, string> = {
  "mp-wasm": "mp-wasm",
  ort: "ort-wasm",
  models: "models/face",
  "explore-icons": "explore-icons",
  "mangahero.png": "mangahero",
  "nosources.png": "nosources",
  "remote-icons": "remote-icons",
  flipbook: "flipbook/",
  "ebook-hero-open-books.png": "ebook-hero-open-books",
  "reader-icons": "reader-icons",
  "universe-logos": "universe-logos",
  "manga-paper-boat.png": "manga-paper-boat",
};

// Removed after Vite copies public/. Turning publicDir off instead would also
// stop Vite rewriting public URLs such as /favicon.png to relative ones. The
// build fails if the bundle starts referring to one, rather than shipping a
// broken image.
function tizenPublic(): Plugin {
  let outDir = "";
  const referrer = (body: string) =>
    Object.entries(PUBLIC_EXCLUDED).find(([, marker]) => body.includes(marker))?.[0];
  return {
    name: "harbor-tizen-public",
    apply: "build",
    // After Vite's HTML plugin, so index-tv.html is scanned with the chunks.
    enforce: "post",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        const body = item.type === "chunk" ? item.code : item.source;
        const entry = typeof body === "string" ? referrer(body) : undefined;
        if (entry) {
          this.error(
            `${item.fileName} refers to public/${entry}, which the Tizen build leaves out`,
          );
        }
      }
    },
    closeBundle() {
      for (const entry of Object.keys(PUBLIC_EXCLUDED)) {
        rmSync(join(outDir, entry), { recursive: true, force: true });
      }
      // Text files copied from public/ can point at an excluded entry too.
      const scan = (dir: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory()) {
            if (path !== join(outDir, "assets")) scan(path);
          } else if (/\.(?:json|html|css|js|svg)$/.test(item.name)) {
            const entry = referrer(readFileSync(path, "utf8"));
            if (entry) {
              throw new Error(
                `${path} refers to public/${entry}, which the Tizen build leaves out`,
              );
            }
          }
        }
      };
      scan(outDir);
    },
  };
}

const STATS_FILE = fileURLToPath(new URL("./.stats/bundle.json", import.meta.url));

// Chunk and module sizes for scripts/check-tizen-budget.mjs and for finding
// what to split next. Written outside dist so it never ends up in the .wgt.
function tizenStats(): Plugin {
  let root = "";
  return {
    name: "harbor-tizen-stats",
    apply: "build",
    // After Vite's own generateBundle hooks, which emit the stylesheet.
    enforce: "post",
    configResolved(config) {
      root = slash(config.root);
    },
    generateBundle(_options, bundle) {
      const rel = (id: string) => slash(id).replace(`${root}/`, "").replace(/\?.*$/, "");
      const files = Object.values(bundle).map((item) => {
        const body = item.type === "chunk" ? item.code : item.source;
        const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
        const text = /\.(?:js|css|json|html)$/.test(item.fileName);
        return {
          file: item.fileName,
          bytes,
          gzip: text ? gzipSync(body).byteLength : null,
          entry: item.type === "chunk" && item.isEntry,
          dynamicEntry: item.type === "chunk" && item.isDynamicEntry,
          modules:
            item.type === "chunk"
              ? Object.entries(item.modules)
                  .map(([id, m]) => ({ id: rel(id), bytes: m.renderedLength }))
                  .filter((m) => m.bytes > 0)
                  .sort((a, b) => b.bytes - a.bytes)
                  .slice(0, 40)
              : undefined,
        };
      });
      files.sort((a, b) => b.bytes - a.bytes);
      mkdirSync(dirname(STATS_FILE), { recursive: true });
      writeFileSync(STATS_FILE, `${JSON.stringify({ files }, null, 1)}\n`);
    },
  };
}

export default defineConfig(async (env) => {
  const base: UserConfig =
    typeof rootConfig === "function" ? await rootConfig(env) : await rootConfig;
  return {
    ...base,
    base: "./",
    plugins: [tizenStubs(), ...(base.plugins ?? []), ...tizenHtml(), tizenPublic(), tizenStats()],
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
