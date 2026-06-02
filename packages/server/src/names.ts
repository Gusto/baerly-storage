import { BaerlyError } from "@baerly/protocol";

/** Reject names in the system-reserved leading-"_" namespace. See docs/adr/007-layout-versioning-cordon.md. */
export const assertNameNotReserved = (name: string, context: string): void => {
  if (name.startsWith("_")) {
    throw new BaerlyError(
      "InvalidConfig",
      `${context}: "${name}" is reserved — names beginning with "_" are reserved for system use. See docs/adr/007-layout-versioning-cordon.md.`,
    );
  }
};
