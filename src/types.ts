declare const __brand: unique symbol
type Brand<B> = { [__brand]: B }
export type Branded<T, B> = T & Brand<B>

export type DeleteValue = undefined;

export interface Ref {
  bucket?: string;
  key: string;
}

export interface ResolvedRef extends Ref {
  bucket: string;
  key: string;
}

export type ManifestKey = Branded<string, "Manifest">;
export type UUID = Branded<string, "UUID">;
export type VersionId = Branded<string, "VersionId">;

export const uuid = (): UUID => <UUID>crypto.randomUUID();
export const countKey = (number: number): string => uint2strDesc(number, 10);
export const eq = (a: Ref, b: Ref) => a.bucket === b.bucket && a.key === b.key;
export const url = (ref: Ref): string => `${ref.bucket}/${ref.key}`;
export const parseUrl = (url: string): ResolvedRef => {
  const [bucket, ...key] = url.split("/");
  return {
    bucket,
    key: key.join("/"),
  };
};

export const uint2str = (num: number, bits: number) => {
  const maxBase32Length = Math.ceil(bits / 5); // Change from 4 to 5 because log2(32) is roughly 5.
  const base32Representation = num.toString(32);
  return base32Representation.padStart(maxBase32Length, "0");
};

export const str2uint = (str: string) => {
  return parseInt(str, 32); // Parse the string as base 32.
};

export const uint2strDesc = (num: number, bits: number): string => {
  const maxValue = Math.pow(2, bits) - 1;
  return uint2str(maxValue - num, bits);
};

export const str2uintDesc = (str: string, bits: number): number => {
  const maxValue = Math.pow(2, bits) - 1;
  const num = parseInt(str, 32); // Convert base32 string to number
  return maxValue - num;
};

