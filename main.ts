// mend: one patch tool for every AI edit format.
//
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first matching tier that has one, and writes
// every change or none. Node 22, standard library only, run as
// `node main.ts [options] [PATCH]` from the root of a tree of text files.
//
// The whole contract is SPEC.md. This file implements it directly: argument
// handling, format detection, the four readers, three-tier line matching,
// the all-or-nothing write, and the trial hand-over at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type FormatName = (typeof FORMAT_NAMES)[number];

/** A parse failure: exit 2 with `error: parse <line>`. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`error: parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

/** A patch's lines: split at \n, one trailing \r removed, no empty tail. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function requireSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFault('unsafe', p);
}

/** A file's own line break, its lines, and whether it ends with a break. */
interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const pieces = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) pieces.pop();
  return { lines: pieces, br, finalBreak };
}

function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.finalBreak ? parts.br : '');
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The tree as edits leave it, read lazily from disk. */
class Workspace {
  private readonly disk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  diskText(p: string): string | null {
    if (!this.disk.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.disk.set(p, value);
    }
    return this.disk.get(p)!;
  }

  text(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.diskText(p);
  }

  set(p: string, value: string | null): void {
    this.current.set(p, value);
  }

  snapshot(): { current: Map<string, string | null>; moves: number } {
    return { current: new Map(this.current), moves: this.moves.length };
  }

  restore(snap: { current: Map<string, string | null>; moves: number }): void {
    this.current.clear();
    for (const [k, v] of snap.current) this.current.set(k, v);
    this.moves.length = snap.moves;
  }
}

/** One parsed edit, applied to the workspace or throwing an EditFault. */
type Edit = (ws: Workspace) => void;

// ---- three-tier line matching (SPEC section 5) ----

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimTrailWs(line);
  return trimBothWs(line);
}

function tierOccurrences(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (oldLines.length === 0) return found;
  const last = fileLines.length - oldLines.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (tierKey(fileLines[i + j]!, tier) !== tierKey(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/**
 * The first tier (0, then 1, then 2; only 0 when strict) with an occurrence
 * at or after `from`, restricted to occurrences ending at the file's last
 * line when `toEnd` is set.
 */
function firstTierHit(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  toEnd: boolean,
): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let positions = tierOccurrences(fileLines, oldLines, tier, from);
    if (toEnd) positions = positions.filter((i) => i + oldLines.length === fileLines.length);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of an old block (O) or a new block (N). */
interface BlockLine {
  text: string;
  context: boolean;
}

/**
 * Build the lines that replace a matched occurrence. Context lines come
 * from the file itself; other new lines are re-indented at tier 2.
 */
function buildReplacement(
  fileLines: string[],
  at: number,
  oldBlock: BlockLine[],
  newBlock: BlockLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  // Context lines in O and N pair up in order; each takes the file's line.
  const fileForContext: string[] = [];
  for (let k = 0; k < oldBlock.length; k += 1) {
    if (oldBlock[k]!.context) fileForContext.push(fileLines[at + k]!);
  }
  let ctxSeen = 0;
  const patchLead = oldBlock.length > 0 ? leadWs(oldBlock[0]!.text) : '';
  const fileLead = fileLines.length > at ? leadWs(fileLines[at]!) : '';
  for (const entry of newBlock) {
    if (entry.context) {
      out.push(fileForContext[ctxSeen]!);
      ctxSeen += 1;
      continue;
    }
    if (tier === 2 && entry.text !== '' && entry.text.trim() !== '' && entry.text.startsWith(patchLead)) {
      out.push(fileLead + entry.text.slice(patchLead.length));
    } else {
      out.push(entry.text);
    }
  }
  return out;
}

// ---- JSON edits (SPEC section 9) ----

function jsonEditObject(value: unknown, faultLine: number): Edit {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ParseFault(faultLine);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') throw new ParseFault(faultLine);
  const path = obj.path as string;

  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new ParseFault(faultLine);
    const text = obj.file_text as string;
    return (ws) => {
      requireSafe(path);
      if (ws.text(path) !== null) throw new EditFault('exists', path);
      ws.set(path, text);
    };
  }

  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new ParseFault(faultLine);
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') throw new ParseFault(faultLine);
    const oldStr = obj.old_str as string;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (ws) => {
      requireSafe(path);
      const before = ws.text(path);
      if (before === null) throw new EditFault('missing', path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = body.indexOf(needle); k >= 0; k = body.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const at = body.indexOf(needle);
      const out = body.slice(0, at) + toLf(newStr) + body.slice(at + needle.length);
      ws.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) {
      throw new ParseFault(faultLine);
    }
    if (typeof obj.new_str !== 'string') throw new ParseFault(faultLine);
    const atLine = obj.insert_line as number;
    const added = splitPatch(obj.new_str as string);
    return (ws) => {
      requireSafe(path);
      const before = ws.text(path);
      if (before === null) throw new EditFault('missing', path);
      const parts = splitFile(before);
      if (atLine < 0 || atLine > parts.lines.length) throw new EditFault('no-match', path);
      const lines = [...parts.lines];
      lines.splice(atLine, 0, ...added);
      ws.set(path, joinFile({ lines, br: parts.br, finalBreak: parts.finalBreak }));
    };
  }

  throw new ParseFault(faultLine);
}

function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(first + 1);
    for (const item of parsed) edits.push(jsonEditObject(item, first + 1));
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ParseFault(i + 1);
    }
    edits.push(jsonEditObject(parsed, i + 1));
  });
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimTrailWs(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const candidate = lines[j]!;
      if (!isBlank(candidate) && !candidate.trim().startsWith('```')) {
        path = candidate.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFault(searchLine);
    }
    const foundPath = path;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (trimTrailWs(lines[j]!) === '=======') {
        sep = j;
        break;
      }
      if (trimTrailWs(lines[j]!) === '>>>>>>> REPLACE') throw new ParseFault(searchLine);
    }
    if (sep < 0) throw new ParseFault(searchLine);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (trimTrailWs(lines[j]!) === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(searchLine);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push((ws) => {
      requireSafe(foundPath);
      if (oldLines.length === 0) {
        if (ws.text(foundPath) !== null) throw new EditFault('exists', foundPath);
        ws.set(foundPath, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = ws.text(foundPath);
      if (before === null) throw new EditFault('missing', foundPath);
      const parts = splitFile(before);
      const hit = firstTierHit(parts.lines, oldLines, strict, 0, false);
      if (hit === null) throw new EditFault('no-match', foundPath);
      if (hit.positions.length > 1) throw new EditFault('ambiguous', foundPath);
      const at = hit.positions[0]!;
      const oldBlock: BlockLine[] = oldLines.map((t) => ({ text: t, context: false }));
      const newBlock: BlockLine[] = newLines.map((t) => ({ text: t, context: false }));
      const replacement = buildReplacement(parts.lines, at, oldBlock, newBlock, hit.tier);
      const linesNow = [...parts.lines];
      linesNow.splice(at, oldLines.length, ...replacement);
      ws.set(foundPath, joinFile({ lines: linesNow, br: parts.br, finalBreak: parts.finalBreak }));
    });
    prevPath = foundPath;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldBlock: BlockLine[];
  newBlock: BlockLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function stripTrailingBlankContext(chunk: V4aChunk): void {
  while (chunk.oldBlock.length > 0) {
    const o = chunk.oldBlock[chunk.oldBlock.length - 1]!;
    const n = chunk.newBlock[chunk.newBlock.length - 1]!;
    if (o.context && n.context && o.text === '' && n.text === '') {
      chunk.oldBlock.pop();
      chunk.newBlock.pop();
    } else break;
  }
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  if (lines.length === 0) throw new ParseFault(1);
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !isBlank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  let sawChunk = false;
  let afterEof = false;

  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
    if (cur.kind === 'update') {
      const lastChunk = cur.chunks[cur.chunks.length - 1];
      if (lastChunk !== undefined) stripTrailingBlankContext(lastChunk);
      if (!sawChunk && cur.moveTo === null) throw new ParseFault(cur.headerLine);
    }
    sections.push(cur);
    cur = null;
    chunk = null;
    sawChunk = false;
    afterEof = false;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      finishSection();
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      const prefixLen = kind === 'add' ? 14 : 17;
      cur = {
        kind,
        path: line.slice(prefixLen).trim(),
        headerLine: i + 1,
        moveTo: null,
        addLines: [],
        chunks: [],
      };
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseFault(i + 1);
    }
    if (cur.kind === 'add') {
      if (isBlank(line)) {
        cur.addLines.push('');
        continue;
      }
      if (line.startsWith('+')) {
        cur.addLines.push(line.slice(1));
        continue;
      }
      throw new ParseFault(i + 1);
    }
    if (cur.kind === 'delete') {
      if (isBlank(line)) continue;
      throw new ParseFault(i + 1);
    }
    // Update File section.
    if (line.startsWith('*** Move to: ')) {
      if (chunk === null && !sawChunk && cur.moveTo === null) {
        cur.moveTo = line.slice(13).trim();
        continue;
      }
      throw new ParseFault(i + 1);
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, oldBlock: [], newBlock: [] };
      cur.chunks.push(chunk);
      sawChunk = true;
      afterEof = false;
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) throw new ParseFault(i + 1);
      chunk.eof = true;
      chunk = null;
      afterEof = true;
      continue;
    }
    if (isBlank(line)) {
      if (chunk === null) {
        if (sawChunk) continue;
        chunk = { anchor: null, eof: false, oldBlock: [], newBlock: [] };
        cur.chunks.push(chunk);
        sawChunk = true;
      }
      chunk.oldBlock.push({ text: '', context: true });
      chunk.newBlock.push({ text: '', context: true });
      continue;
    }
    const marker = line[0]!;
    if (marker === ' ' || marker === '-' || marker === '+') {
      if (chunk === null) {
        if (sawChunk || afterEof) throw new ParseFault(i + 1);
        chunk = { anchor: null, eof: false, oldBlock: [], newBlock: [] };
        cur.chunks.push(chunk);
        sawChunk = true;
      }
      if (marker === ' ') {
        const text = line.slice(1);
        chunk.oldBlock.push({ text, context: true });
        chunk.newBlock.push({ text, context: true });
      } else if (marker === '-') {
        chunk.oldBlock.push({ text: line.slice(1), context: false });
      } else {
        chunk.newBlock.push({ text: line.slice(1), context: false });
      }
      continue;
    }
    throw new ParseFault(i + 1);
  }
  finishSection();

  return sections.map((section) => {
    if (section.kind === 'add') {
      const made = section.addLines.length === 0 ? '' : `${section.addLines.join('\n')}\n`;
      return (ws: Workspace) => {
        requireSafe(section.path);
        if (ws.text(section.path) !== null) throw new EditFault('exists', section.path);
        ws.set(section.path, made);
      };
    }
    if (section.kind === 'delete') {
      return (ws: Workspace) => {
        requireSafe(section.path);
        if (ws.text(section.path) === null) throw new EditFault('missing', section.path);
        ws.set(section.path, null);
      };
    }
    const chunks = section.chunks;
    return (ws: Workspace) => {
      requireSafe(section.path);
      if (section.moveTo !== null) requireSafe(section.moveTo);
      const before = ws.text(section.path);
      if (before === null) throw new EditFault('missing', section.path);
      if (section.moveTo !== null && ws.text(section.moveTo) !== null) {
        throw new EditFault('exists', section.moveTo);
      }
      const parts = splitFile(before);
      const lines = [...parts.lines];
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const hit = firstTierHit(lines, [c.anchor], strict, cursor, false);
          if (hit === null) throw new EditFault('no-match', section.path);
          cursor = hit.positions[0]! + 1;
        }
        if (c.oldBlock.length === 0) {
          const at = c.eof ? lines.length : cursor;
          const inserted = c.newBlock.map((e) => e.text);
          lines.splice(at, 0, ...inserted);
          cursor = at + inserted.length;
          continue;
        }
        const oldTexts = c.oldBlock.map((e) => e.text);
        const hit = firstTierHit(lines, oldTexts, strict, cursor, c.eof);
        if (hit === null) throw new EditFault('no-match', section.path);
        const at = hit.positions[0]!;
        const replacement = buildReplacement(lines, at, c.oldBlock, c.newBlock, hit.tier);
        lines.splice(at, oldTexts.length, ...replacement);
        cursor = at + replacement.length;
      }
      const out = joinFile({ lines, br: parts.br, finalBreak: parts.finalBreak });
      if (section.moveTo !== null) {
        ws.set(section.moveTo, out);
        ws.set(section.path, null);
        ws.moves.push([section.path, section.moveTo]);
      } else {
        ws.set(section.path, out);
      }
    };
  });
}

// ---- Unified diffs (SPEC section 6) ----

interface UnifiedHunk {
  start: number;
  oldBlock: BlockLine[];
  newBlock: BlockLine[];
  tailNoNewline: boolean;
  plusNoNewline: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: UnifiedHunk[];
}

function parseDiffGitPaths(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) throw new ParseFault(lineNo);
  return [m[1]!, m[2]!];
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new ParseFault(lineNo);
  return Number(m[1]);
}

function stripDiffPrefix(raw: string): string | null {
  if (raw === '/dev/null') return null;
  let p = raw;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  return stripDiffPrefix(raw.trim());
}

function buildUnifiedHunk(body: string[], start: number): UnifiedHunk {
  const oldBlock: BlockLine[] = [];
  const newBlock: BlockLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const line = body[k]!;
    const marker = line[0]!;
    if (line === '') {
      // An empty body line is a context line whose text is empty.
      oldBlock.push({ text: '', context: true });
      newBlock.push({ text: '', context: true });
      lastCtxOrPlus = k;
    } else if (marker === ' ') {
      const text = line.slice(1);
      oldBlock.push({ text, context: true });
      newBlock.push({ text, context: true });
      lastCtxOrPlus = k;
    } else if (marker === '-') {
      oldBlock.push({ text: line.slice(1), context: false });
    } else if (marker === '+') {
      newBlock.push({ text: line.slice(1), context: false });
      lastCtxOrPlus = k;
      lastPlus = k;
    }
  }
  const followsBackslash = (idx: number): boolean =>
    idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return {
    start,
    oldBlock,
    newBlock,
    tailNoNewline: followsBackslash(lastCtxOrPlus),
    plusNoNewline: followsBackslash(lastPlus),
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: {
    gitOld: string | null;
    gitNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    pairOld: string | null | undefined;
    pairNew: string | null | undefined;
    createFlag: boolean;
    deleteFlag: boolean;
    hunks: UnifiedHunk[];
    phase: 'header' | 'hunks';
  } | null = null;

  const closeSection = (): void => {
    if (cur === null) return;
    const oldPath = cur.pairOld !== undefined ? cur.pairOld : (cur.renameFrom ?? cur.gitOld);
    const newPath = cur.pairNew !== undefined ? cur.pairNew : (cur.renameTo ?? cur.gitNew);
    sections.push({
      oldPath,
      newPath,
      createFlag: cur.createFlag,
      deleteFlag: cur.deleteFlag,
      hunks: cur.hunks,
    });
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [gOld, gNew] = parseDiffGitPaths(line, i + 1);
      closeSection();
      cur = {
        gitOld: gOld,
        gitNew: gNew,
        renameFrom: null,
        renameTo: null,
        pairOld: undefined,
        pairNew: undefined,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
        phase: 'header',
      };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && cur.phase === 'header' && cur.pairOld === undefined) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
      } else {
        closeSection();
        cur = {
          gitOld: null,
          gitNew: null,
          renameFrom: null,
          renameTo: null,
          pairOld: oldP,
          pairNew: newP,
          createFlag: false,
          deleteFlag: false,
          hunks: [],
          phase: 'header',
        };
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const start = parseHunkHeader(line, i + 1);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildUnifiedHunk(body, start));
      cur.phase = 'hunks';
      i = j;
      continue;
    }
    if (cur !== null && cur.phase === 'header') {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  closeSection();

  return sections.map((section) => {
    const isCreate = section.createFlag || section.oldPath === null;
    const isDelete = !isCreate && (section.deleteFlag || section.newPath === null);
    const isMove = !isCreate && !isDelete && section.oldPath !== null && section.newPath !== null && section.oldPath !== section.newPath;
    if (isCreate) {
      const newPath = section.newPath ?? '';
      const createdLines: string[] = [];
      let noNewline = false;
      for (const h of section.hunks) {
        for (const e of h.newBlock) if (!e.context) createdLines.push(e.text);
      }
      for (let k = section.hunks.length - 1; k >= 0; k -= 1) {
        const h = section.hunks[k]!;
        if (h.newBlock.some((e) => !e.context)) {
          noNewline = h.plusNoNewline;
          break;
        }
      }
      const made = createdLines.length === 0 ? '' : `${createdLines.join('\n')}${noNewline ? '' : '\n'}`;
      return (ws: Workspace) => {
        requireSafe(newPath);
        if (ws.text(newPath) !== null) throw new EditFault('exists', newPath);
        ws.set(newPath, made);
      };
    }
    if (isDelete) {
      const oldPath = section.oldPath as string;
      return (ws: Workspace) => {
        requireSafe(oldPath);
        if (ws.text(oldPath) === null) throw new EditFault('missing', oldPath);
        ws.set(oldPath, null);
      };
    }
    if (isMove) {
      const oldPath = section.oldPath as string;
      const newPath = section.newPath as string;
      return (ws: Workspace) => {
        requireSafe(oldPath);
        requireSafe(newPath);
        const before = ws.text(oldPath);
        if (before === null) throw new EditFault('missing', oldPath);
        if (ws.text(newPath) !== null) throw new EditFault('exists', newPath);
        const out = applyUnifiedHunks(before, section.hunks, strict, oldPath);
        ws.set(newPath, out);
        ws.set(oldPath, null);
        ws.moves.push([oldPath, newPath]);
      };
    }
    const path = section.oldPath as string;
    return (ws: Workspace) => {
      requireSafe(path);
      const before = ws.text(path);
      if (before === null) throw new EditFault('missing', path);
      const out = applyUnifiedHunks(before, section.hunks, strict, path);
      ws.set(path, out);
    };
  });
}

function applyUnifiedHunks(before: string, hunks: UnifiedHunk[], strict: boolean, failPath: string): string {
  const blocks = hunks.map((h) => ({
    oldBlock: h.oldBlock,
    newBlock: h.newBlock,
    insertAt: h.start,
    noNewlineAtEnd: h.tailNoNewline,
  }));
  // Nearest-occurrence choice for non-empty old blocks; empty blocks insert
  // after `insertAt` lines (the shared helper's default insert position).
  const parts = splitFile(before);
  const lines = [...parts.lines];
  let finalBreak = parts.finalBreak;
  let drift = 0;
  for (const h of hunks) {
    if (h.oldBlock.length === 0) {
      const at = Math.min(Math.max(h.start + drift, 0), lines.length);
      const atEnd = at === lines.length;
      const inserted = h.newBlock.map((e) => e.text);
      lines.splice(at, 0, ...inserted);
      if (atEnd) finalBreak = !h.tailNoNewline;
      drift += inserted.length;
      continue;
    }
    const oldTexts = h.oldBlock.map((e) => e.text);
    const hit = firstTierHit(lines, oldTexts, strict, 0, false);
    if (hit === null) throw new EditFault('no-match', failPath);
    const target = h.start - 1 + drift;
    let at = hit.positions[0]!;
    let best = Math.abs(at - target);
    for (const pos of hit.positions) {
      const d = Math.abs(pos - target);
      if (d < best) {
        best = d;
        at = pos;
      }
    }
    const replacement = buildReplacement(lines, at, h.oldBlock, h.newBlock, hit.tier);
    const runsToEnd = at + oldTexts.length === lines.length;
    lines.splice(at, oldTexts.length, ...replacement);
    if (runsToEnd) finalBreak = !h.tailNoNewline;
    drift += replacement.length - oldTexts.length;
  }
  return joinFile({ lines, br: parts.br, finalBreak });
}

// ---- format detection (SPEC section 4) ----

function detectFormat(lines: string[]): FormatName | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => trimTrailWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---- invocation, output and the all-or-nothing write (SPEC 1, 2, 10) ----

interface RunResult {
  code: number;
  out: string[];
}

function run(argv: string[]): RunResult {
  let format: FormatName | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of argv) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const value = arg.slice('--format='.length);
        if (!(FORMAT_NAMES as readonly string[]).includes(value)) return { code: 2, out: ['error: usage'] };
        format = value as FormatName;
      } else if (arg === '--check') {
        if (checkOnly) return { code: 2, out: ['error: usage'] };
        checkOnly = true;
      } else if (arg === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);
  const kind: FormatName | null = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJsonEdits(patchText, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const ws = new Workspace();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snap = ws.snapshot();
    try {
      edit(ws);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      ws.restore(snap);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }

  // Changed paths, with successful moves folded into R lines.
  interface Row {
    key: string;
    text: string;
  }
  const rowsByPath = new Map<string, Row>();
  for (const p of [...ws.current.keys()]) {
    const was = ws.diskText(p);
    const now = ws.current.get(p)!;
    if (was === now) continue;
    const text = was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    rowsByPath.set(p, { key: p, text });
  }
  for (const [oldP, newP] of ws.moves) {
    const gone = rowsByPath.get(oldP);
    const born = rowsByPath.get(newP);
    if (gone !== undefined && born !== undefined && gone.text.startsWith('D ') && born.text.startsWith('A ')) {
      rowsByPath.delete(oldP);
      rowsByPath.delete(newP);
      rowsByPath.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const rows = [...rowsByPath.values()].sort((a, b) => byteOrder(a.key, b.key));

  if (!checkOnly) {
    for (const [p, now] of [...ws.current.entries()]) {
      const was = ws.diskText(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
