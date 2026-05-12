/**
 * Replace `{{varName}}` placeholders in `text` with values from
 * `vars`. Twelve lines, no regex backtracking traps, no Mustache
 * dep. Unknown placeholders pass through unchanged — they're a
 * sign of a templating mistake the scaffolder author should fix,
 * not the user, and a silent empty-substitution would hide them.
 */
export const substitute = (text: string, vars: Record<string, string>): string => {
  return text.replaceAll(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.hasOwn(vars, key)) return vars[key]!;
    return full;
  });
};
