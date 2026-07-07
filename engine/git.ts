// Diff acquisition for the True layer.
//
// The principled pass scores the *change*, so it needs the PR diff. In CI the
// repo is checked out; locally we run against whatever the working tree shows.
// Best-effort with graceful fallbacks — a missing base ref must not crash the
// run, it just yields a thinner diff and a note.

import { execFileSync } from "node:child_process";

const MAX_DIFF_CHARS = 200_000; // keep the model prompt bounded

function tryGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function getDiff(baseRef: string, sha: string): { diff: string; note: string } {
  const head = sha || "HEAD";

  // Preferred: three-dot diff from the merge base (the actual PR change set).
  let diff = tryGit(["diff", `${baseRef}...${head}`]);
  let note = `git diff ${baseRef}...${head}`;

  if (diff === null || diff.trim() === "") {
    diff = tryGit(["diff", baseRef, head]);
    note = `git diff ${baseRef} ${head}`;
  }
  if (diff === null || diff.trim() === "") {
    diff = tryGit(["diff", "HEAD~1", "HEAD"]);
    note = "git diff HEAD~1 HEAD";
  }
  if (diff === null || diff.trim() === "") {
    diff = tryGit(["diff"]);
    note = "git diff (working tree)";
  }
  if (diff === null) {
    return { diff: "", note: "no diff available (git unavailable or no changes)" };
  }

  if (diff.length > MAX_DIFF_CHARS) {
    return {
      diff: diff.slice(0, MAX_DIFF_CHARS) + `\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`,
      note: `${note} (truncated)`,
    };
  }
  return { diff, note };
}
