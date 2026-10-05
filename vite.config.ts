import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

declare const process: { env: Record<string, string | undefined> };

export default defineConfig(({ mode }) => {
  const isTizen = mode === "tizen" || process.env.BUILD_TARGET === "tizen";

  return {
    base: isTizen ? "./" : "/",
    // Remove `publicDir` override to preserve standard assets.
    // publicDir: isTizen ? "src/tizen/public" : "public",
    staged: {
      "*.{cjs,css,html,js,json,jsonc,jsx,md,mdx,mjs,scss,toml,ts,tsx,yaml,yml}": "vp fmt",
    },
    fmt: {},
    lint: {
      plugins: ["react"],
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: {
        "vite-plus/prefer-vite-plus-imports": "error",
        "react/react-in-jsx-scope": "off",
        "react/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
        "react/no-unstable-nested-components": "warn",
        "react/jsx-no-constructed-context-values": "warn",
        "react/no-object-type-as-default-prop": "warn",
        "react/react-compiler": "warn",
      },
      options: { typeAware: true, typeCheck: true },
    },
    plugins: lazyPlugins(() => {
      const plugins: import("vite-plus").PluginOption[] = [react(), tailwindcss()];
      if (isTizen) {
        plugins.push({
          name: "tizen-manifest-injection",
          writeBundle() {
            // Ensure dist directory exists
            const distPath = path.resolve(__dirname, "src/tizen/dist");
            if (!fs.existsSync(distPath)) {
              fs.mkdirSync(distPath, { recursive: true });
            }

            // Inject config.xml
            fs.copyFileSync(
              path.resolve(__dirname, "src/tizen/config.xml"),
              path.resolve(__dirname, "src/tizen/dist/config.xml"),
            );

            // Inject icon.png from Tauri resources
            fs.copyFileSync(
              path.resolve(__dirname, "src-tauri/icons/icon.png"),
              path.resolve(__dirname, "src/tizen/dist/icon.png"),
            );
          },
        });
      }
      return plugins;
    }),
    build: {
      outDir: isTizen ? "src/tizen/dist" : "dist",
      emptyOutDir: true,
      target: isTizen ? "es2015" : "modules",
      rolldownOptions: {
        onLog(level, log, handler) {
          if (log.code === "EVAL" && log.id?.includes("/lottie-web/")) return;
          handler(level, log);
        },
      },
    },
    clearScreen: false,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __IS_BETA_BUILD__: JSON.stringify(process.env.HARBOR_CHANNEL !== "stable"),
      __IS_TIZEN__: JSON.stringify(isTizen),
    },
    server: {
      port: 1420,
      strictPort: true,
      host: true,
      watch: { ignored: ["**/src-tauri/**", "**/src/tizen/**"] },
    },
    resolve: {
      alias: { "@": "/src" },
    },
  };
});
