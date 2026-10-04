import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY || "http://localhost:3000", changeOrigin: false },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 600 },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.js"], css: false },
});
