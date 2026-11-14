import { defineConfig } from "rolldown";

// Rolldown resolves node modules, CommonJS and JSON itself, and transforms and minifies with Oxc.
// The tsconfig carries `experimentalDecorators` and `useDefineForClassFields: false`, which Lit's
// legacy decorators need: reactive properties must stay accessors, not own class fields.
export default defineConfig({
    input: "src/xiaomi-vacuum-map-card.ts",
    tsconfig: "tsconfig.json",
    output: {
        dir: "dist",
        format: "es",
        minify: true,
    },
});
