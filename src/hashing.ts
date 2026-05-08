import { Branded } from "types";

export type b64 = Branded<string, "VersionId">;

/** @internal */
export async function sha256b64(message: string): Promise<b64> {
    const msgBuffer = new TextEncoder().encode(message);

    // hash the message
    const arrayBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);

    // convert ArrayBuffer to base64-encoded string
    return uint2b64(new Uint8Array(arrayBuffer));
    /*
    return [...new Uint8Array(arrayBuffer)]
      .map((bytes) => bytes.toString(16).padStart(2, "0"))
      .join("");
    */
}

export const toB64 = (a: string) => <b64>btoa(a);

export const b642uint = (a: b64) =>
    new Uint8Array([...atob(a)].map((l) => l.charCodeAt(0)));

export const uint2b64 = (a: Uint8Array) => toB64(String.fromCharCode(...a));

export const or = (a: b64, b: b64): b64 => {
    const bi = b642uint(b);
    return uint2b64(b642uint(a).map((a, i) => a | bi[i]));
};

/**
 * Test if the 1s in bitstring A are all present in B
 */
export const inside = (a: b64, b: b64): boolean => {
    /** A   B   A in B  A & B  A ^ b   ~A   ~A | (A & B)
     *  0   0      1      0      0      1      1
     *  0   1      1      0      1      1      1
     *  1   0      0      0      1      0      0
     *  1   1      1      1      0      0      1
     */
    const bi = b642uint(b);
    return b642uint(a).reduce(
        (acc, ai, i) => acc && (~ai | (ai & bi[i])) === -1,
        true
    );
};
