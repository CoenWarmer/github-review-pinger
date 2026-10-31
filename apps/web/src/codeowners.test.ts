import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeownersText, filesByTeam, parseCodeowners } from "../../../packages/app/src/codeowners.ts";

const FILE = `
# Everything is core's, unless said otherwise
*                       @acme/core
/docs/                  @acme/docs @acme/core
*.tsx                   @acme/frontend  # trailing comment
/packages/api/*         @acme/api
/packages/api/src/      @acme/api-src alice@example.com @someone
/scripts                @acme/tools
/packages/gen/          # no owner: nobody owns generated files
`;

const owned = (paths: string[], file = FILE) => filesByTeam(paths, file).map((t) => [t.team, t.files]);

describe("filesByTeam", () => {
  it("lets the last matching rule decide, and counts a file for each team that owns it", () => {
    assert.deepEqual(
      owned([
        "README.md", // * → core
        "docs/guide/a.md", // /docs/ → docs + core
        "src/ui/App.tsx", // *.tsx → frontend
        "packages/api/index.ts", // /packages/api/* → api
      ]),
      [
        ["@acme/core", 2],
        ["@acme/api", 1],
        ["@acme/docs", 1],
        ["@acme/frontend", 1],
      ],
    );
  });

  it("keeps `dir/*` to the directory's own files, and a bare name to what's inside it", () => {
    // Not directly in /packages/api/, so only `*` applies.
    assert.deepEqual(owned(["packages/api/deep/x.ts"]), [["@acme/core", 1]]);
    assert.deepEqual(owned(["scripts/build/run.sh"]), [["@acme/tools", 1]]);
  });

  it("leaves people and emails out, and files whose last rule names no one", () => {
    assert.deepEqual(owned(["packages/api/src/a.ts"]), [["@acme/api-src", 1]]);
    assert.deepEqual(owned(["packages/gen/out.ts"]), []);
  });

  it("matches a pattern without a slash at any depth", () => {
    assert.deepEqual(owned(["a/b/c/Deep.tsx"]), [["@acme/frontend", 1]]);
  });

  it("skips comments, blanks and section headers", () => {
    assert.equal(parseCodeowners("# only a comment\n\n[Section]\n/x @a/b").length, 1);
  });
});

describe("codeownersText", () => {
  const file = (text: string) => ({ object: { text } });
  const data = (target: object | null) => ({ baseRef: target && { target } }) as never;

  it("takes the first file GitHub would read", () => {
    assert.equal(codeownersText(data({ inGithub: null, inRoot: file("root"), inDocs: file("docs") })), "root");
    assert.equal(codeownersText(data({ inGithub: file("gh"), inRoot: file("root") })), "gh");
    assert.equal(codeownersText(data({ inGithub: file("  \n") })), null);
    assert.equal(codeownersText(data(null)), null);
  });
});
