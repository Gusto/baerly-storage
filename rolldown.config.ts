import { defineConfig } from "rolldown";

export default defineConfig({
    input: "src/mps3.ts",
    output: {
        dir: "dist",
        format: "esm",
        minify: true,
    },
});
