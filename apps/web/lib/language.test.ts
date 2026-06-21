import { describe, expect, it } from "vitest";
import { LANGUAGE_COOKIE, resolveLanguageCookie } from "./language";

describe("LANGUAGE_COOKIE", () => {
  it("is the stable cookie name", () => {
    expect(LANGUAGE_COOKIE).toBe("df_lang");
  });
});

describe("resolveLanguageCookie", () => {
  it("returns a supported language code unchanged", () => {
    expect(resolveLanguageCookie("de")).toBe("de");
    expect(resolveLanguageCookie("ja")).toBe("ja");
  });

  it("falls back to English for an unsupported, empty, or missing value", () => {
    expect(resolveLanguageCookie("zz")).toBe("en");
    expect(resolveLanguageCookie("")).toBe("en");
    expect(resolveLanguageCookie(undefined)).toBe("en");
    expect(resolveLanguageCookie(null)).toBe("en");
  });
});
