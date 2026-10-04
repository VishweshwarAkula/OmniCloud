import { describe, expect, it } from "vitest";
import { desiredReplicas } from "../src/lib/scaling.js";

describe("desiredReplicas", () => {
  it("keeps the minimum when idle", () => expect(desiredReplicas(0, 20, 1, 8)).toBe(1));
  it("scales with backlog", () => expect(desiredReplicas(61, 20, 1, 8)).toBe(4));
  it("caps at max", () => expect(desiredReplicas(10_000, 20, 1, 8)).toBe(8));
  it("survives a zero target", () => expect(desiredReplicas(5, 0, 1, 8)).toBe(5));
});
