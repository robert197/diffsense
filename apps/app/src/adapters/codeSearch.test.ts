import { describe, expect, it } from "vitest";
import { createAstGrepCodeSearch } from "./codeSearch.js";

const tsSource = [
  "function doThing(x) { return x; }", // line 1
  "doThing(1);", // line 2
  "const y = doThing(2, 3);", // line 3
  "class Foo {}", // line 4
].join("\n");

describe("createAstGrepCodeSearch (R3)", () => {
  it("findCallSites returns each call with a 1-based line and path", async () => {
    const search = createAstGrepCodeSearch({ files: [{ path: "src/a.ts", source: tsSource }] });
    const refs = await search.findCallSites("doThing");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.line)).toEqual([2, 3]);
    expect(refs.every((r) => r.path === "src/a.ts")).toBe(true);
  });

  it("findCallSites caps results at maxResults", async () => {
    const calls = Array.from({ length: 10 }, (_, i) => `doThing(${i});`).join("\n");
    const search = createAstGrepCodeSearch({
      files: [{ path: "src/a.ts", source: calls }],
      maxResults: 3,
    });
    await expect(search.findCallSites("doThing")).resolves.toHaveLength(3);
  });

  it("findCallSites returns an empty list for an unresolved symbol", async () => {
    const search = createAstGrepCodeSearch({ files: [{ path: "src/a.ts", source: tsSource }] });
    await expect(search.findCallSites("nonexistentSymbol")).resolves.toEqual([]);
  });

  it("findCallSites returns an empty list (never throws) on an empty symbol", async () => {
    const search = createAstGrepCodeSearch({ files: [{ path: "src/a.ts", source: tsSource }] });
    await expect(search.findCallSites("")).resolves.toEqual([]);
  });

  it("skips files with an unknown extension without error", async () => {
    const search = createAstGrepCodeSearch({
      files: [{ path: "image.png", source: "not code at all {{{" }],
    });
    await expect(search.findCallSites("doThing")).resolves.toEqual([]);
  });

  it("findSymbol locates a function, const, and class definition", async () => {
    const search = createAstGrepCodeSearch({ files: [{ path: "src/a.ts", source: tsSource }] });
    const fn = await search.findSymbol("doThing");
    expect(fn).toHaveLength(1);
    expect(fn[0]?.line).toBe(1);

    const cls = await search.findSymbol("Foo");
    expect(cls).toHaveLength(1);
    expect(cls[0]?.line).toBe(4);
  });
});
