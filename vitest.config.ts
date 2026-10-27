import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["backend/**", "src-tauri/**", "node_modules/**", "dist/**"],
  },
})
