import { describe, expect, it } from "vitest";
import { mediaUrl, verifyMedia } from "../src/lib/signedUrl.js";

const parse = (url) => {
  const u = new URL(url, "http://x");
  return {
    fileId: decodeURIComponent(u.pathname.split("/").pop()),
    variant: u.searchParams.get("v"),
    exp: u.searchParams.get("exp"),
    sig: u.searchParams.get("sig"),
  };
};

describe("signed media URLs", () => {
  const now = Date.UTC(2026, 0, 1, 10, 20);

  it("verifies a fresh URL", () => {
    expect(verifyMedia(parse(mediaUrl("abc", "thumb", now)), now)).toBe(true);
  });

  it("is stable within an hour bucket (cacheable)", () => {
    expect(mediaUrl("abc", "full", now)).toBe(mediaUrl("abc", "full", now + 10 * 60_000));
  });

  it("rejects expired, cross-file and cross-variant reuse", () => {
    const p = parse(mediaUrl("abc", "thumb", now));
    expect(verifyMedia(p, now + 3 * 3600_000)).toBe(false);
    expect(verifyMedia({ ...p, fileId: "other" }, now)).toBe(false);
    expect(verifyMedia({ ...p, variant: "full" }, now)).toBe(false);
    expect(verifyMedia({ ...p, sig: "nope" }, now)).toBe(false);
  });
});
