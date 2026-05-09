import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
    input: "src/index.ts",
    output: {
        dir: "dist",
        format: "esm",
        minify: true,
    },
    plugins: [dts({ tsgo: true })],
});
