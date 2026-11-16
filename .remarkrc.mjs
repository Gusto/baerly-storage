import remarkGfm from "remark-gfm";
import remarkLint from "remark-lint";
import remarkLintFencedCodeFlag from "remark-lint-fenced-code-flag";
import remarkValidateLinks from "remark-validate-links";

// Only the fenced-code-flag rule is enabled (no lint preset): a fence without
// a language is skipped by oxfmt and gets no syntax highlighting.
export default {
  plugins: [remarkGfm, remarkValidateLinks, remarkLint, remarkLintFencedCodeFlag],
};
