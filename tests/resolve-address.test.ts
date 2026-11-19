import { describe, expect, it } from "vitest";
import { resolveAddress } from "../engine/browser/tools.js";

describe("resolveAddress: a site-relative address opens on the current page's site", () => {
  const here = "http://localhost:8000/m/canon/?tab=all";

  it("resolves a path against the current page's origin, keeping its query", () => {
    expect(resolveAddress("/m/canon/?tab=settings", here)).toBe(
      "http://localhost:8000/m/canon/?tab=settings",
    );
  });

  it("works on any host, https included", () => {
    expect(resolveAddress("/m/working_maps/settings/", "https://preview.example.test/x/y")).toBe(
      "https://preview.example.test/m/working_maps/settings/",
    );
  });

  it("leaves a full URL alone", () => {
    expect(resolveAddress("https://other.example.test/a", here)).toBe("https://other.example.test/a");
  });

  it("leaves a protocol-relative address alone", () => {
    expect(resolveAddress("//other.example.test/a", here)).toBe("//other.example.test/a");
  });

  it("leaves a path alone while no http(s) page is open", () => {
    expect(resolveAddress("/m/canon/", "about:blank")).toBe("/m/canon/");
    expect(resolveAddress("/m/canon/", "")).toBe("/m/canon/");
  });
});
