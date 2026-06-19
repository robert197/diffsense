import { describe, expect, it, vi } from "vitest";
import { type RepoReaderClient, createGitHubRepoReader } from "./repoReader.js";

const FILE = "line1\nline2\nline3\nline4";

function fakeClient(overrides?: {
  getContent?: RepoReaderClient["rest"]["repos"]["getContent"];
  get?: RepoReaderClient["rest"]["pulls"]["get"];
}): RepoReaderClient {
  return {
    rest: {
      repos: {
        getContent:
          overrides?.getContent ??
          vi.fn(async () => ({
            data: { content: Buffer.from(FILE, "utf8").toString("base64"), encoding: "base64" },
          })),
      },
      pulls: {
        get:
          overrides?.get ?? vi.fn(async () => ({ data: { title: "Add thing", body: "the why" } })),
      },
    },
  };
}

const coords = { owner: "octo", repo: "demo", prNumber: 7, ref: "headsha" };

describe("createGitHubRepoReader (R2)", () => {
  it("readFile with no range returns the full decoded file", async () => {
    const reader = createGitHubRepoReader(fakeClient(), coords);
    await expect(reader.readFile("src/a.ts")).resolves.toBe(FILE);
  });

  it("readFile with a range returns only those 1-based inclusive lines", async () => {
    const reader = createGitHubRepoReader(fakeClient(), coords);
    await expect(reader.readFile("src/a.ts", { start: 2, end: 3 })).resolves.toBe("line2\nline3");
  });

  it("readFile clamps a range past EOF without error", async () => {
    const reader = createGitHubRepoReader(fakeClient(), coords);
    await expect(reader.readFile("src/a.ts", { start: 3, end: 99 })).resolves.toBe("line3\nline4");
  });

  it("readFile returns null when the file is not found (404)", async () => {
    const reader = createGitHubRepoReader(
      fakeClient({
        getContent: vi.fn(async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }),
      }),
      coords,
    );
    await expect(reader.readFile("missing.ts")).resolves.toBeNull();
  });

  it("readFile rethrows non-404 errors", async () => {
    const reader = createGitHubRepoReader(
      fakeClient({
        getContent: vi.fn(async () => {
          throw Object.assign(new Error("rate limited"), { status: 403 });
        }),
      }),
      coords,
    );
    await expect(reader.readFile("a.ts")).rejects.toThrow("rate limited");
  });

  it("getPrIntent returns title and body from pulls.get", async () => {
    const reader = createGitHubRepoReader(fakeClient(), coords);
    await expect(reader.getPrIntent()).resolves.toEqual({ title: "Add thing", body: "the why" });
  });

  it("getPrIntent coerces a missing body to an empty string", async () => {
    const reader = createGitHubRepoReader(
      fakeClient({ get: vi.fn(async () => ({ data: { title: "T", body: null } })) }),
      coords,
    );
    await expect(reader.getPrIntent()).resolves.toEqual({ title: "T", body: "" });
  });
});
