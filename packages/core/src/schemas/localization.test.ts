import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_CODES,
  LocalizedCardSchema,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  languageName,
  resolveLanguage,
} from "./localization.js";

describe("language set", () => {
  it("includes English as the default + source language", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(LANGUAGE_CODES).toContain("en");
  });

  it("has one supported-language entry per code, with non-empty labels", () => {
    expect(SUPPORTED_LANGUAGES.map((l) => l.code).sort()).toEqual([...LANGUAGE_CODES].sort());
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(lang.label.length).toBeGreaterThan(0);
      expect(lang.englishName.length).toBeGreaterThan(0);
    }
  });

  it("has unique codes", () => {
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length);
  });
});

describe("isSupportedLanguage", () => {
  it("is true for every supported code", () => {
    for (const code of LANGUAGE_CODES) {
      expect(isSupportedLanguage(code)).toBe(true);
    }
  });

  it("is false for an unknown code or non-string", () => {
    expect(isSupportedLanguage("xx")).toBe(false);
    expect(isSupportedLanguage("")).toBe(false);
    expect(isSupportedLanguage(undefined)).toBe(false);
    expect(isSupportedLanguage(42)).toBe(false);
  });
});

describe("resolveLanguage", () => {
  it("returns a supported code unchanged", () => {
    expect(resolveLanguage("es")).toBe("es");
    expect(resolveLanguage("zh")).toBe("zh");
  });

  it("falls back to English for unknown, empty, null, or missing input", () => {
    expect(resolveLanguage("xx")).toBe("en");
    expect(resolveLanguage("")).toBe("en");
    expect(resolveLanguage(null)).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
  });
});

describe("languageName", () => {
  it("maps a code to its English name for prompting", () => {
    expect(languageName("es")).toBe("Spanish");
    expect(languageName("zh")).toBe("Chinese");
  });
});

describe("LocalizedCardSchema", () => {
  it("accepts prose with an empty suggestions list", () => {
    expect(LocalizedCardSchema.safeParse({ explanation: "hola", suggestions: [] }).success).toBe(
      true,
    );
  });

  it("rejects an empty explanation", () => {
    expect(LocalizedCardSchema.safeParse({ explanation: "", suggestions: [] }).success).toBe(false);
  });

  it("rejects an empty suggestion string", () => {
    expect(LocalizedCardSchema.safeParse({ explanation: "ok", suggestions: [""] }).success).toBe(
      false,
    );
  });
});
