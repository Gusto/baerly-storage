// Preloaded with --import: register the published runtime resolver in this
// process, including imports from the runner and generated solutions.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const ROOT = new URL("../", import.meta.url);
const { name, publishConfig } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
      const target = publishConfig.exports[subpath]?.import;
      if (typeof target !== "string") {
        throw new Error(`eval: ${specifier} is not a published package export`);
      }
      // A missing bundle must fail at load time; falling back to workspace
      // source would grade a different runtime than the declarations fed in.
      return { url: new URL(target, ROOT).href, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
