export interface BundleSizeLine {
  entry: string;
  kind: "raw" | "gz" | "min-gz";
  measured: number;
  budget: number;
  chunks: readonly string[];
}

export function formatBundleSizeLine(input: BundleSizeLine): string {
  const delta = input.measured - input.budget;
  const sign = delta >= 0 ? "+" : "";
  return `BUNDLE_SIZE entry=${input.entry} kind=${input.kind} measured=${input.measured} budget=${input.budget} delta=${sign}${delta} chunks=${input.chunks.join(",")}`;
}
