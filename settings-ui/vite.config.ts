import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.SETTINGS_UI_HOST || "127.0.0.1",
    port: Number(process.env.SETTINGS_UI_WEB_PORT || 5175),
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18766",
        changeOrigin: false,
      },
    },
  },
});
