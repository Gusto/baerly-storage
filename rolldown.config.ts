import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
    input: "src/mps3.ts",
    output: {
        dir: "dist",
        format: "esm",
        minify: true,
    },
    plugins: [dts()],
});
