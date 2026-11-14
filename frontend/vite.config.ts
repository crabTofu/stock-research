import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: {
    rollupOptions: {
      output: {
        // keep the charting lib in its own long-cached chunk
        manualChunks: { charts: ["lightweight-charts"], react: ["react", "react-dom", "@tanstack/react-query"] },
      },
    },
  },
});
