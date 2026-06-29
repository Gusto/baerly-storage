// Shared YAML-frontmatter fence splitter for the verify-docs lint scripts.
//
// Returns `{ raw, body }` where `raw` is the YAML text between the opening
// `---` and the closing `\n---\n` (fences excluded) and `body` is the
// remainder of the document. When there is no opening fence or no closing
// fence, `raw` is `undefined` and `body` is the whole content.
//
// Parsing the YAML is left to the caller on purpose: verify-docs.mjs wants
// the parsed object, while verify-docs-taxonomy.mjs wants the raw string
// plus the body (it also scans the body for index links). The split itself
// is the only logic both share.
export function splitFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return { raw: undefined, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { raw: undefined, body: content };
  }
  return { raw: content.slice(4, end), body: content.slice(end + 5) };
}
