// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed
// or why it failed. SPEC.md is the whole contract.
//
// Node 22 or later, standard library only. Run as:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// An exit-2 error carries exactly one output line.
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// One edit's failure: a code and the path it concerns.
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

// A patch's lines: split at \n, one trailing \r removed from each, and no
// empty piece after a final \n. Patch line numbers count these from 1.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ..
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3)
// ---------------------------------------------------------------------------

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

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC section 5)
// ---------------------------------------------------------------------------

// Old lines, new lines, and the [old index, new index] of each context line.
interface OldNew {
  o: string[];
  n: string[];
  pairs: Array<[number, number]>;
}

function tierOf(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Every 0-based position at or after `from` where O occurs at `tier`.
// Occurrences may overlap.
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (o.length === 0) return found;
  const ot = o.map((l) => tierOf(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierOf(lines[i + j]!, tier) !== ot[j]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

// The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its
// positions. Null when O occurs at no tier.
function firstTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// Replace O at `pos` by N. A context line is written as the file's own
// matched line, never the patch's. At tier 2 every other line of N is
// re-indented: F is the leading spaces and tabs of the file's first matched
// line, P those of O's first line; a non-blank line of N starting with P has
// that P replaced by F (P may be empty, so F is then prepended).
function applyReplacement(lines: string[], pos: number, m: OldNew, tier: number): string[] {
  const f = m.o.length > 0 ? leadingWs(lines[pos] ?? '') : '';
  const p = m.o.length > 0 ? leadingWs(m.o[0]!) : '';
  const ctx = new Map<number, number>();
  for (const [oi, ni] of m.pairs) ctx.set(ni, oi);
  const repl = m.n.map((ln, j) => {
    const oi = ctx.get(j);
    if (oi !== undefined) return lines[pos + oi]!;
    if (tier === 2 && m.o.length > 0 && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) {
      return f + ln.slice(p.length);
    }
    return ln;
  });
  const out = lines.slice();
  out.splice(pos, m.o.length, ...repl);
  return out;
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

// One JSON edit object, or null when it is not one.
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
  bsAfterLast: boolean;
  bsAfterLastPlus: boolean;
  match: OldNew;
}

// O, N and context pairs from a hunk or chunk body. Lines starting with a
// space and empty lines are context lines (an empty line is a context line
// whose text is empty); `-` lines are old, `+` lines are new; `\` lines are
// markers and carry no text.
function matchFromBody(body: string[]): OldNew {
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

function makeHunk(a: number, body: string[]): Hunk {
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = idx;
    if (l.startsWith('+')) lastPlus = idx;
  });
  const bsAfterLast =
    lastCtxPlus >= 0 &&
    body[lastCtxPlus + 1] !== undefined &&
    body[lastCtxPlus + 1]!.startsWith('\\');
  const bsAfterLastPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, body, bsAfterLast, bsAfterLastPlus, match: matchFromBody(body) };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  oldByPair: boolean;
  newByPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

// The path after `--- ` or `+++ `: text after the four characters, up to the
// first tab, surrounding spaces removed; /dev/null means no file; a leading
// a/ or b/ is removed.
function headPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

// Apply a section's hunks in order, each to the result of the ones before it.
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = h.match;
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const lines = cur.lines.slice();
      lines.splice(at, 0, ...n);
      const fin = n.length > 0 && at === cur.lines.length ? !h.bsAfterLast : cur.final;
      cur = { lines, br: cur.br, final: fin };
    } else {
      const found = firstTier(cur.lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEof = best + o.length === cur.lines.length;
      const lines = applyReplacement(cur.lines, best, h.match, found.tier);
      cur = { lines, br: cur.br, final: atEof ? !h.bsAfterLast : cur.final };
    }
    d += n.length - o.length;
  }
  return cur;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const begin = (): Section => {
    const s: Section = {
      oldPath: null,
      newPath: null,
      oldByPair: false,
      newByPair: false,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = begin();
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
        if (
          bl === '' ||
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\')
        ) {
          j += 1;
          continue;
        }
        break;
      }
      const body = lines.slice(i + 1, j);
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headPath(l);
        cur.newPath = headPath(lines[i + 1]!);
        cur.oldByPair = true;
        cur.newByPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.newPath = headPath(l);
        cur.newByPair = true;
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.oldByPair) cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.newByPair) cur.newPath = l.slice(10).trim();
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
      const s = begin();
      s.oldPath = headPath(l);
      s.newPath = headPath(lines[i + 1]!);
      s.oldByPair = true;
      s.newByPair = true;
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
      for (const h of sec.hunks) {
        for (const bl of h.body) if (bl.startsWith('+')) plus.push(bl.slice(1));
      }
      let lastBs = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.body.some((bl) => bl.startsWith('+'))) {
          lastBs = sec.hunks[k]!.bsAfterLastPlus;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    if (newP !== oldP) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const done = applyHunks(parseFile(before), sec.hunks, strict, oldP!);
      tree.now.set(newP!, renderFile(done));
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const done = applyHunks(parseFile(before), sec.hunks, strict, oldP!);
    tree.now.set(oldP!, renderFile(done));
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

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
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const out = applyReplacement(
        state.lines,
        found.at[0]!,
        { o: oldLines, n: newLines, pairs: [] },
        found.tier,
      );
      tree.now.set(p, renderFile({ lines: out, br: state.br, final: state.final }));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  match: OldNew;
}

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
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
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
    const secLine = i;
    i += 1;
    const start = i;
    while (i < last) {
      const t = lines[i]!;
      if (
        t.startsWith('*** Add File: ') ||
        t.startsWith('*** Delete File: ') ||
        t.startsWith('*** Update File: ')
      ) {
        break;
      }
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
          chunks.push({ anchor: cur.anchor, eof: cur.eof, match: matchFromBody(cur.body) });
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
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine + 1}`);
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
            cursor = a.at[0]! + 1;
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
            for (const cand of found.at) {
              if (ch.eof && cand + o.length !== state.lines.length) continue;
              pos = cand;
              break;
            }
            if (pos === null) throw new Fail('no-match', p);
            const next = applyReplacement(state.lines, pos, ch.match, found.tier);
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

// The exit-0 report rows for a finished tree: one line per path whose state
// changed, in UTF-8 byte order of the paths. A move that succeeded is one
// `R <old> -> <new>` line, sorted by <new>, and replaces that pair's D and A
// lines. A file whose bytes end up unchanged is not listed.
function reportRows(tree: Tree): Array<{ key: string; line: string }> {
  const moved = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      moved.set(oldP, newP);
    }
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
  return rows;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
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
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = reportRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )) {
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
  return {
    code: 0,
    out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
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
