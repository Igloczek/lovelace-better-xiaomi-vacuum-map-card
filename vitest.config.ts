import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "happy-dom",
        include: ["test/**/*.test.ts"],
        setupFiles: ["test/harness/setup.ts"],
        clearMocks: true,
        restoreMocks: true,
        // A mount helper that never settles is a harness bug, not a slow test. Fail fast and loud.
        testTimeout: 10000,
        hookTimeout: 10000,
        reporters: ["default"],
    },
});
