import { describe, expect, it } from "vitest";
import { classifyDemotion } from "./demote.js";

describe("classifyDemotion", () => {
  it("flags lockfiles", () => {
    expect(classifyDemotion("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyDemotion("package-lock.json")).toBe("lockfile");
    expect(classifyDemotion("apps/api/go.sum")).toBe("lockfile");
    expect(classifyDemotion("Cargo.lock")).toBe("lockfile");
    expect(classifyDemotion("yarn.lock")).toBe("lockfile");
    expect(classifyDemotion("services/Gemfile.lock")).toBe("lockfile");
  });

  it("flags generated artifacts", () => {
    expect(classifyDemotion("dist/app.min.js")).toBe("generated");
    expect(classifyDemotion("src/x.generated.ts")).toBe("generated");
    expect(classifyDemotion("api/foo.pb.go")).toBe("generated");
    expect(classifyDemotion("path/to/build/x.js")).toBe("generated");
    expect(classifyDemotion("web/styles.min.css")).toBe("generated");
    expect(classifyDemotion("proto/thing_pb2.py")).toBe("generated");
    expect(classifyDemotion("components/__snapshots__/Foo.snap")).toBe("generated");
  });

  it("flags binary files by extension", () => {
    expect(classifyDemotion("assets/logo.png")).toBe("binary");
    expect(classifyDemotion("fonts/Inter.woff2")).toBe("binary");
    expect(classifyDemotion("bundle.wasm")).toBe("binary");
    expect(classifyDemotion("docs/spec.pdf")).toBe("binary");
  });

  it("does not demote real source or docs", () => {
    expect(classifyDemotion("src/payments/charge.ts")).toBeNull();
    expect(classifyDemotion("README.md")).toBeNull();
    expect(classifyDemotion("packages/core/src/rank/rankHunks.ts")).toBeNull();
    expect(classifyDemotion("apps/app/src/main.ts")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyDemotion("Dist/App.Min.JS")).toBe("generated");
    expect(classifyDemotion("PNPM-LOCK.YAML")).toBe("lockfile");
    expect(classifyDemotion("ASSETS/LOGO.PNG")).toBe("binary");
  });
});
