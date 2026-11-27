/**
 * Unified diff parser.
 *
 * Handles the output of `git diff` as served by the GitHub API
 * (`application/vnd.github.diff`), including renames, copies, mode changes,
 * new and deleted files, binary files, quoted paths and the
 * "\ No newline at end of file" marker. It also parses the per-file `patch`
 * strings returned by `pulls.listFiles`, which are bare hunks without headers.
 *
 * Hunk bodies are consumed by counting the old/new line totals from the
 * `@@` header rather than by pattern matching, so a removed line whose text
 * is "-- foo" (rendered as "--- foo") is never mistaken for a file header.
 */

export type LineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: LineKind;
  /** Line text without the leading +/-/space marker. */
  content: string;
  /** 1-based line number in the base file, or null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the head file, or null for deleted lines. */
  newLine: number | null;
}

export interface Hunk {
  /** The raw `@@ ... @@` header line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional function/section context that git prints after the header. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface FileDiff {
  /** Path in the head revision (for deleted files, the path that was removed). */
  path: string;
  /** Path in the base revision when it differs from `path` (renames/copies). */
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parse a full multi-file unified diff. */
export function parseDiff(text: string): FileDiff[] {
  const lines = splitLines(text);
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let i = 0;

  const startFile = (path: string, oldPath: string | null = null): FileDiff => {
    const file: FileDiff = { path, oldPath, status: "modified", binary: false, hunks: [] };
    files.push(file);
    return file;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("diff --git ")) {
      const paths = parseDiffGitHeader(line.slice("diff --git ".length));
      current = startFile(paths?.newPath ?? "", paths && paths.oldPath !== paths.newPath ? paths.oldPath : null);
      i++;
      continue;
    }

    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldPath = parseHeaderPath(line.slice(4));
      const newPath = parseHeaderPath(lines[i + 1]!.slice(4));
      // A bare patch (no `diff --git` line) or a header following one.
      if (!current || current.hunks.length > 0) {
        current = startFile(newPath ?? oldPath ?? "");
      }
      applyHeaderPaths(current, oldPath, newPath);
      i += 2;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      current ??= startFile("");
      const { hunk, next } = readHunk(lines, i, hunkMatch);
      current.hunks.push(hunk);
      i = next;
      continue;
    }

    if (current) applyExtendedHeader(current, line);
    i++;
  }

  return files.filter((f) => f.path !== "");
}

/**
 * Parse the `patch` field from `GET /repos/{o}/{r}/pulls/{n}/files`.
 * GitHub omits the patch for binary files and for very large diffs.
 */
export function parsePatch(path: string, patch: string | undefined, status: FileStatus, oldPath: string | null = null): FileDiff {
  const file: FileDiff = { path, oldPath, status, binary: patch === undefined, hunks: [] };
  if (patch === undefined) return file;
  const lines = splitLines(patch);
  let i = 0;
  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i]!);
    if (!match) {
      i++;
      continue;
    }
    const { hunk, next } = readHunk(lines, i, match);
    file.hunks.push(hunk);
    i = next;
  }
  return file;
}

function readHunk(lines: string[], start: number, match: RegExpExecArray): { hunk: Hunk; next: number } {
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  const hunk: Hunk = {
    header: lines[start]!,
    oldStart,
    oldLines,
    newStart,
    newLines,
    section: (match[5] ?? "").trim(),
    lines: [],
  };

  let oldRemaining = oldLines;
  let newRemaining = newLines;
  let oldLine = oldStart;
  let newLine = newStart;
  let i = start + 1;

  while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const raw = lines[i]!;
    const marker = raw[0];
    if (marker === "\\") {
      // "\ No newline at end of file" applies to the previous line; skip it.
      i++;
      continue;
    }
    if (marker === "+" && newRemaining > 0) {
      hunk.lines.push({ kind: "add", content: raw.slice(1), oldLine: null, newLine: newLine++ });
      newRemaining--;
    } else if (marker === "-" && oldRemaining > 0) {
      hunk.lines.push({ kind: "del", content: raw.slice(1), oldLine: oldLine++, newLine: null });
      oldRemaining--;
    } else if ((marker === " " || raw === "") && oldRemaining > 0 && newRemaining > 0) {
      // Some tools strip the single space from blank context lines.
      hunk.lines.push({ kind: "context", content: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
      oldRemaining--;
      newRemaining--;
    } else {
      // Malformed or truncated hunk: stop rather than consume the next header.
      break;
    }
    i++;
  }

  // A trailing "\ No newline" marker after the last counted line.
  while (i < lines.length && lines[i]!.startsWith("\\")) i++;
  return { hunk, next: i };
}

function applyExtendedHeader(file: FileDiff, line: string): void {
  if (line.startsWith("new file mode")) {
    file.status = "added";
  } else if (line.startsWith("deleted file mode")) {
    file.status = "deleted";
  } else if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = unquote(line.slice("rename from ".length));
  } else if (line.startsWith("rename to ")) {
    file.status = "renamed";
    file.path = unquote(line.slice("rename to ".length));
  } else if (line.startsWith("copy from ")) {
    file.status = "copied";
    file.oldPath = unquote(line.slice("copy from ".length));
  } else if (line.startsWith("copy to ")) {
    file.status = "copied";
    file.path = unquote(line.slice("copy to ".length));
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    file.binary = true;
  }
}

function applyHeaderPaths(file: FileDiff, oldPath: string | null, newPath: string | null): void {
  if (oldPath === null && newPath !== null) {
    file.status = "added";
    file.path = newPath;
  } else if (newPath === null && oldPath !== null) {
    file.status = "deleted";
    file.path = oldPath;
  } else if (oldPath !== null && newPath !== null) {
    file.path = newPath;
    if (oldPath !== newPath) {
      file.oldPath = oldPath;
      if (file.status === "modified") file.status = "renamed";
    }
  }
}

/** Parse a `---`/`+++` path. Returns null for /dev/null. */
function parseHeaderPath(raw: string): string | null {
  let value = raw;
  if (!value.startsWith('"')) {
    // Strip an optional tab-separated timestamp (from non-git diff tools).
    const tab = value.indexOf("\t");
    if (tab !== -1) value = value.slice(0, tab);
  }
  value = unquote(value.trimEnd());
  if (value === "/dev/null") return null;
  return stripPrefix(value);
}

/**
 * Parse the "a/<old> b/<new>" part of a `diff --git` line. Paths may be quoted
 * when they contain special characters. Unquoted paths with spaces are
 * ambiguous; we resolve them by assuming old and new are equal, which holds
 * for every case except renames (and renames carry explicit headers).
 */
export function parseDiffGitHeader(rest: string): { oldPath: string; newPath: string } | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    if (rest[i] === " ") {
      i++;
      continue;
    }
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      tokens.push(unquote(rest.slice(i, j + 1)));
      i = j + 1;
    } else if (tokens.length === 0 && !rest.includes('"')) {
      // Both unquoted: split at the midpoint " b/" when the halves match.
      const mid = findSymmetricSplit(rest);
      if (mid !== -1) {
        return { oldPath: stripPrefix(rest.slice(0, mid)), newPath: stripPrefix(rest.slice(mid + 1)) };
      }
      const sep = rest.indexOf(" b/");
      if (sep === -1) return null;
      return { oldPath: stripPrefix(rest.slice(0, sep)), newPath: stripPrefix(rest.slice(sep + 1)) };
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== " ") j++;
      // The final token takes the remainder (it may contain spaces).
      const token = tokens.length === 1 ? rest.slice(i) : rest.slice(i, j);
      tokens.push(token);
      i = tokens.length === 2 ? rest.length : j;
    }
  }
  if (tokens.length !== 2) return null;
  return { oldPath: stripPrefix(tokens[0]!), newPath: stripPrefix(tokens[1]!) };
}

function findSymmetricSplit(rest: string): number {
  // "a/X b/X" has length 2*len(X) + 5; check the midpoint split.
  if ((rest.length - 1) % 2 !== 0) return -1;
  const mid = (rest.length - 1) / 2;
  if (rest[mid] !== " ") return -1;
  const left = rest.slice(0, mid);
  const right = rest.slice(mid + 1);
  if (stripPrefix(left) === stripPrefix(right) && left.startsWith("a/") && right.startsWith("b/")) return mid;
  return -1;
}

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Undo git's C-style path quoting ("a/caf\303\251.txt"). */
export function unquote(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
