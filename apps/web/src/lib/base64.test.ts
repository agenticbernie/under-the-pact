import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64.js";

describe("browser base64 (PR #13)", () => {
  it("round-trips bytes (helpers never touch the Buffer global)", () => {
    const original = new Uint8Array([0, 1, 127, 128, 200, 255, 12, 34]);
    expect(base64ToBytes(bytesToBase64(original))).toEqual(original);
  });

  it("decodes a known vector", () => {
    expect(Array.from(base64ToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
  });
});
