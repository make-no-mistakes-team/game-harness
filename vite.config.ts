import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Vite's workspace-wide default also includes private runtime databases.
    // Browser source/dependencies are the only development filesystem surface.
    fs: {
      strict: true,
      allow: ["./web", "./src/shared", "./node_modules"].map((directory) =>
        fileURLToPath(new URL(directory, import.meta.url)),
      ),
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/local/**",
        "**/.impeccable/**",
        "**/PRODUCT.md",
      ],
    },
    proxy: {
      "/v1": {
        target: `http://127.0.0.1:${process.env.GAMEHARNESS_PORT ?? 4317}`,
        changeOrigin: true,
      },
    },
  },
});
