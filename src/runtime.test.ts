import { describe, expect, it } from "vitest";
import { getGossipResolveUserPath } from "./runtime.js";

describe("getGossipResolveUserPath", () => {
  it("returns the input unchanged when no tilde is present", () => {
    expect(getGossipResolveUserPath("/var/tmp")).toBe("/var/tmp");
  });

  it('expands "~" using HOME when present', () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/home/test-user";
    try {
      expect(getGossipResolveUserPath("~")).toBe("/home/test-user");
      expect(getGossipResolveUserPath("~/foo")).toBe("/home/test-user/foo");
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });
});

