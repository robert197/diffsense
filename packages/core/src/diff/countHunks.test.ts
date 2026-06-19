import { describe, expect, it } from "vitest";
import { countHunks } from "./countHunks.js";

const TWO_FILES_TWO_HUNKS_EACH = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
 export { x };
@@ -10,2 +11,3 @@
 function f() {}
+function g() {}
 export { f };
diff --git a/b.ts b/b.ts
index 333..444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export { a };
@@ -8,2 +9,3 @@
 const c = 3;
+const d = 4;
 export { c };
`;

const SINGLE_FILE_SINGLE_HUNK = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };
`;

const NEW_FILE_AND_DELETION = `diff --git a/new.ts b/new.ts
new file mode 100644
index 000..111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const created = true;
+export const value = 1;
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 222..000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const removed = true;
-export const value = 2;
`;

describe("countHunks", () => {
  it("sums hunks across multiple files", () => {
    expect(countHunks(TWO_FILES_TWO_HUNKS_EACH)).toBe(4);
  });

  it("returns 0 for an empty diff string", () => {
    expect(countHunks("")).toBe(0);
    expect(countHunks("   \n  ")).toBe(0);
  });

  it("counts a single-file single-hunk diff as 1", () => {
    expect(countHunks(SINGLE_FILE_SINGLE_HUNK)).toBe(1);
  });

  it("counts a new file and a deletion as one hunk each", () => {
    expect(countHunks(NEW_FILE_AND_DELETION)).toBe(2);
  });
});
