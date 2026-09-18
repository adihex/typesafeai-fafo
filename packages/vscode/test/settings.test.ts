import { describe, expect, it } from "vitest";
import { resolveApiKey, toResolveOptions } from "../src/settings.ts";

describe("toResolveOptions", () => {
  it("passes thresholds and flags through", () => {
    const opts = toResolveOptions({
      minConfidence: 0.7,
      minCoverage: 0.6,
      minVerify: 0.8,
      noVerify: true,
      decompose: false,
      maxWindows: 4,
      contextLines: 30,
      model: "jev-test",
    });
    expect(opts).toEqual({
      minConfidence: 0.7,
      minCoverage: 0.6,
      minVerify: 0.8,
      noVerify: true,
      decompose: false,
      maxWindows: 4,
      contextLines: 30,
      model: "jev-test",
    });
  });

  it("maps empty/whitespace model to undefined (SDK default)", () => {
    expect(toResolveOptions({ model: "" }).model).toBeUndefined();
    expect(toResolveOptions({ model: "   " }).model).toBeUndefined();
    expect(toResolveOptions({}).model).toBeUndefined();
  });
});

describe("resolveApiKey", () => {
  it("prefers the environment over the setting", () => {
    expect(resolveApiKey("env-key", "cfg-key")).toBe("env-key");
  });

  it("falls back to the setting", () => {
    expect(resolveApiKey(undefined, "cfg-key")).toBe("cfg-key");
  });

  it("treats blank and whitespace as unset", () => {
    expect(resolveApiKey("", "cfg-key")).toBe("cfg-key");
    expect(resolveApiKey("   ", undefined)).toBeUndefined();
    expect(resolveApiKey(undefined, " ")).toBeUndefined();
    expect(resolveApiKey(undefined, undefined)).toBeUndefined();
  });
});
