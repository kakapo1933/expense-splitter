import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces so a phone on the same Wi-Fi can open http://<lan-ip>:5173
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
