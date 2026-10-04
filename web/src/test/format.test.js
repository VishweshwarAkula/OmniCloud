import { describe, expect, it } from "vitest";
import { formatBytes, formatMoney, formatMonth } from "../lib/format";

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(15 * 1024 ** 3)).toBe("15.0 GB");
  });

  it("formats money with and without currency", () => {
    expect(formatMoney(1234.5, "USD")).toMatch(/1,234\.5/);
    expect(formatMoney("12", null)).toBe("12.00");
    expect(formatMoney(5, "NOT_A_CODE")).toBe("NOT_A_CODE 5.00");
  });

  it("formats months", () => {
    expect(formatMonth("2026-03")).toMatch(/Mar/);
  });
});
