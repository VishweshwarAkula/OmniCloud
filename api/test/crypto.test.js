import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/lib/crypto.js";

describe("token encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const enc = encrypt("1//refresh-token");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("refresh-token");
    expect(decrypt(enc)).toBe("1//refresh-token");
  });

  it("uses a fresh IV per call", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("passes legacy plaintext through unchanged", () => {
    expect(decrypt("legacy-plain-token")).toBe("legacy-plain-token");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encrypt("secret");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(tampered)).toThrow();
  });
});
