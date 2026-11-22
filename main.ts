// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break (section 3). */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Old lines, new lines, and the [old index, new index] of each context line (section 5). */
interface Match {
  o: string[];
  n: string[];
  pairs: Array<[number, number]>;
}

function tierText(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const ot = o.map((l) => tierText(l, tier));
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierText(lines[i + j]!, tier) !== ot[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Replace O at `pos` by N, writing context lines as the file's own and re-indenting at tier 2 (section 5). */
function applyMatch(lines: string[], pos: number, m: Match, tier: number): string[] {
  const f = m.o.length > 0 ? leadingWs(lines[pos] ?? '') : '';
  const p = m.o.length > 0 ? leadingWs(m.o[0]!) : '';
  const nCtx = new Map<number, number>(m.pairs.map(([oi, ni]) => [ni, oi]));
  const repl = m.n.map((ln, j) => {
    const oi = nCtx.get(j);
    if (oi !== undefined) return lines[pos + oi]!;
    if (tier === 2 && m.o.length > 0 && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) return f + ln.slice(p.length);
    return ln;
  });
  const out = lines.slice();
  out.splice(pos, m.o.length, ...repl);
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start line (1-based, 0 when it inserts at the top) and its body. */
interface Hunk {
  a: number;
  body: string[];
  backslashAfterLast: boolean;
  lastPlusBackslash: boolean;
  match: Match;
}

/** O, N and context pairs from a hunk or chunk body (` ` and empty lines are context). */
function buildMatch(body: string[]): Match {
  const o: string[] = [];
  const n: string[] = [];
  const pairs: Array<[number, number]> = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      pairs.push([o.length, n.length]);
      o.push(l === '' ? '' : l.slice(1));
      n.push(l === '' ? '' : l.slice(1));
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push(l.slice(1));
    }
  }
  return { o, n, pairs };
}

function hunkFromBody(a: number, body: string[]): Hunk {
  let backslashAfterLast = false;
  let lastPlusBackslash = false;
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxOrPlus = idx;
    if (l.startsWith('+')) lastPlus = idx;
  });
  if (lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]!.startsWith('\\')) backslashAfterLast = true;
  if (lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\')) lastPlusBackslash = true;
  return { a, body, backslashAfterLast, lastPlusBackslash, match: buildMatch(body) };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  oldFromPair: boolean;
  newFromPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply a section's hunks in order to a file's state (section 6). */
function applyUnifiedHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = h.match;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const lines = cur.lines.slice();
      lines.splice(at, 0, ...n);
      const fin = n.length > 0 && at === cur.lines.length ? !h.backslashAfterLast : cur.final;
      cur = { lines, br: cur.br, final: fin };
    } else {
      const found = firstTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEof = best + o.length === cur.lines.length;
      const lines = applyMatch(cur.lines, best, h.match, found.tier);
      const fin = touchesEof ? !h.backslashAfterLast : cur.final;
      cur = { lines, br: cur.br, final: fin };
    }
    d += n.length - o.length;
  }
  return cur;
}

/** Parse a unified diff patch into edits (section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, oldFromPair: false, newFromPair: false, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.oldPath = m[1]!;
      s.newPath = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          j += 1;
          continue;
        }
        break;
      }
      const body = lines.slice(i + 1, j);
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(hunkFromBody(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.oldFromPair = true;
        cur.newFromPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.newPath = headerPath(l);
        cur.newFromPair = true;
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.oldFromPair) cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.newFromPair) cur.newPath = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.oldPath = headerPath(l);
      s.newPath = headerPath(lines[i + 1]!);
      s.oldFromPair = true;
      s.newFromPair = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
      let lastBackslash = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.body.some((l) => l.startsWith('+'))) {
          lastBackslash = sec.hunks[k]!.lastPlusBackslash;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldText = tree.get(oldP!);
    if (oldText === null) throw new Fail('missing', oldP!);
    if (newP !== oldP) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const done = applyUnifiedHunks(parseFile(oldText), sec.hunks, strict, oldP!);
      tree.now.set(newP!, renderFile(done));
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const done = applyUnifiedHunks(parseFile(oldText), sec.hunks, strict, oldP!);
    tree.now.set(oldP!, renderFile(done));
  });
}

/** Parse SEARCH/REPLACE blocks into edits (section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let sep = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    let end = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k++) {
        const t = lines[k]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = parseFile(before);
      const found = firstTier(state.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const out = applyMatch(state.lines, found.positions[0]!, { o: oldLines, n: newLines, pairs: [] }, found.tier);
      tree.now.set(p, renderFile({ lines: out, br: state.br, final: state.final }));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/** A V4A chunk: its anchor (null: none), whether it is anchored to the end of the file, and its match. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  match: Match;
}

/** Parse a V4A patch into edits (section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionStart = i;
    i += 1;
    const start = i;
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      i += 1;
    }
    const body = lines.slice(start, i);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${start + k + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: cur.anchor, eof: cur.eof, match: buildMatch(cur.body) });
          cur = null;
        }
      };
      for (; j < body.length; j++) {
        const bl = body[j]!;
        if (bl.startsWith('@@')) {
          flush();
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (bl === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          flush();
        } else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(bl);
        } else {
          throw new Exit2(`error: parse ${start + j + 1}`);
        }
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionStart + 1}`);
      const p = path;
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        let state = parseFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const a = firstTier(state.lines, [ch.anchor], cursor, strict);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.positions[0]! + 1;
          }
          const { o, n } = ch.match;
          if (o.length === 0) {
            const at = ch.eof ? state.lines.length : cursor;
            const next = state.lines.slice();
            next.splice(at, 0, ...n);
            state = { lines: next, br: state.br, final: state.final };
            cursor = at + n.length;
          } else {
            const found = firstTier(state.lines, o, cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            let pos: number | null = null;
            for (const cand of found.positions) {
              if (ch.eof && cand + o.length !== state.lines.length) continue;
              pos = cand;
              break;
            }
            if (pos === null) throw new Fail('no-match', p);
            const next = applyMatch(state.lines, pos, ch.match, found.tier);
            state = { lines: next, br: state.br, final: state.final };
            cursor = pos + n.length;
          }
        }
        const out = renderFile(state);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) moved.set(oldP, newP);
  }
  const movedNew = new Set(moved.values());
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moved.has(p)) continue;
    if (movedNew.has(p)) {
      const oldP = [...moved.entries()].find(([, n]) => n === p)![0]!;
      rows.push({ key: p, line: `R ${oldP} -> ${p}` });
      continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
