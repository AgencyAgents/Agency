export interface DiffLine {
  k: "+" | "-" | " ";
  n: string;
  text: string;
}

export interface DiffHunk {
  head: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  hunks: DiffHunk[];
}

/** `git diff` output into files and hunks; each line keeps the number of the side it belongs to. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldN = 0;
  let newN = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m?.[1] ?? line.slice(11), added: 0, deleted: 0, binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      if (path !== "/dev/null") file.path = path;
      continue;
    }
    if (line.startsWith("--- ") && !hunk) continue;
    if (line.startsWith("Binary files ")) {
      file.binary = true;
      continue;
    }
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      oldN = Number(head[1]);
      newN = Number(head[2]);
      hunk = { head: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ k: "+", n: String(newN++), text: line.slice(1) });
      file.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ k: "-", n: String(oldN++), text: line.slice(1) });
      file.deleted++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ k: " ", n: String(newN++), text: line.slice(1) });
      oldN++;
    }
  }
  return files;
}

export function newFile(path: string, text: string | null): DiffFile {
  if (text === null) return { path, added: 0, deleted: 0, binary: true, hunks: [] };
  const lines = text.replace(/\n$/, "").split("\n");
  return {
    path,
    added: lines.length,
    deleted: 0,
    binary: false,
    hunks: [
      {
        head: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((t, i) => ({ k: "+", n: String(i + 1), text: t })),
      },
    ],
  };
}
