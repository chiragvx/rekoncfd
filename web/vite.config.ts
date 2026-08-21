import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = import.meta.dirname;

// Dev mode: `npm run dev` serves the frontend on its own port with HMR, proxying
// /ws and /api through to the Rust backend (`cargo run -p rekon-app`, port 3000).
// Release mode: `npm run build` emits dist/, which rekon-app embeds via rust-embed
// into a single standalone .exe — see crates/rekon-app/src/http.rs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Matches shadcn/ui's own convention (its generated imports are all
    // `@/components/...`, `@/lib/...`) so components can be added via the
    // shadcn CLI later without any import-path surgery.
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
      "/api": { target: "http://127.0.0.1:3000" },
    },
  },
});
