import { describe, expect, it } from "vitest";
import { fingerprintChunk } from "./fingerprint.js";

const PATCH_A = `@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;

describe("fingerprintChunk", () => {
  it("is stable for the same file + changed lines", () => {
    expect(fingerprintChunk("src/a.ts", PATCH_A)).toBe(fingerprintChunk("src/a.ts", PATCH_A));
  });

  it("ignores line numbers — the same change shifted in the file shares a key", () => {
    const shifted = `@@ -40,2 +120,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;
    expect(fingerprintChunk("src/a.ts", shifted)).toBe(fingerprintChunk("src/a.ts", PATCH_A));
  });

  it("ignores inner whitespace reformatting of the changed lines", () => {
    const reformatted = `@@ -1,2 +1,3 @@
 const x = 1;
+const   y   =   2;
 export { x };
`;
    expect(fingerprintChunk("src/a.ts", reformatted)).toBe(fingerprintChunk("src/a.ts", PATCH_A));
  });

  it("differs when the changed content differs", () => {
    const other = `@@ -1,2 +1,3 @@
 const x = 1;
+const y = 3;
 export { x };
`;
    expect(fingerprintChunk("src/a.ts", other)).not.toBe(fingerprintChunk("src/a.ts", PATCH_A));
  });

  it("differs across files for the same change (no cross-file collision)", () => {
    expect(fingerprintChunk("src/b.ts", PATCH_A)).not.toBe(fingerprintChunk("src/a.ts", PATCH_A));
  });

  it("distinguishes an addition from a deletion of the same text", () => {
    const added = `@@ -1,1 +1,2 @@
 const x = 1;
+secret = load();
`;
    const deleted = `@@ -1,2 +1,1 @@
 const x = 1;
-secret = load();
`;
    expect(fingerprintChunk("src/a.ts", added)).not.toBe(fingerprintChunk("src/a.ts", deleted));
  });

  it("returns a hex digest", () => {
    expect(fingerprintChunk("src/a.ts", PATCH_A)).toMatch(/^[0-9a-f]{32}$/);
  });
});
