import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSectionOpen, saveSectionOpen } from "../../../packages/app/src/openSections.ts";

function fakeStore(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("open sections", () => {
  it("knows nothing about a section never touched", () => {
    assert.equal(loadSectionOpen("mine:waiting", fakeStore()), null);
  });

  it("remembers each section, open or closed", () => {
    const store = fakeStore();
    saveSectionOpen("mine:needsAction", false, store);
    saveSectionOpen("mine:draft", true, store);
    assert.equal(loadSectionOpen("mine:needsAction", store), false);
    assert.equal(loadSectionOpen("mine:draft", store), true);
    saveSectionOpen("mine:needsAction", true, store);
    assert.equal(loadSectionOpen("mine:needsAction", store), true);
    assert.equal(loadSectionOpen("mine:draft", store), true);
  });

  it("starts over from something unreadable", () => {
    for (const bad of ["not json", "null", "3"]) {
      const store = fakeStore(bad);
      assert.equal(loadSectionOpen("a", store), null);
      saveSectionOpen("a", false, store);
      assert.equal(loadSectionOpen("a", store), false);
    }
  });

  it("carries on when the storage refuses", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(loadSectionOpen("a", broken), null);
    assert.doesNotThrow(() => saveSectionOpen("a", true, broken));
  });
});
