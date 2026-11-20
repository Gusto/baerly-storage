/**
 * Single-defect mutants of the prototype tree, injected through the
 * `steps` member of `TreeConstructorOptions`
 * (`packages/server/src/tree/layout.ts`). Each acceptance suite has a
 * `mutation` test asserting that its checks go red under the mutants
 * named for it, so a suite that stops discriminating is caught.
 *
 * Add a mutant here, and a member to `TreeSteps` for the step it
 * replaces, rather than editing tree code to inject a defect.
 */
import {
  TREE_LAYOUT_RULES,
  type TreeConstructorOptions,
} from "../../packages/server/src/tree/layout.ts";

export interface TreeMutant {
  /** Stable name for test titles. */
  readonly name: string;
  /** The single defect the mutant introduces. */
  readonly defect: string;
  /** Pass to `createTreeConfig` to build the mutated tree. */
  readonly options: TreeConstructorOptions;
}

/** A layout validator missing the rule named `rule`. */
export const layoutWithoutRule = (rule: string): TreeMutant => {
  if (!TREE_LAYOUT_RULES.some((r) => r.name === rule)) {
    throw new Error(`no layout rule named ${JSON.stringify(rule)}`);
  }
  return {
    name: `layout-without-${rule}`,
    defect: `layout validation omits rule ${rule}`,
    options: { steps: { layoutRules: TREE_LAYOUT_RULES.filter((r) => r.name !== rule) } },
  };
};
