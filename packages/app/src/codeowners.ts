// Which teams own the files of a PR, from the CODEOWNERS file of the branch it
// merges into. Pure, so every host gets the same answers.

import type { PrDetailsData } from "./types";

interface Rule {
  regex: RegExp;
  owners: string[];
}

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * The regular expression for a CODEOWNERS pattern, which reads like a
 * `.gitignore` one: a leading `/` or a `/` in the middle ties it to the root,
 * a trailing `/` means a directory's contents, `*` stays inside one directory
 * and `**` doesn't. A name without wildcards also covers what's inside it, but
 * `docs/*` only the files directly in docs, as GitHub says.
 */
function patternRegex(raw: string): RegExp | null {
  let pattern = raw;
  const leading = pattern.startsWith("/");
  if (leading) pattern = pattern.slice(1);
  const directory = pattern.endsWith("/");
  if (directory) pattern = pattern.slice(0, -1);
  if (!pattern) return null;
  const rooted = leading || pattern.includes("/");

  let body = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      body += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      body += "/.*";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      body += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      body += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      body += "[^/]";
      i += 1;
    } else {
      body += escape(pattern[i]);
      i += 1;
    }
  }
  const last = pattern.slice(pattern.lastIndexOf("/") + 1);
  const inside = directory ? "/.*$" : /[*?]/.test(last) ? "$" : "(?:/.*)?$";
  try {
    return new RegExp(`${rooted ? "^" : "^(?:.*/)?"}${body}${inside}`);
  } catch {
    return null;
  }
}

/** The rules of a CODEOWNERS file, in order: comments, blank lines and lines that aren't rules left out. */
export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/(^|\s)#.*$/, "").trim();
    // `[Section]` lines are another host's syntax.
    if (!content || content.startsWith("[")) continue;
    const [pattern, ...owners] = content.split(/\s+/);
    const regex = patternRegex(pattern);
    if (regex) rules.push({ regex, owners });
  }
  return rules;
}

/** The last rule that matches a file decides its owners, which may be none. */
function ownersOf(path: string, rules: Rule[]): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].regex.test(path)) return rules[i].owners;
  }
  return [];
}

/** The CODEOWNERS file GitHub would read: the first of `.github/`, the root and `docs/` that has one. */
export function codeownersText(data: PrDetailsData): string | null {
  const target = data.baseRef?.target;
  const texts = [target?.inGithub, target?.inRoot, target?.inDocs].map((file) => file?.object?.text);
  return texts.find((text) => text !== undefined && text.trim() !== "") ?? null;
}

export interface TeamFiles {
  /** `@org/team`, as the CODEOWNERS file spells it. */
  team: string;
  files: number;
}

/**
 * How many of `paths` each team owns, the most first. A file owned by several
 * teams counts for each; people and emails aren't teams and are left out.
 */
export function filesByTeam(paths: string[], codeowners: string): TeamFiles[] {
  const rules = parseCodeowners(codeowners);
  const counts = new Map<string, TeamFiles>();
  for (const path of paths) {
    for (const owner of new Set(ownersOf(path, rules))) {
      if (!/^@[^/\s]+\/[^/\s]+$/.test(owner)) continue;
      const key = owner.toLowerCase();
      const entry = counts.get(key) ?? { team: owner, files: 0 };
      entry.files++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || a.team.localeCompare(b.team));
}
