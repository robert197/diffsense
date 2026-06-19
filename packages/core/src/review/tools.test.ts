import { describe, expect, it, vi } from "vitest";
import type { CodeReference, CodeSearch } from "../ports/codeSearch.js";
import type { ConventionStore } from "../ports/conventionStore.js";
import type { PrIntent, RepoReader } from "../ports/repoReader.js";
import { createReviewTools } from "./tools.js";

const callSite: CodeReference = { path: "src/a.ts", line: 3, text: "doThing()" };
const intent: PrIntent = { title: "Add thing", body: "why" };

function fakePorts() {
  const repoReader: RepoReader = {
    readFile: vi.fn(async () => "file contents"),
    getPrIntent: vi.fn(async () => intent),
  };
  const codeSearch: CodeSearch = {
    findCallSites: vi.fn(async () => [callSite]),
    findSymbol: vi.fn(async () => []),
  };
  const conventionStore: ConventionStore = {
    readConventions: vi.fn(async () => "be terse"),
    writeConventions: vi.fn(async () => {}),
  };
  return { repoReader, codeSearch, conventionStore, repo: { owner: "o", repo: "r" } };
}

describe("createReviewTools (R5)", () => {
  it("exposes exactly the four named tools in order", () => {
    const tools = createReviewTools(fakePorts());
    expect(tools.map((t) => t.name)).toEqual([
      "read_file",
      "find_call_sites",
      "get_pr_intent",
      "read_conventions",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("validates inputs via each tool's Zod schema", () => {
    const [readFile, findCallSites] = createReviewTools(fakePorts());
    expect(readFile.inputSchema.safeParse({ path: "src/a.ts" }).success).toBe(true);
    expect(readFile.inputSchema.safeParse({}).success).toBe(false);
    expect(readFile.inputSchema.safeParse({ path: "a", range: { start: 1, end: 2 } }).success).toBe(
      true,
    );
    expect(findCallSites.inputSchema.safeParse({ symbol: "x" }).success).toBe(true);
    expect(findCallSites.inputSchema.safeParse({ symbol: "" }).success).toBe(false);
  });

  it("read_file delegates to RepoReader.readFile with path and range", async () => {
    const ports = fakePorts();
    const [readFile] = createReviewTools(ports);
    const range = { start: 2, end: 4 };
    await expect(readFile.execute({ path: "src/a.ts", range })).resolves.toBe("file contents");
    expect(ports.repoReader.readFile).toHaveBeenCalledWith("src/a.ts", range);
  });

  it("find_call_sites delegates to CodeSearch.findCallSites", async () => {
    const ports = fakePorts();
    const [, findCallSites] = createReviewTools(ports);
    await expect(findCallSites.execute({ symbol: "doThing" })).resolves.toEqual([callSite]);
    expect(ports.codeSearch.findCallSites).toHaveBeenCalledWith("doThing");
  });

  it("get_pr_intent delegates to RepoReader.getPrIntent", async () => {
    const ports = fakePorts();
    const [, , getPrIntent] = createReviewTools(ports);
    await expect(getPrIntent.execute({})).resolves.toEqual(intent);
    expect(ports.repoReader.getPrIntent).toHaveBeenCalledOnce();
  });

  it("read_conventions delegates to ConventionStore with the bound repo", async () => {
    const ports = fakePorts();
    const [, , , readConventions] = createReviewTools(ports);
    await expect(readConventions.execute({})).resolves.toBe("be terse");
    expect(ports.conventionStore.readConventions).toHaveBeenCalledWith({ owner: "o", repo: "r" });
  });
});
