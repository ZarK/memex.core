import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every run uses scratch folders: no test reaches the user's Memex folders, pack store, or locations.json.
    setupFiles: ["test/setup.ts"],
  },
});
