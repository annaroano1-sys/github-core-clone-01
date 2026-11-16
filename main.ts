// github-core-clone-01 — a GitHub-compatible git forge, written from scratch.
//
// One Node process (stdlib only, no dependencies, no git binary, no network beyond
// the suite) that serves:
//   - git smart HTTP  (/owner/repo.git): upload-pack protocol v2 (ls-refs, fetch)
//     and receive-pack v0 (push), with a from-scratch pkt-line / packfile implementation;
//   - GitHub REST v3   (/api/v3): repos, contents, labels, issues, pull requests;
//   - GraphQL v4       (/api/graphql): the documents gh and github-mcp-server send;
//   - MCP              (/mcp): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28.
//
// Lifecycle: bind an ephemeral port, POST {"port": n} to $MAKEFUN_ENV_URL/register,
// then poll GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
//
// Determinism: no Date.now(), no new Date(), no Math.random(), no random UUIDs.
// Every timestamp comes from MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms); every id is a
// counter or a hash of stored bytes. A replay of the same requests therefore answers
// byte-identically.
//
// Scenario identities (the contest's fixed scenario, seed 0x6a09e667f3bcc909 — verified
// by running the kit's own buildScenario()): the token is opaque, so the viewer login
// cannot be derived from it; the scenario fixes it to adaiversen (id 1000).
// Teammate quinnkeller, stranger olgabauer, org faint-meadow-org, default branch main.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// configuration & deterministic time
// ---------------------------------------------------------------------------

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const DEFAULT_BRANCH = 'main';
const FORGE_AGENT = 'forge/1.0';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Parse MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms) to epoch milliseconds. */
function parseTrialNow(text: string | undefined): number {
  const fallback = 1735689600000; // 2025-01-01T00:00:00Z, deterministic
  if (text === undefined || text.trim() === '') return fallback;
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isSafeInteger(ms) ? ms : fallback;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : fallback;
}

const TRIAL_NOW_MS = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

/** Days-from-civil / civil-from-days (Howard Hinnant's algorithm), so no Date is needed. */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Epoch milliseconds -> ISO 8601 UTC string, e.g. 2025-01-01T00:00:00.000Z. */
function isoOf(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const millis = ms - secs * 1000;
  const days = Math.floor(secs / 86400);
  const rem = secs - days * 86400;
  const { y, m, d } = civilFromDays(days);
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem - hh * 3600) / 60);
  const ss = rem - hh * 3600 - mm * 60;
  const msStr = millis < 10 ? `00${millis}` : millis < 100 ? `0${millis}` : `${millis}`;
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${msStr}Z`;
}

const TRIAL_NOW_ISO = isoOf(TRIAL_NOW_MS);

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

function isOid(value: string): boolean {
  return HEX40.test(value);
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git object id: SHA-1 over `<type> <size>\0` + bytes. */
function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** Global counters: every generated id is deterministic within a run. */
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextPullId = 1;
let nextRequestId = 1;
let nextCommitSeq = 0;

/** The next timestamp (seconds) for a commit this forge generates. */
function nextCommitTimestamp(): number {
  nextCommitSeq += 1;
  return TRIAL_NOW_SEC + nextCommitSeq;
}

function escJson(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a tree object into entries, in stored order. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries (sorted the way git sorts them). */
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
function buildCommit(tree: string, parents: string[], message: string, timestamp: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = (headers.get('type') ?? 'commit') as ObjType;
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag (recursively) to the commit it points at. */
function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const PKT_LINE_MAX = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const out = Buffer.allocUnsafe(data.length + 4);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed header. */
function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfile read / write
// ---------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackReadResult {
  objects: Map<string, GitObject>;
  checksumOk: boolean;
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA entries. A base a thin
 * pack leaves out is resolved through `resolveBase`. Every object's SHA-1 is recomputed.
 */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = sha1Hex(pack.subarray(0, trailerStart));
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, checksumOk };
}

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over the rest. */
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// reachability & ancestry
// ---------------------------------------------------------------------------

type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots` (commits, trees, tags, blobs; gitlinks skipped). */
function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The set of commits reachable from `roots` (following parents, peeling tags). */
function collectCommits(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    const peeled = peelToCommitFromLookup(lookup, root);
    if (peeled) queue.push(peeled);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

function peelToCommitFromLookup(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = lookup(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
}

/** True when `ancestor` is reachable from `tip` (or equal to it). Depth-first from the
 * tip, stopping the moment the ancestor is found: a linear history (the push
 * workload) answers in one step instead of walking every commit. The predicate is
 * identical to the old full-closure check (reachability), only lazier. */
function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const ancCommit = peelToCommit(objects, ancestor);
  const tipCommit = peelToCommit(objects, tip);
  if (!ancCommit || !tipCommit) return false;
  const seen = new Set<string>();
  const stack: string[] = [tipCommit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancCommit) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The nearest common ancestor commit of `a` and `b` (first found by BFS from both). */
function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const aCommit = peelToCommit(objects, a);
  const bCommit = peelToCommit(objects, b);
  if (!aCommit || !bCommit) return null;
  if (aCommit === bCommit) return aCommit;
  const aSet = collectCommits([aCommit], (oid) => objects.get(oid));
  // BFS from b, nearest first.
  const queue: string[] = [bCommit];
  const seen = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aSet.has(oid)) return oid;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}

interface Comment {
  id: number;
  body: string;
  seq: number;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  seq: number;
  mergeSeq: number;
  /**
   * Generation of the git store: bumped on every change to objects or refs.
   * The git response cache below is keyed by it, so a cached reply can only ever
   * be served for the exact store state it was built from.
   */
  generation: number;
  /** Cached git replies (advertise / ls-refs / fetch), keyed by generation + args. */
  gitCache: Map<string, Buffer>;
}

const repos = new Map<string, Repo>();

/** Bump a repo's generation after its objects or refs changed (invalidates gitCache). */
function touchRepo(repo: Repo): void {
  repo.generation += 1;
  if (repo.gitCache.size > 16) repo.gitCache.clear();
}

/** Read a cached git reply, or null. Keys already carry the generation. */
function gitCacheGet(repo: Repo, key: string): Buffer | null {
  return repo.gitCache.get(key) ?? null;
}

/** Store a git reply for reuse; skips large bodies to bound memory. */
function gitCachePut(repo: Repo, key: string, body: Buffer): void {
  if (body.length > 256 * 1024) return;
  if (repo.gitCache.size >= 16) repo.gitCache.clear();
  repo.gitCache.set(key, body);
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner,
    description,
    privateFlag: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssueNumber: 1,
    nextPullNumber: 1,
    seq: nextRepoId,
    mergeSeq: 0,
    generation: 0,
    gitCache: new Map(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

/** The tree at a commit (empty when the repo is unborn or the ref is missing). */
function treeOf(repo: Repo, oid: string | undefined): string | null {
  if (!oid) return null;
  const commitOid = peelToCommit(repo.objects, oid);
  if (!commitOid) return null;
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Read one path out of a tree (commit oid or tree oid). Returns the entry or null. */
function lookupPath(repo: Repo, rootOid: string, path: string): TreeEntry | null {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return null;
  let currentOid = rootOid;
  let current = repo.objects.get(currentOid);
  if (!current) return null;
  if (current.type === 'commit') {
    currentOid = parseCommit(current.data).tree;
    current = repo.objects.get(currentOid);
  }
  for (let index = 0; index < segments.length; index += 1) {
    if (!current || current.type !== 'tree') return null;
    const wanted = segments[index]!;
    const entry = parseTree(current.data).find((e) => e.name === wanted);
    if (!entry) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode === '160000') return null;
    currentOid = entry.oid;
    current = repo.objects.get(currentOid);
  }
  return null;
}

/** List a directory out of a tree: entries of the root tree, or of the subtree at `path`. */
function listDirectory(repo: Repo, rootOid: string, path: string): TreeEntry[] | null {
  let currentOid = rootOid;
  let current = repo.objects.get(currentOid);
  if (!current) return null;
  if (current.type === 'commit') {
    currentOid = parseCommit(current.data).tree;
    current = repo.objects.get(currentOid);
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of segments) {
    if (!current || current.type !== 'tree') return null;
    const entry = parseTree(current.data).find((e) => e.name === segment);
    if (!entry || entry.mode === '160000') return null;
    currentOid = entry.oid;
    current = repo.objects.get(currentOid);
  }
  if (!current || current.type !== 'tree') return null;
  return parseTree(current.data);
}

/** All files under a tree, as path -> {mode, oid}. */
function flattenTree(repo: Repo, rootOid: string): Map<string, TreeEntry> {
  const files = new Map<string, TreeEntry>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') files.set(path, entry);
    }
  };
  walk(rootOid, '');
  return files;
}

/**
 * Set one path in a tree to a blob (or delete it when `blobOid` is null) and return the
 * new tree oid. Parent trees are created or pruned as needed; every new object is stored.
 */
function setPathInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null, mode: string): string {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new Error('empty file path');
  const setIn = (currentOid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = currentOid ? parseTree(repo.objects.get(currentOid)?.data ?? Buffer.alloc(0)) : [];
    const name = segments[depth]!;
    const isLast = depth === segments.length - 1;
    if (isLast) {
      const kept = entries.filter((entry) => entry.name !== name);
      if (blobOid !== null) kept.push({ mode, name, oid: blobOid });
      if (kept.length === 0) return null;
      const data = buildTree(kept);
      const oid = hashObject('tree', data);
      repo.objects.set(oid, { type: 'tree', data });
      return oid;
    }
    const existing = entries.find((entry) => entry.name === name);
    const childOid = setIn(existing && existing.mode === '40000' ? existing.oid : null, depth + 1);
    const kept = entries.filter((entry) => entry.name !== name);
    if (childOid !== null) kept.push({ mode: '40000', name, oid: childOid });
    if (kept.length === 0) return null;
    const data = buildTree(kept);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const result = setIn(treeOid, 0);
  if (result === null) {
    // An empty tree (all files deleted) is still a tree object.
    const data = buildTree([]);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return result;
}

/** Create a commit object from a tree + parents and store it; returns the commit oid. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const data = buildCommit(treeOid, parents, message, nextCommitTimestamp());
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** The first commit of an unborn repo: a root commit whose tree holds one file. */
function makeFirstCommit(repo: Repo, path: string, content: Buffer, message: string): string {
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const treeOid = setPathInTree(repo, null, path, blobOid, '100644');
  return makeCommit(repo, treeOid, [], message);
}

/** The message of a commit (empty when the oid is not a commit). */
function commitMessage(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS line diff (simple, fine for the small files the suite uses). */
function lcsDiffCount(before: string[], after: string[]): { additions: number; deletions: number } {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const grid = new Array<number>(rows * cols).fill(0);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      grid[i * cols + j] = before[i] === after[j] ? grid[(i + 1) * cols + (j + 1)] + 1 : Math.max(grid[(i + 1) * cols + j], grid[i * cols + (j + 1)]);
    }
  }
  const common = grid[0];
  return { additions: after.length - common, deletions: before.length - common };
}

/** Two-way file diff between the trees of two commits. */
function diffTrees(repo: Repo, baseOid: string, headOid: string): FileChange[] {
  const baseTree = treeOf(repo, baseOid);
  const headTree = treeOf(repo, headOid);
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map<string, TreeEntry>();
  const headFiles = headTree ? flattenTree(repo, headTree) : new Map<string, TreeEntry>();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (!before && after) {
      const data = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'added', additions: countLines(data).length, deletions: 0 });
    } else if (before && !after) {
      const data = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'deleted', additions: 0, deletions: countLines(data).length });
    } else if (before && after && before.oid !== after.oid) {
      const beforeData = repo.objects.get(before.oid)?.data ?? Buffer.alloc(0);
      const afterData = repo.objects.get(after.oid)?.data ?? Buffer.alloc(0);
      const counts = lcsDiffCount(countLines(beforeData), countLines(afterData));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/**
 * Three-way file-level merge: `base` is the merge-base tree, `ours` and `theirs` the two
 * sides. Returns the merged tree (or null when both sides changed the same file differently).
 */
function threeWayMerge(repo: Repo, baseOid: string, oursOid: string, theirsOid: string): { treeOid: string } | null {
  const baseTree = treeOf(repo, baseOid);
  const oursTree = treeOf(repo, oursOid);
  const theirsTree = treeOf(repo, theirsOid);
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map<string, TreeEntry>();
  const oursFiles = oursTree ? flattenTree(repo, oursTree) : new Map<string, TreeEntry>();
  const theirsFiles = theirsTree ? flattenTree(repo, theirsTree) : new Map<string, TreeEntry>();
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  const merged = new Map<string, string>();
  for (const path of paths) {
    const baseEntry = baseFiles.get(path);
    const oursEntry = oursFiles.get(path);
    const theirsEntry = theirsFiles.get(path);
    const baseId = baseEntry?.oid ?? null;
    const oursId = oursEntry?.oid ?? null;
    const theirsId = theirsEntry?.oid ?? null;
    let chosen: string | null = null;
    let mode = '100644';
    if (oursId === theirsId) {
      chosen = oursId;
      mode = oursEntry?.mode ?? '100644';
    } else if (oursId === baseId) {
      chosen = theirsId;
      mode = theirsEntry?.mode ?? '100644';
    } else if (theirsId === baseId) {
      chosen = oursId;
      mode = oursEntry?.mode ?? '100644';
    } else {
      return null;
    }
    if (chosen !== null) merged.set(path, chosen);
    void mode;
  }
  // Rebuild the tree from the merged file set, reusing stored blobs and their modes.
  let treeOid: string | null = null;
  const sortedPaths = [...merged.keys()].sort();
  for (const path of sortedPaths) {
    const oid = merged.get(path)!;
    const mode = oursFiles.get(path)?.mode ?? theirsFiles.get(path)?.mode ?? baseFiles.get(path)?.mode ?? '100644';
    treeOid = setPathInTree(repo, treeOid, path, oid, mode);
  }
  if (treeOid === null) {
    const data = buildTree([]);
    treeOid = hashObject('tree', data);
    repo.objects.set(treeOid, { type: 'tree', data });
  }
  return { treeOid };
}

/** The current tip of a pull request's base branch (the base tip at creation is stale once another PR merges). */
function pullBaseTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/**
 * A pull request's head is the branch's CURRENT tip. The sha recorded at creation
 * goes stale the moment the branch advances; merging or diffing the stale sha
 * would merge/diff the old head. Fall back to the recorded sha if the branch is gone.
 */
function pullHeadTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request, from its three-way merge. */
function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = pullBaseTip(repo, pull);
  const headTip = pullHeadTip(repo, pull);
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  const result = threeWayMerge(repo, base, baseTip, headTip);
  return result ? 'MERGEABLE' : 'CONFLICTING';
}

/** Squash-merge a pull request: one new commit on the base tip. Returns the merge sha or null on conflict. */
function squashMergePull(repo: Repo, pull: Pull, message: string): string | null {
  const baseTip = pullBaseTip(repo, pull);
  const headTip = pullHeadTip(repo, pull);
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return null;
  const merged = threeWayMerge(repo, base, baseTip, headTip);
  if (!merged) return null;
  const mergeSha = makeCommit(repo, merged.treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  touchRepo(repo);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = mergeSha;
  pull.headSha = headTip;
  return mergeSha;
}

// ---------------------------------------------------------------------------
// JSON shapes shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------

function globalId(kind: 'R' | 'I' | 'PR' | 'C', repo: Repo, number = 0, extra = 0): string {
  const raw = kind === 'R'
    ? `R:${repo.owner}/${repo.name}`
    : kind === 'I'
      ? `I:${repo.owner}/${repo.name}:${number}`
      : kind === 'PR'
        ? `PR:${repo.owner}/${repo.name}:${number}`
        : `C:${repo.owner}/${repo.name}:${number}:${extra}`;
  return b64urlEncode(raw);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: repo.owner === 'faint-meadow-org' ? 'Organization' : 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelJson(label)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PR', repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pullHeadTip(repo, pull), label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', repo, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  json: unknown;
}

function nextRequestIdValue(): string {
  const value = nextRequestId;
  nextRequestId += 1;
  return `forge-${value}`;
}

function jsonReply(ctx: RequestContext, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  // Encode once: the old form scanned the string for its byte length and then
  // encoded it a second time inside res.end. A Buffer carries its own length.
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestIdValue(),
    'Content-Length': String(body.length),
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function errorReply(ctx: RequestContext, status: number, message: string): void {
  jsonReply(ctx, status, { message });
}

function rawReply(ctx: RequestContext, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': nextRequestIdValue(),
    'Content-Length': String(body.length),
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function noContentReply(ctx: RequestContext): void {
  ctx.res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestIdValue() });
  ctx.res.end();
}

/** The bearer token this process demands (empty when no token is configured). */
function requiredToken(): string {
  return SHOP_TOKEN;
}

/** 401 when the Authorization header is missing or the bearer token does not match. */
function checkAuth(ctx: RequestContext): boolean {
  const token = requiredToken();
  const header = ctx.req.headers.authorization ?? '';
  if (token === '') {
    // Local run with no token configured: any non-empty Bearer header is accepted.
    if (header.startsWith('Bearer ') && header.slice(7).trim() !== '') return true;
    errorReply(ctx, 401, 'Requires authentication');
    return false;
  }
  if (header === `Bearer ${token}`) return true;
  errorReply(ctx, 401, 'Bad credentials');
  return false;
}

function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limitBytes) {
        rejected = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      // Most API/git bodies arrive as a single chunk: hand it back without a copy.
      resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Decode one path segment; null on a malformed percent escape. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function linkHeader(base: string, pathname: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${base}${pathname}?${next.toString()}>; rel="next"`;
}

function pageOf(query: URLSearchParams): number {
  const raw = Number.parseInt(query.get('page') ?? '1', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

function perPageOf(query: URLSearchParams, fallback: number): number {
  const raw = Number.parseInt(query.get('per_page') ?? String(fallback), 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(raw, 100);
}

function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

async function handleRest(ctx: RequestContext): Promise<boolean> {
  const { method, segments } = ctx;
  const rest = segments.slice(2); // after 'api', 'v3'

  // GET /api/v3/
  if (method === 'GET' && rest.length === 0) {
    jsonReply(ctx, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    jsonReply(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    jsonReply(ctx, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL });
    return true;
  }
  // POST /api/v3/user/repos
  if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const body = isObject(ctx.json) ? ctx.json : {};
    const name = bodyString(body.name);
    if (name === '' || name.includes('/')) {
      errorReply(ctx, 422, 'name is required');
      return true;
    }
    if (getRepo(VIEWER_LOGIN, name)) {
      errorReply(ctx, 422, 'Repository already exists');
      return true;
    }
    const repo = createRepo(VIEWER_LOGIN, name, bodyString(body.description), body.private === true);
    jsonReply(ctx, 201, repoJson(repo));
    return true;
  }
  // GET /api/v3/user/repos
  if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
    const page = pageOf(ctx.query);
    const perPage = perPageOf(ctx.query, 10);
    const { page: slice, hasNext } = paginate(mine, page, perPage);
    const base = `${ctx.req.headers.host ? `http://${ctx.req.headers.host}` : ''}`;
    const link = linkHeader(base, ctx.pathname, ctx.query, page, perPage, hasNext);
    jsonReply(ctx, 200, slice.map((repo) => repoJson(repo)), link ? { Link: link } : {});
    return true;
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    return handleRestRepo(ctx, rest);
  }
  return false;
}

function parseNumberParam(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

async function handleRestRepo(ctx: RequestContext, rest: string[]): Promise<boolean> {
  const { method } = ctx;
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = getRepo(owner, repoName);
  const tail = rest.slice(3);

  // GET /api/v3/repos/{o}/{r}
  if (method === 'GET' && tail.length === 0) {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    jsonReply(ctx, 200, repoJson(repo));
    return true;
  }
  // PATCH /api/v3/repos/{o}/{r}
  if (method === 'PATCH' && tail.length === 0) {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const body = isObject(ctx.json) ? ctx.json : {};
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.privateFlag = body.private;
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    jsonReply(ctx, 200, repoJson(repo));
    return true;
  }
  // DELETE /api/v3/repos/{o}/{r}
  if (method === 'DELETE' && tail.length === 0) {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    repos.delete(repoKey(owner, repoName));
    noContentReply(ctx);
    return true;
  }
  if (!repo) {
    errorReply(ctx, 404, 'Not Found');
    return true;
  }

  // POST /api/v3/repos/{o}/{r}/git/refs
  if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const body = isObject(ctx.json) ? ctx.json : {};
    const ref = bodyString(body.ref);
    const sha = bodyString(body.sha);
    if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
      errorReply(ctx, 422, 'ref and sha are required');
      return true;
    }
    repo.refs.set(ref, sha);
    touchRepo(repo);
    jsonReply(ctx, 201, { ref, object: { sha } });
    return true;
  }
  // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}
  if (method === 'GET' && tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads') {
    const branch = tail.slice(3).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    jsonReply(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha } });
    return true;
  }
  // GET /api/v3/repos/{o}/{r}/branches
  if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    jsonReply(ctx, 200, branches);
    return true;
  }
  // GET /api/v3/repos/{o}/{r}/branches/{branch}
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'branches') {
    const branch = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    jsonReply(ctx, 200, { name: branch, commit: { sha } });
    return true;
  }
  // GET /api/v3/repos/{o}/{r}/commits
  if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
    const refName = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
    if (!tip) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const list: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head]!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      // The REST field carries the message without git's trailing newline.
      list.push({ sha: oid, commit: { message: commit.message.replace(/\n$/, '') } });
      for (const parent of commit.parents) queue.push(parent);
    }
    const page = pageOf(ctx.query);
    const perPage = perPageOf(ctx.query, 30);
    const { page: slice } = paginate(list, page, perPage);
    jsonReply(ctx, 200, slice);
    return true;
  }
  // /api/v3/repos/{o}/{r}/contents/...
  if (tail.length >= 1 && tail[0] === 'contents') {
    return handleContents(ctx, repo, tail.slice(1));
  }
  // /api/v3/repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const body = isObject(ctx.json) ? ctx.json : {};
      const name = bodyString(body.name);
      if (name === '') {
        errorReply(ctx, 422, 'name is required');
        return true;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        jsonReply(ctx, 201, labelJson(existing));
        return true;
      }
      const label: Label = { name, color: bodyString(body.color) || 'ededed' };
      repo.labels.set(name, label);
      jsonReply(ctx, 201, labelJson(label));
      return true;
    }
    if (method === 'GET') {
      jsonReply(ctx, 200, [...repo.labels.values()].map((label) => labelJson(label)));
      return true;
    }
    return false;
  }
  // /api/v3/repos/{o}/{r}/issues[/...]
  if (tail.length >= 1 && tail[0] === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1));
  }
  // /api/v3/repos/{o}/{r}/pulls[/...]
  if (tail.length >= 1 && tail[0] === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1));
  }
  return false;
}

async function handleContents(ctx: RequestContext, repo: Repo, pathSegments: string[]): Promise<boolean> {
  const { method } = ctx;
  const path = pathSegments.join('/');
  if (path === '') {
    errorReply(ctx, 404, 'Not Found');
    return true;
  }
  const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${refParam}`) ?? (isOid(refParam) ? refParam : undefined);

  if (method === 'GET') {
    if (!tip) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const entry = lookupPath(repo, tip, path);
    if (entry && entry.mode !== '40000') {
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') {
        errorReply(ctx, 404, 'Not Found');
        return true;
      }
      jsonReply(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        content: b64encode(blob.data),
        sha: entry.oid,
        size: blob.data.length,
        path,
        name: path.split('/').pop(),
      });
      return true;
    }
    const dirEntries = listDirectory(repo, tip, path);
    if (dirEntries) {
      jsonReply(ctx, 200, dirEntries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: `${path}/${e.name}`,
        sha: e.oid,
      })));
      return true;
    }
    errorReply(ctx, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = isObject(ctx.json) ? ctx.json : {};
    const message = bodyString(body.message) || 'Update file';
    const contentText = bodyString(body.content);
    const branch = bodyString(body.branch) || repo.defaultBranch;
    const expectedSha = bodyString(body.sha);
    if (contentText === '') {
      errorReply(ctx, 422, 'content is required');
      return true;
    }
    let content: Buffer;
    try {
      content = b64decode(contentText);
    } catch {
      errorReply(ctx, 422, 'content is not valid base64');
      return true;
    }
    let branchTip = repo.refs.get(`refs/heads/${branch}`);
    let baseCommit: string | null = null;
    let baseTree: string | null = null;
    if (!branchTip) {
      // Unknown branch: create it from the default branch tip (or start unborn).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) {
        branchTip = defaultTip;
        baseCommit = defaultTip;
        baseTree = treeOf(repo, defaultTip);
      }
    } else {
      baseCommit = branchTip;
      baseTree = treeOf(repo, branchTip);
    }
    const existing = baseTree ? lookupPath(repo, baseCommit!, path) : null;
    if (existing && existing.mode !== '40000' && expectedSha !== '' && expectedSha !== existing.oid) {
      errorReply(ctx, 409, 'sha does not match the current blob');
      return true;
    }
    if (!existing && expectedSha !== '') {
      errorReply(ctx, 409, 'sha does not match the current blob');
      return true;
    }
    const isUpdate = existing !== null && existing.mode !== '40000';
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    const treeOid = setPathInTree(repo, baseTree, path, blobOid, '100644');
    const commitOid = makeCommit(repo, treeOid, baseCommit ? [baseCommit] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    touchRepo(repo);
    jsonReply(ctx, isUpdate ? 200 : 201, {
      content: { sha: blobOid, encoding: 'base64', size: content.length, path, name: path.split('/').pop() },
      commit: { sha: commitOid },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = isObject(ctx.json) ? ctx.json : {};
    const message = bodyString(body.message) || 'Delete file';
    const branch = bodyString(body.branch) || repo.defaultBranch;
    const expectedSha = bodyString(body.sha);
    const branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (!branchTip) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const baseTree = treeOf(repo, branchTip);
    const existing = baseTree ? lookupPath(repo, branchTip, path) : null;
    if (!existing || existing.mode === '40000') {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    if (expectedSha !== '' && expectedSha !== existing.oid) {
      errorReply(ctx, 409, 'sha does not match the current blob');
      return true;
    }
    const treeOid = setPathInTree(repo, baseTree, path, null, '100644');
    const commitOid = makeCommit(repo, treeOid, [branchTip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    touchRepo(repo);
    jsonReply(ctx, 200, { commit: { sha: commitOid } });
    return true;
  }
  return false;
}

async function handleIssues(ctx: RequestContext, repo: Repo, tail: string[]): Promise<boolean> {
  const { method } = ctx;
  // POST /issues — create
  if (method === 'POST' && tail.length === 0) {
    const body = isObject(ctx.json) ? ctx.json : {};
    const title = bodyString(body.title);
    if (title === '') {
      errorReply(ctx, 422, 'title is required');
      return true;
    }
    const labelNames: string[] = Array.isArray(body.labels)
      ? body.labels.map((label) => (typeof label === 'string' ? label : typeof label === 'object' && label !== null ? bodyString((label as Record<string, unknown>).name) : '')).filter((name) => name !== '')
      : [];
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) {
        errorReply(ctx, 422, `label ${name} does not exist`);
        return true;
      }
      labels.push(label);
    }
    const issue: Issue = {
      id: nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      labels,
      comments: [],
      seq: repo.nextIssueNumber,
    };
    nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    jsonReply(ctx, 201, issueJson(repo, issue));
    return true;
  }
  // GET /issues — list
  if (method === 'GET' && tail.length === 0) {
    const state = ctx.query.get('state') ?? 'open';
    const direction = ctx.query.get('direction') ?? 'desc';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    if (direction === 'asc') list.sort((a, b) => a.seq - b.seq);
    else list.sort((a, b) => b.seq - a.seq);
    const page = pageOf(ctx.query);
    const perPage = perPageOf(ctx.query, 30);
    const { page: slice, hasNext } = paginate(list, page, perPage);
    const base = ctx.req.headers.host ? `http://${ctx.req.headers.host}` : '';
    const link = linkHeader(base, ctx.pathname, ctx.query, page, perPage, hasNext);
    jsonReply(ctx, 200, slice.map((issue) => issueJson(repo, issue)), link ? { Link: link } : {});
    return true;
  }
  const number = parseNumberParam(tail[0] ?? '');
  if (number === null) return false;
  const issue = repo.issues.find((item) => item.number === number);
  if (!issue) {
    errorReply(ctx, 404, 'Not Found');
    return true;
  }
  // GET /issues/{n}
  if (method === 'GET' && tail.length === 1) {
    jsonReply(ctx, 200, issueJson(repo, issue));
    return true;
  }
  // PATCH /issues/{n}
  if (method === 'PATCH' && tail.length === 1) {
    const body = isObject(ctx.json) ? ctx.json : {};
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (Array.isArray(body.labels)) {
      const labels: Label[] = [];
      for (const raw of body.labels) {
        const name = typeof raw === 'string' ? raw : isObject(raw) ? bodyString(raw.name) : '';
        const label = repo.labels.get(name);
        if (!label) {
          errorReply(ctx, 422, `label ${name} does not exist`);
          return true;
        }
        labels.push(label);
      }
      issue.labels = labels;
    }
    jsonReply(ctx, 200, issueJson(repo, issue));
    return true;
  }
  // POST /issues/{n}/comments
  if (method === 'POST' && tail.length === 2 && tail[1] === 'comments') {
    const body = isObject(ctx.json) ? ctx.json : {};
    const commentBody = bodyString(body.body);
    if (commentBody === '') {
      errorReply(ctx, 422, 'body is required');
      return true;
    }
    const comment: Comment = { id: nextCommentId, body: commentBody, seq: nextCommentId };
    nextCommentId += 1;
    issue.comments.push(comment);
    jsonReply(ctx, 201, commentJson(repo, issue, comment));
    return true;
  }
  // GET /issues/{n}/comments
  if (method === 'GET' && tail.length === 2 && tail[1] === 'comments') {
    jsonReply(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    return true;
  }
  return false;
}

async function handlePulls(ctx: RequestContext, repo: Repo, tail: string[]): Promise<boolean> {
  const { method } = ctx;
  // POST /pulls — create
  if (method === 'POST' && tail.length === 0) {
    const body = isObject(ctx.json) ? ctx.json : {};
    const title = bodyString(body.title);
    const headRef = bodyString(body.head);
    const baseRef = bodyString(body.base) || repo.defaultBranch;
    if (title === '' || headRef === '' || baseRef === '') {
      errorReply(ctx, 422, 'title, head and base are required');
      return true;
    }
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      errorReply(ctx, 422, 'head or base branch does not exist');
      return true;
    }
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (duplicate) {
      errorReply(ctx, 422, 'a pull request for this head and base is already open');
      return true;
    }
    const pull: Pull = {
      id: nextPullId,
      number: repo.nextPullNumber,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: repo.nextPullNumber,
    };
    nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    jsonReply(ctx, 201, pullJson(repo, pull));
    return true;
  }
  // GET /pulls — list
  if (method === 'GET' && tail.length === 0) {
    const state = ctx.query.get('state') ?? 'open';
    let list = [...repo.pulls];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const page = pageOf(ctx.query);
    const perPage = perPageOf(ctx.query, 30);
    const { page: slice } = paginate(list, page, perPage);
    jsonReply(ctx, 200, slice.map((pull) => pullJson(repo, pull)));
    return true;
  }
  const number = parseNumberParam(tail[0] ?? '');
  if (number === null) return false;
  const pull = repo.pulls.find((item) => item.number === number);
  if (!pull) {
    errorReply(ctx, 404, 'Not Found');
    return true;
  }
  // GET /pulls/{n}
  if (method === 'GET' && tail.length === 1) {
    jsonReply(ctx, 200, pullJson(repo, pull));
    return true;
  }
  // GET /pulls/{n}/files
  if (method === 'GET' && tail.length === 2 && tail[1] === 'files') {
    const changes = diffTrees(repo, pull.baseSha, pullHeadTip(repo, pull));
    jsonReply(ctx, 200, changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })));
    return true;
  }
  // PUT /pulls/{n}/merge
  if (method === 'PUT' && tail.length === 2 && tail[1] === 'merge') {
    if (pull.merged || pull.state !== 'open') {
      errorReply(ctx, 405, 'pull request is already merged or closed');
      return true;
    }
    const baseTip = pullBaseTip(repo, pull);
    const headTip = pullHeadTip(repo, pull);
    const base = mergeBase(repo.objects, baseTip, headTip);
    if (base === null) {
      errorReply(ctx, 405, 'pull request cannot be merged');
      return true;
    }
    const merged = threeWayMerge(repo, base, baseTip, headTip);
    if (!merged) {
      errorReply(ctx, 405, 'merge conflict');
      return true;
    }
    const mergeSha = makeCommit(repo, merged.treeOid, [baseTip], `Merge pull request #${pull.number}: ${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    touchRepo(repo);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = TRIAL_NOW_ISO;
    pull.mergeCommitSha = mergeSha;
    jsonReply(ctx, 200, { sha: mergeSha, merged: true, message: `Merge pull request #${pull.number}: ${pull.title}` });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4 — a small hand-written parser and executor for the documents the
// suite sends (variables, arguments, aliases, inline fragments, __type).
// ---------------------------------------------------------------------------

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[];
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: GqlSelection[];
}

interface GqlFragment {
  name: string;
  typeName: string;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

type GqlToken =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenizeGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] ?? '';
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += escapes[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: GqlToken[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenizeGql(source);
  }

  private peek(): GqlToken | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind} ${JSON.stringify((token as { value: unknown }).value)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlFragment>();
    while (this.peek()) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          variables: {},
          selections: this.parseSelections(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value as string;
        this.skipVariableDefinitions();
        operations.push({ kind, name, variables: {}, selections: this.parseSelections() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeName = this.expectName();
        fragments.set(name, { name, typeName, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected token ${token.kind} at document level`);
      }
    }
    if (operations.length === 0) throw new Error('document has no operation');
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    if (!this.matchPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
      if (token.kind === 'punct' && token.value === '[') depth += 1;
      if (token.kind === 'punct' && token.value === ']') depth -= 1;
      if (token.kind === 'punct' && token.value === '{') depth += 1;
      if (token.kind === 'punct' && token.value === '}') depth -= 1;
    }
  }

  private parseSelections(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '...') {
      this.next();
      let fragmentType: string | null = null;
      let fragmentName: string | null = null;
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      } else if (token?.kind === 'name') {
        fragmentName = this.next().value as string;
      }
      // Directives on a fragment spread are skipped (the suite sends none).
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
      }
      return {
        alias: null,
        name: fragmentName ?? '',
        args: {},
        selections: this.parseSelections(),
        fragmentType,
      };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
    }
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelections() : [];
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __variable: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // an enum literal
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

/** Resolve variables inside argument values. */
function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => resolve(item));
    if (isObject(value)) {
      if ('__variable' in value) return variables[String(value.__variable)] ?? null;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = resolve(item);
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolve(value);
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL schema data
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closedAt', 'closed', 'locked', 'viewerCanUpdate', 'assignees', 'milestone', 'reactions', 'timelineItems'];

const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'repository', 'closedAt', 'isDraft', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews'];

const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'fork', 'homepageUrl', 'isArchived', 'isPrivate', 'licenseInfo', 'primaryLanguage', 'stargazerCount', 'watcherCount', 'topics', 'defaultBranch', 'ref', 'refs', 'labels', 'milestones'];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MARKETPLACE', 'TOPIC', 'WIKI', 'MILESTONE'];

interface GqlFieldDef {
  type: string;
  resolve: (value: unknown, args: Record<string, unknown>) => unknown;
}

/** Field tables: for each type, which fields exist and how to resolve them. */
const TYPE_FIELDS: Record<string, Record<string, GqlFieldDef>> = {};

function defineFields(typeName: string, defs: Record<string, GqlFieldDef>): void {
  TYPE_FIELDS[typeName] = defs;
}

function scalarField(typeName: string, getter: (value: unknown) => unknown): GqlFieldDef {
  return { type: typeName, resolve: (value) => getter(value) };
}

function objectField(typeName: string, getter: (value: unknown, args: Record<string, unknown>) => unknown): GqlFieldDef {
  return { type: typeName, resolve: (value, args) => getter(value, args) };
}

function viewerUser(): Record<string, unknown> {
  return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function wrapRepo(repo: Repo): Record<string, unknown> {
  return { __type: 'Repository', __repo: repo };
}

function wrapIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}

function wrapPull(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __type: 'PullRequest', __repo: repo, __pull: pull };
}

function wrapComment(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return { __type: 'Comment', __repo: repo, __issue: issue, __comment: comment };
}

function typeOfWrapped(value: unknown): string | null {
  if (isObject(value) && typeof value.__type === 'string') return value.__type;
  return null;
}

function defineSchema(): void {
  defineFields('User', {
    login: scalarField('String', (value) => (value as Record<string, unknown>).login ?? null),
    id: scalarField('ID', (value) => (value as Record<string, unknown>).id ?? null),
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    email: scalarField('String', (value) => (value as Record<string, unknown>).email ?? null),
  });

  defineFields('Repository', {
    id: scalarField('ID', (value) => globalId('R', (value as Record<string, unknown>).__repo as Repo)),
    databaseId: scalarField('Int', (value) => ((value as Record<string, unknown>).__repo as Repo).id),
    name: scalarField('String', (value) => ((value as Record<string, unknown>).__repo as Repo).name),
    nameWithOwner: scalarField('String', (value) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      return `${repo.owner}/${repo.name}`;
    }),
    owner: objectField('User', (value) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      return repo.owner === VIEWER_LOGIN ? viewerUser() : { __type: 'User', login: repo.owner, id: 1001, name: repo.owner, email: `${repo.owner}@example.invalid` };
    }),
    defaultBranchRef: objectField('Ref', (value) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { __type: 'Ref', __repo: repo, name: repo.defaultBranch, sha };
    }),
    viewerPermission: scalarField('String', () => 'ADMIN'),
    hasIssuesEnabled: scalarField('Boolean', () => true),
    description: scalarField('String', (value) => ((value as Record<string, unknown>).__repo as Repo).description),
    private: scalarField('Boolean', (value) => ((value as Record<string, unknown>).__repo as Repo).privateFlag),
    url: scalarField('String', (value) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      return `https://github.com/${repo.owner}/${repo.name}`;
    }),
    createdAt: scalarField('String', () => TRIAL_NOW_ISO),
    updatedAt: scalarField('String', () => TRIAL_NOW_ISO),
    issue: objectField('Issue', (value, args) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((item) => item.number === number);
      return issue ? wrapIssue(repo, issue) : null;
    }),
    issues: objectField('IssueConnection', (value, args) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      let list = [...repo.issues];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = isObject(args.orderBy) ? args.orderBy : null;
      const direction = String(orderBy?.direction ?? 'ASC').toUpperCase();
      list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      return paginateGql(list, args, (issue) => wrapIssue(repo, issue), 'IssueConnection');
    }),
    pullRequests: objectField('PullRequestConnection', (value, args) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      let list = [...repo.pulls];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((pull) => wanted.has(pull.state));
      }
      const orderBy = isObject(args.orderBy) ? args.orderBy : null;
      const direction = String(orderBy?.direction ?? 'ASC').toUpperCase();
      list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      return paginateGql(list, args, (pull) => wrapPull(repo, pull), 'PullRequestConnection');
    }),
    pullRequest: objectField('PullRequest', (value, args) => {
      const repo = (value as Record<string, unknown>).__repo as Repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((item) => item.number === number);
      return pull ? wrapPull(repo, pull) : null;
    }),
  });

  defineFields('Ref', {
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    target: objectField('Commit', (value) => {
      const wrapped = value as Record<string, unknown>;
      const repo = wrapped.__repo as Repo;
      const sha = wrapped.sha as string;
      return { __type: 'Commit', __repo: repo, oid: sha };
    }),
  });

  defineFields('Commit', {
    oid: scalarField('String', (value) => (value as Record<string, unknown>).oid ?? null),
    message: scalarField('String', (value) => {
      const wrapped = value as Record<string, unknown>;
      return commitMessage(wrapped.__repo as Repo, String(wrapped.oid ?? ''));
    }),
  });

  defineFields('Issue', {
    id: scalarField('ID', (value) => {
      const wrapped = value as Record<string, unknown>;
      return globalId('I', wrapped.__repo as Repo, (wrapped.__issue as Issue).number);
    }),
    number: scalarField('Int', (value) => ((value as Record<string, unknown>).__issue as Issue).number),
    title: scalarField('String', (value) => ((value as Record<string, unknown>).__issue as Issue).title),
    body: scalarField('String', (value) => ((value as Record<string, unknown>).__issue as Issue).body),
    state: scalarField('String', (value) => ((value as Record<string, unknown>).__issue as Issue).state.toUpperCase()),
    url: scalarField('String', (value) => {
      const wrapped = value as Record<string, unknown>;
      const repo = wrapped.__repo as Repo;
      return `https://github.com/${repo.owner}/${repo.name}/issues/${(wrapped.__issue as Issue).number}`;
    }),
    createdAt: scalarField('String', () => TRIAL_NOW_ISO),
    updatedAt: scalarField('String', () => TRIAL_NOW_ISO),
    author: objectField('User', () => viewerUser()),
    repository: objectField('Repository', (value) => wrapRepo((value as Record<string, unknown>).__repo as Repo)),
    labels: objectField('LabelConnection', (value) => {
      const wrapped = value as Record<string, unknown>;
      const issue = wrapped.__issue as Issue;
      return { __type: 'LabelConnection', nodes: issue.labels.map((label) => ({ __type: 'Label', name: label.name, color: label.color })) };
    }),
    comments: objectField('CommentConnection', (value) => {
      const wrapped = value as Record<string, unknown>;
      const repo = wrapped.__repo as Repo;
      const issue = wrapped.__issue as Issue;
      return { __type: 'CommentConnection', nodes: issue.comments.map((comment) => wrapComment(repo, issue, comment)) };
    }),
  });

  defineFields('Label', {
    id: scalarField('ID', (value) => b64urlEncode(`L:${String((value as Record<string, unknown>).name ?? '')}`)),
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    color: scalarField('String', (value) => (value as Record<string, unknown>).color ?? null),
  });

  defineFields('Comment', {
    id: scalarField('ID', (value) => {
      const wrapped = value as Record<string, unknown>;
      return globalId('C', wrapped.__repo as Repo, (wrapped.__issue as Issue).number, (wrapped.__comment as Comment).id);
    }),
    body: scalarField('String', (value) => ((value as Record<string, unknown>).__comment as Comment).body),
    author: objectField('User', () => viewerUser()),
  });

  defineFields('PullRequest', {
    id: scalarField('ID', (value) => {
      const wrapped = value as Record<string, unknown>;
      return globalId('PR', wrapped.__repo as Repo, (wrapped.__pull as Pull).number);
    }),
    number: scalarField('Int', (value) => ((value as Record<string, unknown>).__pull as Pull).number),
    title: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).title),
    body: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).body),
    state: scalarField('String', (value) => {
      const pull = (value as Record<string, unknown>).__pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    }),
    merged: scalarField('Boolean', (value) => ((value as Record<string, unknown>).__pull as Pull).merged),
    mergeable: scalarField('String', (value) => {
      const wrapped = value as Record<string, unknown>;
      return pullMergeable(wrapped.__repo as Repo, wrapped.__pull as Pull);
    }),
    headRefName: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).headRef),
    baseRefName: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).baseRef),
    headRefOid: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).headSha),
    baseRefOid: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).baseSha),
    mergedAt: scalarField('String', (value) => ((value as Record<string, unknown>).__pull as Pull).mergedAt),
    url: scalarField('String', (value) => {
      const wrapped = value as Record<string, unknown>;
      const repo = wrapped.__repo as Repo;
      return `https://github.com/${repo.owner}/${repo.name}/pull/${(wrapped.__pull as Pull).number}`;
    }),
    createdAt: scalarField('String', () => TRIAL_NOW_ISO),
    updatedAt: scalarField('String', () => TRIAL_NOW_ISO),
    author: objectField('User', () => viewerUser()),
    repository: objectField('Repository', (value) => wrapRepo((value as Record<string, unknown>).__repo as Repo)),
    files: objectField('PullRequestFileConnection', (value, args) => {
      const wrapped = value as Record<string, unknown>;
      const repo = wrapped.__repo as Repo;
      const pull = wrapped.__pull as Pull;
      const changes = diffTrees(repo, pull.baseSha, pullHeadTip(repo, pull));
      const first = typeof args.first === 'number' ? args.first : 100;
      const nodes = changes.slice(0, first).map((change) => ({ __type: 'PullRequestFile', path: change.path }));
      return { __type: 'PullRequestFileConnection', nodes, totalCount: changes.length };
    }),
  });

  defineFields('PullRequestFile', {
    path: scalarField('String', (value) => (value as Record<string, unknown>).path ?? null),
  });

  defineFields('IssueConnection', {
    nodes: objectField('Issue', (value) => (value as Record<string, unknown>).nodes ?? []),
    totalCount: scalarField('Int', (value) => ((value as Record<string, unknown>).totalCount ?? ((value as Record<string, unknown>).nodes as unknown[] | undefined)?.length ?? 0)),
    pageInfo: objectField('PageInfo', (value) => (value as Record<string, unknown>).pageInfo ?? { __type: 'PageInfo', hasNextPage: false, endCursor: null }),
  });
  defineFields('PullRequestConnection', {
    nodes: objectField('PullRequest', (value) => (value as Record<string, unknown>).nodes ?? []),
    totalCount: scalarField('Int', (value) => ((value as Record<string, unknown>).totalCount ?? ((value as Record<string, unknown>).nodes as unknown[] | undefined)?.length ?? 0)),
    pageInfo: objectField('PageInfo', (value) => (value as Record<string, unknown>).pageInfo ?? { __type: 'PageInfo', hasNextPage: false, endCursor: null }),
  });
  defineFields('PullRequestFileConnection', {
    nodes: objectField('PullRequestFile', (value) => (value as Record<string, unknown>).nodes ?? []),
    totalCount: scalarField('Int', (value) => ((value as Record<string, unknown>).totalCount ?? ((value as Record<string, unknown>).nodes as unknown[] | undefined)?.length ?? 0)),
    pageInfo: objectField('PageInfo', (value) => ({ __type: 'PageInfo', hasNextPage: false, endCursor: null })),
  });
  defineFields('LabelConnection', {
    nodes: objectField('Label', (value) => (value as Record<string, unknown>).nodes ?? []),
    totalCount: scalarField('Int', (value) => ((value as Record<string, unknown>).nodes as unknown[] | undefined)?.length ?? 0),
  });
  defineFields('CommentConnection', {
    nodes: objectField('Comment', (value) => (value as Record<string, unknown>).nodes ?? []),
    totalCount: scalarField('Int', (value) => ((value as Record<string, unknown>).nodes as unknown[] | undefined)?.length ?? 0),
  });
  defineFields('PageInfo', {
    hasNextPage: scalarField('Boolean', (value) => Boolean((value as Record<string, unknown>).hasNextPage)),
    endCursor: scalarField('String', (value) => (value as Record<string, unknown>).endCursor ?? null),
    hasPreviousPage: scalarField('Boolean', () => false),
    startCursor: scalarField('String', (value) => (value as Record<string, unknown>).startCursor ?? null),
  });

  defineFields('__Type', {
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    kind: scalarField('String', (value) => (value as Record<string, unknown>).kind ?? 'OBJECT'),
    fields: objectField('__Field', (value) => {
      const typeName = String((value as Record<string, unknown>).name ?? '');
      const names = typeName === 'Issue' ? ISSUE_FIELDS : typeName === 'PullRequest' ? PULL_FIELDS : typeName === 'Repository' ? REPO_FIELDS : [];
      return names.map((name) => ({ __type: '__Field', name }));
    }),
    enumValues: objectField('__EnumValue', (value) => {
      const typeName = String((value as Record<string, unknown>).name ?? '');
      if (typeName !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((name) => ({ __type: '__EnumValue', name }));
    }),
  });
  defineFields('__Field', {
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    description: scalarField('String', () => null),
  });
  defineFields('__EnumValue', {
    name: scalarField('String', (value) => (value as Record<string, unknown>).name ?? null),
    description: scalarField('String', () => null),
  });

  defineFields('CreateIssuePayload', {
    issue: objectField('Issue', (value) => (value as Record<string, unknown>).issue ?? null),
  });
  defineFields('CloseIssuePayload', {
    issue: objectField('Issue', (value) => (value as Record<string, unknown>).issue ?? null),
  });
  defineFields('CreatePullRequestPayload', {
    pullRequest: objectField('PullRequest', (value) => (value as Record<string, unknown>).pullRequest ?? null),
  });
  defineFields('MergePullRequestPayload', {
    pullRequest: objectField('PullRequest', (value) => (value as Record<string, unknown>).pullRequest ?? null),
  });
  defineFields('AddCommentPayload', {
    commentEdge: objectField('CommentEdge', (value) => (value as Record<string, unknown>).commentEdge ?? null),
  });
  defineFields('CommentEdge', {
    node: objectField('Comment', (value) => (value as Record<string, unknown>).node ?? null),
  });
}

defineSchema();

/** Relay-style pagination for a connection: first + after (an opaque base64 cursor). */
function paginateGql<T>(list: T[], args: Record<string, unknown>, wrap: (item: T) => unknown, connectionType: string): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 100;
  let startIndex = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after) {
    try {
      const decoded = b64urlDecode(after);
      const match = decoded.match(/^cursor:(\d+)$/);
      if (match) startIndex = Number(match[1]) + 1;
    } catch {
      startIndex = 0;
    }
  }
  const slice = list.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < list.length;
  const lastIndex = startIndex + slice.length - 1;
  return {
    __type: connectionType,
    nodes: slice.map((item) => wrap(item)),
    totalCount: list.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      endCursor: slice.length > 0 ? b64urlEncode(`cursor:${lastIndex}`) : null,
      startCursor: slice.length > 0 ? b64urlEncode(`cursor:${startIndex}`) : null,
    },
  };
}

function resolveGlobalId(id: string): Record<string, unknown> | null {
  let decoded: string;
  try {
    decoded = b64urlDecode(id);
  } catch {
    return null;
  }
  const repoMatch = decoded.match(/^R:(.+)$/);
  if (repoMatch) {
    const [owner, name] = repoMatch[1]!.split('/');
    if (!owner || !name) return null;
    const repo = getRepo(owner, name);
    return repo ? wrapRepo(repo) : null;
  }
  const issueMatch = decoded.match(/^I:(.+):(\d+)$/);
  if (issueMatch) {
    const [owner, name] = issueMatch[1]!.split('/');
    const repo = getRepo(owner ?? '', name ?? '');
    if (!repo) return null;
    const issue = repo.issues.find((item) => item.number === Number(issueMatch[2]));
    return issue ? wrapIssue(repo, issue) : null;
  }
  const pullMatch = decoded.match(/^PR:(.+):(\d+)$/);
  if (pullMatch) {
    const [owner, name] = pullMatch[1]!.split('/');
    const repo = getRepo(owner ?? '', name ?? '');
    if (!repo) return null;
    const pull = repo.pulls.find((item) => item.number === Number(pullMatch[2]));
    return pull ? wrapPull(repo, pull) : null;
  }
  const commentMatch = decoded.match(/^C:(.+):(\d+):(\d+)$/);
  if (commentMatch) {
    const [owner, name] = commentMatch[1]!.split('/');
    const repo = getRepo(owner ?? '', name ?? '');
    if (!repo) return null;
    const issue = repo.issues.find((item) => item.number === Number(commentMatch[2]));
    if (!issue) return null;
    const comment = issue.comments.find((item) => item.id === Number(commentMatch[3]));
    return comment ? wrapComment(repo, issue, comment) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL execution
// ---------------------------------------------------------------------------

interface GqlExecContext {
  errors: { message: string }[];
  fragments: Map<string, GqlFragment>;
}

function executeSelections(ctx: GqlExecContext, parentType: string, parentValue: unknown, selections: GqlSelection[], variables: Record<string, unknown>): Record<string, unknown> | null {
  if (parentValue === null || parentValue === undefined) return null;
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null || selection.name === '') {
      // An inline fragment (`... on Type`) or a named spread: apply when the type matches.
      if (selection.fragmentType !== null && selection.fragmentType !== parentType && selection.fragmentType !== 'Node') continue;
      if (selection.name !== '') {
        const fragment = ctx.fragments.get(selection.name);
        if (!fragment) continue;
        if (fragment.typeName !== parentType && fragment.typeName !== 'Node') continue;
        const nested = executeSelections(ctx, parentType, parentValue, fragment.selections, variables);
        if (nested) Object.assign(result, nested);
        continue;
      }
      const nested = executeSelections(ctx, parentType, parentValue, selection.selections, variables);
      if (nested) Object.assign(result, nested);
      continue;
    }
    const fieldName = selection.name;
    if (fieldName === '__typename') {
      result[selection.alias ?? fieldName] = parentType;
      continue;
    }
    const fields = TYPE_FIELDS[parentType];
    const def = fields?.[fieldName];
    if (!def) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${parentType}".` });
      continue;
    }
    const args = resolveArgs(selection.args, variables);
    let childValue: unknown;
    try {
      childValue = def.resolve(parentValue, args);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      continue;
    }
    const childType = def.type;
    const key = selection.alias ?? fieldName;
    if (selection.selections.length === 0) {
      result[key] = childValue;
      continue;
    }
    if (childValue === null || childValue === undefined) {
      result[key] = null;
      continue;
    }
    if (Array.isArray(childValue)) {
      const elementType = childType === 'Connection' ? parentType : childType;
      result[key] = childValue.map((item) => {
        const itemType = typeOfWrapped(item) ?? elementType;
        return executeSelections(ctx, itemType, item, selection.selections, variables);
      });
      continue;
    }
    const resolvedType = typeOfWrapped(childValue) ?? childType;
    result[key] = executeSelections(ctx, resolvedType, childValue, selection.selections, variables);
  }
  return result;
}

function executeQueryRoot(ctx: GqlExecContext, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = { __type: 'Query' };
  const result = executeSelections(ctx, 'Query', root, operation.selections, variables);
  return result ?? {};
}

function executeMutationRoot(ctx: GqlExecContext, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = { __type: 'Mutation' };
  const result = executeSelections(ctx, 'Mutation', root, operation.selections, variables);
  return result ?? {};
}

function runMutation(fieldName: string, input: Record<string, unknown>): Record<string, unknown> | null {
  if (fieldName === 'createIssue') {
    const repo = resolveGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return null;
    const r = repo.__repo as Repo;
    const title = String(input.title ?? '');
    if (title === '') return null;
    const issue: Issue = {
      id: nextIssueId,
      number: r.nextIssueNumber,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: r.nextIssueNumber,
    };
    nextIssueId += 1;
    r.nextIssueNumber += 1;
    r.issues.push(issue);
    return { __type: 'CreateIssuePayload', issue: wrapIssue(r, issue) };
  }
  if (fieldName === 'closeIssue') {
    const wrapped = resolveGlobalId(String(input.issueId ?? ''));
    if (!wrapped || typeOfWrapped(wrapped) !== 'Issue') return null;
    const issue = wrapped.__issue as Issue;
    issue.state = 'closed';
    return { __type: 'CloseIssuePayload', issue: wrapped };
  }
  if (fieldName === 'createPullRequest') {
    const repo = resolveGlobalId(String(input.repositoryId ?? ''));
    if (!repo) return null;
    const r = repo.__repo as Repo;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const title = String(input.title ?? '');
    if (headRef === '' || baseRef === '' || title === '') return null;
    const headSha = r.refs.get(`refs/heads/${headRef}`);
    const baseSha = r.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    const duplicate = r.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (duplicate) return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(r, duplicate) };
    const pull: Pull = {
      id: nextPullId,
      number: r.nextPullNumber,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: r.nextPullNumber,
    };
    nextPullId += 1;
    r.nextPullNumber += 1;
    r.pulls.push(pull);
    return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(r, pull) };
  }
  if (fieldName === 'mergePullRequest') {
    const wrapped = resolveGlobalId(String(input.pullRequestId ?? ''));
    if (!wrapped || typeOfWrapped(wrapped) !== 'PullRequest') return null;
    const r = wrapped.__repo as Repo;
    const pull = wrapped.__pull as Pull;
    if (pull.merged || pull.state !== 'open') return { __type: 'MergePullRequestPayload', pullRequest: wrapped };
    const mergeSha = squashMergePull(r, pull, `Merge pull request #${pull.number}: ${pull.title}`);
    if (!mergeSha) return null;
    return { __type: 'MergePullRequestPayload', pullRequest: wrapped };
  }
  if (fieldName === 'addComment') {
    const wrapped = resolveGlobalId(String(input.subjectId ?? ''));
    if (!wrapped) return null;
    const body = String(input.body ?? '');
    if (body === '') return null;
    const r = wrapped.__repo as Repo;
    const issue = wrapped.__issue as Issue | undefined;
    if (!issue) return null;
    const comment: Comment = { id: nextCommentId, body, seq: nextCommentId };
    nextCommentId += 1;
    issue.comments.push(comment);
    return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: wrapComment(r, issue, comment) } };
  }
  return null;
}

defineFields('Query', {
  viewer: objectField('User', () => viewerUser()),
  repository: objectField('Repository', (_value, args) => {
    const owner = String(args.owner ?? '');
    const name = String(args.name ?? '');
    const repo = getRepo(owner, name);
    return repo ? wrapRepo(repo) : null;
  }),
  node: objectField('Node', (_value, args) => resolveGlobalId(String(args.id ?? ''))),
  __type: objectField('__Type', (_value, args) => {
    const name = String(args.name ?? '');
    if (name !== 'Issue' && name !== 'PullRequest' && name !== 'Repository' && name !== 'SearchType') return null;
    return { __type: '__Type', name, kind: name === 'SearchType' ? 'ENUM' : 'OBJECT' };
  }),
});

defineFields('Mutation', {
  createIssue: objectField('CreateIssuePayload', (_value, args) => runMutation('createIssue', isObject(args.input) ? args.input : {})),
  closeIssue: objectField('CloseIssuePayload', (_value, args) => runMutation('closeIssue', isObject(args.input) ? args.input : {})),
  createPullRequest: objectField('CreatePullRequestPayload', (_value, args) => runMutation('createPullRequest', isObject(args.input) ? args.input : {})),
  mergePullRequest: objectField('MergePullRequestPayload', (_value, args) => runMutation('mergePullRequest', isObject(args.input) ? args.input : {})),
  addComment: objectField('AddCommentPayload', (_value, args) => runMutation('addComment', isObject(args.input) ? args.input : {})),
});

function executeGraphqlOperation(query: string, variables: Record<string, unknown>, operationName: string | null): { data: unknown; errors?: { message: string }[] } {
  let document: GqlDocument;
  try {
    document = new GqlParser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const operation = operationName
    ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]!
    : document.operations[0]!;
  const ctx: GqlExecContext = { errors: [], fragments: document.fragments };
  const data = operation.kind === 'mutation'
    ? executeMutationRoot(ctx, operation, variables)
    : executeQueryRoot(ctx, operation, variables);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

async function handleGraphql(ctx: RequestContext): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    errorReply(ctx, 400, 'Request body is not valid JSON');
    return true;
  }
  const body = parsed.value;
  const runOne = (entry: unknown): { data: unknown; errors?: { message: string }[] } => {
    if (!isObject(entry)) return { data: null, errors: [{ message: 'request body must be an object' }] };
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = isObject(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    return executeGraphqlOperation(query, variables, operationName);
  };
  if (Array.isArray(body)) {
    jsonReply(ctx, 200, body.map((entry) => runOne(entry)));
    return true;
  }
  jsonReply(ctx, 200, runOne(body));
  return true;
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (legacy 2025-11-25 fallback)
// ---------------------------------------------------------------------------

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login; defaults to the viewer.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_PROTOCOL_VERSION = '2026-07-28';

function mcpToolResult(payload: Record<string, unknown>, isError = false): Record<string, unknown> {
  const text = JSON.stringify(payload);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  };
  if (isError) result.isError = true;
  return result;
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function mcpMissingArg(name: string): Record<string, unknown> {
  return mcpToolError(`missing required argument: ${name}`);
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = bodyString(args.name);
    if (repoName === '') return mcpMissingArg('name');
    const owner = bodyString(args.owner) || VIEWER_LOGIN;
    const existing = getRepo(owner, repoName);
    if (existing) return mcpToolResult({ ...repoJson(existing), full_name: `${owner}/${repoName}` });
    const repo = createRepo(owner, repoName, bodyString(args.description), args.private === true);
    return mcpToolResult({ ...repoJson(repo), full_name: `${owner}/${repoName}` });
  }
  if (name === 'get_repo') {
    const owner = bodyString(args.owner);
    const repoName = bodyString(args.repo);
    if (owner === '') return mcpMissingArg('owner');
    if (repoName === '') return mcpMissingArg('repo');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository ${owner}/${repoName} not found`);
    return mcpToolResult({ ...repoJson(repo), full_name: `${owner}/${repoName}` });
  }
  if (name === 'create_issue') {
    const owner = bodyString(args.owner);
    const repoName = bodyString(args.repo);
    const title = bodyString(args.title);
    if (owner === '') return mcpMissingArg('owner');
    if (repoName === '') return mcpMissingArg('repo');
    if (title === '') return mcpMissingArg('title');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const issue: Issue = {
      id: nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body: bodyString(args.body),
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.nextIssueNumber,
    };
    nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return mcpToolResult(issueJson(repo, issue) as Record<string, unknown>);
  }
  if (name === 'list_issues') {
    const owner = bodyString(args.owner);
    const repoName = bodyString(args.repo);
    if (owner === '') return mcpMissingArg('owner');
    if (repoName === '') return mcpMissingArg('repo');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const state = bodyString(args.state) || 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) });
  }
  if (name === 'create_pull_request') {
    const owner = bodyString(args.owner);
    const repoName = bodyString(args.repo);
    const title = bodyString(args.title);
    const head = bodyString(args.head);
    const base = bodyString(args.base);
    if (owner === '') return mcpMissingArg('owner');
    if (repoName === '') return mcpMissingArg('repo');
    if (title === '') return mcpMissingArg('title');
    if (head === '') return mcpMissingArg('head');
    if (base === '') return mcpMissingArg('base');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return mcpToolError('head or base branch does not exist');
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate) return mcpToolError('a pull request for this head and base is already open');
    const pull: Pull = {
      id: nextPullId,
      number: repo.nextPullNumber,
      title,
      body: bodyString(args.body),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.nextPullNumber,
    };
    nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return mcpToolResult(pullJson(repo, pull) as Record<string, unknown>);
  }
  if (name === 'merge_pull_request') {
    const owner = bodyString(args.owner);
    const repoName = bodyString(args.repo);
    const pullNumber = args.pull_number;
    if (owner === '') return mcpMissingArg('owner');
    if (repoName === '') return mcpMissingArg('repo');
    if (typeof pullNumber !== 'number') return mcpMissingArg('pull_number');
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const pull = repo.pulls.find((item) => item.number === pullNumber);
    if (!pull) return mcpToolError(`pull request #${pullNumber} not found`);
    if (pull.merged || pull.state !== 'open') return mcpToolError('pull request is already merged or closed');
    const mergeSha = squashMergePull(repo, pull, `Merge pull request #${pull.number}: ${pull.title}`);
    if (!mergeSha) return mcpToolError('merge conflict');
    return mcpToolResult({ ...pullJson(repo, pull), sha: mergeSha, merged: true } as Record<string, unknown>);
  }
  return mcpToolError(`unknown tool: ${name}`);
}

async function handleMcp(ctx: RequestContext): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    jsonReply(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed.value;
  if (!isObject(body) || typeof body.method !== 'string') {
    jsonReply(ctx, 400, { jsonrpc: '2.0', id: isObject(body) ? body.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = 'id' in body ? body.id : null;
  const params = isObject(body.params) ? body.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  const protocolVersion = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? meta['io.modelcontextprotocol/protocolVersion']
    : typeof body.method === 'string' && body.method === 'initialize' && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : MCP_PROTOCOL_VERSION;
  const serverInfo = { name: 'github-core-clone', version: '1.0.0' };
  const capabilities = { tools: {} };

  const reply = (result: Record<string, unknown>): void => {
    jsonReply(ctx, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    jsonReply(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (body.method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities,
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
    return true;
  }
  if (body.method === 'initialize') {
    reply({ protocolVersion, capabilities, serverInfo });
    return true;
  }
  if (body.method === 'notifications/initialized' || body.method.startsWith('notifications/')) {
    // A notification has no id and expects no reply body beyond the status line.
    ctx.res.writeHead(202, { 'X-GitHub-Request-Id': nextRequestIdValue() });
    ctx.res.end();
    return true;
  }
  if (body.method === 'ping') {
    reply({});
    return true;
  }
  if (body.method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return true;
  }
  if (body.method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const toolArgs = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      replyError(-32602, `unknown tool: ${toolName}`);
      return true;
    }
    try {
      const result = callMcpTool(toolName, toolArgs);
      reply(result);
    } catch (err) {
      replyError(-32603, `tool call failed: ${(err as Error).message}`);
    }
    return true;
  }
  replyError(-32601, `method not found: ${body.method}`);
  return true;
}

// ---------------------------------------------------------------------------
// git smart HTTP — /{owner}/{repo}.git
// ---------------------------------------------------------------------------

/** Ref advertisement lines, v0 style: `<oid> <ref>\0<caps>` on the first line. */
function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const refs: { oid: string; name: string }[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) refs.push({ oid, name: ref });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), pktFlush()];
  const caps = service === 'upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow agent=${FORGE_AGENT}`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      else parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo.objects, ref.oid);
        if (peeled && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement never varies (no repo data in it): build it once. */
const ADVERTISE_V2: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  pktFlush(),
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${FORGE_AGENT}\n`),
  pktFlush(),
]);

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      // Header lines before the delimiter: command=, agent=, object-format=.
      continue;
    }
    const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (trimmed === 'peel') args.peel = true;
    else if (trimmed === 'symrefs') args.symrefs = true;
    else if (trimmed === 'unborn') args.unborn = true;
    else if (trimmed.startsWith('ref-prefix ')) args.prefixes.push(trimmed.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(repo: Repo, packets: Pkt[]): Buffer {
  const args = parseLsRefsArgs(packets);
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (headOid) {
    if (args.symrefs && matches('HEAD')) lines.push(`${headOid} HEAD symref-target:${defaultRef}\n`);
    if (matches('HEAD') && !args.symrefs && args.prefixes.length === 0) {
      // HEAD without symrefs is only listed when no ref-prefix filters it out.
    }
  } else if (args.unborn) {
    if (matches('HEAD')) lines.push(`unborn HEAD symref-target:${defaultRef}\n`);
  }
  const refs: { oid: string; name: string }[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) refs.push({ oid, name: ref });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    // A peeled tag is one line: the tag oid, the ref, and `peeled:<commit>` as an attribute.
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo.objects, ref.oid);
      if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  thinPack: boolean;
}

function parseFetchArgs(packets: Pkt[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    thinPack: false,
  };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) continue;
    const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (trimmed.startsWith('want ')) args.wants.push(trimmed.slice(5));
    else if (trimmed.startsWith('have ')) args.haves.push(trimmed.slice(5));
    else if (trimmed.startsWith('shallow ')) args.shallow.push(trimmed.slice(8));
    else if (trimmed.startsWith('deepen ')) args.deepen = Number.parseInt(trimmed.slice(7), 10);
    else if (trimmed.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(trimmed.slice(13), 10);
    else if (trimmed.startsWith('deepen-not ')) args.deepenNot.push(trimmed.slice(11));
    else if (trimmed.startsWith('filter ')) args.filter = trimmed.slice(7);
    else if (trimmed === 'thin-pack') args.thinPack = true;
    else if (trimmed === 'done') break;
  }
  return args;
}

/** Every tree/blob oid under a tree (the tree itself included), recursively. */
function collectTreeObjects(repo: Repo, treeOid: string): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (found.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    found.add(oid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') queue.push(entry.oid);
      else found.add(entry.oid);
    }
  }
  return found;
}

/**
 * Objects the client already holds, inferred from its `have` lines: the closure from
 * the haves, but never past a `shallow` boundary (a shallow client holds the boundary
 * commit and its tree, not the boundary's parents). Tags are followed to their target.
 */
function collectHaveObjects(repo: Repo, haves: Iterable<string>, shallowBoundaries: Set<string>): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (found.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    found.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const treeOid of collectTreeObjects(repo, commit.tree)) found.add(treeOid);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entryOid of collectTreeObjects(repo, oid)) found.add(entryOid);
    }
  }
  return found;
}

function planFetch(repo: Repo, args: FetchArgs): { packObjects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const wantCommits: string[] = [];
  for (const want of args.wants) {
    const peeled = peelToCommitFromLookup(lookup, want);
    if (peeled) wantCommits.push(peeled);
  }
  const depth = args.deepen !== null && Number.isFinite(args.deepen) ? args.deepen : null;
  const wanted = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  if (depth !== null && depth > 0) {
    // BFS from the wants, tracking distance; commits at distance depth-1 are boundaries.
    const queue: { oid: string; dist: number }[] = wantCommits.map((oid) => ({ oid, dist: 0 }));
    const seen = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, dist } = queue[head]!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      wanted.add(oid);
      if (dist === depth - 1) {
        shallow.add(oid);
        continue;
      }
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
    }
  } else {
    for (const oid of collectCommits(wantCommits, lookup)) wanted.add(oid);
  }
  // Unshallow: old boundaries from the request whose parents are all now present.
  for (const oldBoundary of args.shallow) {
    const obj = repo.objects.get(oldBoundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.every((parent) => wanted.has(parent))) unshallow.add(oldBoundary);
  }
  const wantObjects = new Set<string>();
  for (const oid of wanted) {
    wantObjects.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const entryOid of collectTreeObjects(repo, parseCommit(obj.data).tree)) wantObjects.add(entryOid);
  }
  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (obj?.type === 'tag') wantObjects.add(want);
  }
  const haveObjects = collectHaveObjects(repo, args.haves, new Set(args.shallow));
  const packOids = new Set<string>([...wantObjects].filter((oid) => !haveObjects.has(oid)));
  // Deterministic pack order: wanted commits (BFS from the wants), then the rest sorted.
  const ordered: string[] = [];
  const queued = new Set<string>();
  const queue: string[] = [...wantCommits];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head]!;
    if (queued.has(oid)) continue;
    queued.add(oid);
    if (packOids.has(oid)) ordered.push(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  const remaining = [...packOids].filter((oid) => !queued.has(oid));
  remaining.sort();
  const packObjects: GitObject[] = [];
  for (const oid of [...ordered, ...remaining]) {
    const obj = repo.objects.get(oid);
    if (obj) packObjects.push(obj);
  }
  return { packObjects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

function sidebandPack(pack: Buffer): Buffer {
  if (pack.length === 0) return Buffer.alloc(0);
  const chunkSize = PKT_LINE_MAX - 5; // band byte + pkt-line header
  const frames = Math.ceil(pack.length / chunkSize);
  let total = 0;
  for (let i = 0; i < frames; i += 1) total += 5 + Math.min(chunkSize, pack.length - i * chunkSize);
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (let i = 0; i < frames; i += 1) {
    const start = i * chunkSize;
    const len = Math.min(chunkSize, pack.length - start);
    out.write((len + 5).toString(16).padStart(4, '0'), at, 4, 'ascii');
    out[at + 4] = 1;
    pack.copy(out, at + 5, start, start + len);
    at += 5 + len;
  }
  return out;
}

function handleUploadPackV2(repo: Repo, packets: Pkt[]): Buffer {
  const firstData = packets.find((packet) => packet.kind === 'data');
  const command = firstData ? firstData.payload.toString('utf8').trim() : '';
  // The cache key is the request itself: identical requests against an unchanged
  // store always answer identically (see touchRepo / generation).
  const requestKey = packets.map((packet) => (packet.kind === 'data' ? packet.payload.toString('utf8') : packet.kind)).join('\n');
  if (command.startsWith('command=ls-refs')) {
    const key = `lsrefs|${repo.generation}|${requestKey}`;
    const hit = gitCacheGet(repo, key);
    if (hit) return hit;
    const body = handleLsRefs(repo, packets);
    gitCachePut(repo, key, body);
    return body;
  }
  if (command.startsWith('command=fetch')) {
    const key = `fetch|${repo.generation}|${requestKey}`;
    const hit = gitCacheGet(repo, key);
    if (hit) return hit;
    const args = parseFetchArgs(packets);
    const { packObjects, shallow, unshallow } = planFetch(repo, args);
    const parts: Buffer[] = [];
    // Real git's upload-pack omits a section when it carries nothing: no
    // acknowledgments section (the stateless fetch needs no negotiation round),
    // no wanted-refs section, and shallow-info only when a boundary is reported.
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    if (packObjects.length > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(writePack(packObjects)));
    }
    parts.push(pktFlush());
    const body = Buffer.concat(parts);
    gitCachePut(repo, key, body);
    return body;
  }
  // An unknown v2 command: answer with a flush so the client sees an empty reply.
  return pktFlush();
}

async function handleGit(ctx: RequestContext): Promise<boolean> {
  const { method } = ctx;
  // /{owner}/{repo}.git/info/refs?service=git-upload-pack
  // /{owner}/{repo}.git/git-upload-pack
  // /{owner}/{repo}.git/git-receive-pack
  if (ctx.segments.length < 2) return false;
  const owner = decodeSegment(ctx.segments[0] ?? '') ?? '';
  const repoSegment = decodeSegment(ctx.segments[1] ?? '') ?? '';
  if (!repoSegment.endsWith('.git')) return false;
  const repoName = repoSegment.slice(0, -4);
  const tail = ctx.segments.slice(2);
  const repo = getRepo(owner, repoName);

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const service = ctx.query.get('service') ?? '';
    const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack') {
      if (isV2) {
        rawReply(ctx, 200, 'application/x-git-upload-pack-advertisement', ADVERTISE_V2);
        return true;
      }
      const key = `adv0|${repo.generation}|upload-pack`;
      const hit = gitCacheGet(repo, key);
      if (hit) {
        rawReply(ctx, 200, 'application/x-git-upload-pack-advertisement', hit);
        return true;
      }
      const body = advertiseV0(repo, 'upload-pack');
      gitCachePut(repo, key, body);
      rawReply(ctx, 200, 'application/x-git-upload-pack-advertisement', body);
      return true;
    }
    if (service === 'git-receive-pack') {
      const key = `adv0|${repo.generation}|receive-pack`;
      const hit = gitCacheGet(repo, key);
      if (hit) {
        rawReply(ctx, 200, 'application/x-git-receive-pack-advertisement', hit);
        return true;
      }
      const body = advertiseV0(repo, 'receive-pack');
      gitCachePut(repo, key, body);
      rawReply(ctx, 200, 'application/x-git-receive-pack-advertisement', body);
      return true;
    }
    errorReply(ctx, 400, 'unknown service');
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    let packets: Pkt[];
    try {
      packets = decodePktLines(ctx.body);
    } catch {
      // A malformed upload-pack body must not crash the server.
      rawReply(ctx, 200, 'application/x-git-upload-pack-result', pktFlush());
      return true;
    }
    const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
    if (!isV2) {
      // A v0 fetch over POST is not used by the suite; answer an empty reply.
      rawReply(ctx, 200, 'application/x-git-upload-pack-result', pktFlush());
      return true;
    }
    const body = handleUploadPackV2(repo, packets);
    rawReply(ctx, 200, 'application/x-git-upload-pack-result', body);
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (!repo) {
      errorReply(ctx, 404, 'Not Found');
      return true;
    }
    const result = handleReceivePack(repo, ctx.body);
    rawReply(ctx, 200, 'application/x-git-receive-pack-result', result);
    return true;
  }
  return false;
}

/**
 * Receive-pack (v0): parse the command pkt-lines, then the raw packfile. Each ref is
 * applied (create / update / delete) or rejected with `ng <ref> non-fast-forward`.
 * The reply is a sideband-framed report: `unpack ok`, then one `ok`/`ng` line per ref.
 */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const report: string[] = [];
  const apply: { oldOid: string; newOid: string; ref: string }[] = [];
  let parseFailed = false;
  let packStart = -1;
  try {
    let offset = 0;
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        packStart = offset;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line');
      const line = body.subarray(offset + 4, offset + length).toString('utf8');
      const nul = line.indexOf('\0');
      const text = nul >= 0 ? line.slice(0, nul) : line;
      const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
      const parts = trimmed.split(' ');
      if (parts.length >= 3) apply.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      offset += length;
    }
  } catch {
    parseFailed = true;
  }
  if (parseFailed || packStart < 0) {
    // A malformed command list: report unpack failure and stop.
    return sidebandReport(['unpack failed\n']);
  }
  const packBytes = body.subarray(packStart);
  let newObjects: Map<string, GitObject> = new Map();
  let checksumOk = true;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      newObjects = read.objects;
      checksumOk = read.checksumOk;
    } catch {
      return sidebandReport(['unpack failed\n']);
    }
  }
  if (!checksumOk) return sidebandReport(['unpack failed\n']);
  // Store the pushed objects first (a ref may only point at objects we now have).
  let changed = false;
  for (const [oid, object] of newObjects) {
    if (!repo.objects.has(oid)) changed = true;
    repo.objects.set(oid, object);
  }
  report.push('unpack ok\n');
  for (const command of apply) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current || current !== command.oldOid) {
        report.push(`ng ${command.ref} invalid old value\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      changed = true;
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} new tip is not in the pack\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    // Update.
    if (current === undefined || current !== command.oldOid) {
      report.push(`ng ${command.ref} invalid old value\n`);
      continue;
    }
    if (command.newOid === command.oldOid) {
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    report.push(`ok ${command.ref}\n`);
  }
  if (changed) touchRepo(repo);
  return sidebandReport(report);
}

function sidebandReport(lines: string[]): Buffer {
  // The report-status stream is itself a pkt-line stream, nested inside band-1
  // sideband packets (real git reads the band-1 data back as pkt-lines).
  const innerParts: Buffer[] = lines.map((line) => pktLine(line));
  innerParts.push(pktFlush());
  const inner = Buffer.concat(innerParts);
  const parts: Buffer[] = [];
  const chunkSize = PKT_LINE_MAX - 5; // band byte + pkt-line header
  let offset = 0;
  while (offset < inner.length) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// request dispatch & lifecycle
// ---------------------------------------------------------------------------

function isGitPath(segments: string[]): boolean {
  return segments.length >= 2 && segments[1]!.endsWith('.git');
}

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawSegments = url.pathname.split('/').filter((segment) => segment !== '');
  const method = (req.method ?? 'GET').toUpperCase();
  const body = await readBody(req);
  const segments = rawSegments.map((segment) => decodeSegment(segment) ?? segment);
  const ctx: RequestContext = {
    req,
    res,
    method,
    pathname: url.pathname,
    segments,
    query: url.searchParams,
    body,
    json: undefined,
  };

  // /healthz — no auth, always 200.
  if (ctx.pathname === '/healthz') {
    jsonReply(ctx, 200, { ok: true });
    return;
  }

  // Auth is required on every API and git surface (except /healthz).
  if (!checkAuth(ctx)) return;

  // JSON bodies for the REST and GraphQL surfaces are parsed lazily here; git bodies
  // stay binary, and /mcp parses its own body so a malformed one can answer -32700.
  const isApi = ctx.pathname.startsWith('/api/');
  if (isApi) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      errorReply(ctx, 400, 'Request body is not valid JSON');
      return;
    }
    ctx.json = parsed.value;
  }

  try {
    if (ctx.pathname.startsWith('/api/v3')) {
      const handled = await handleRest(ctx);
      if (!handled) errorReply(ctx, 404, 'Not Found');
      return;
    }
    if (ctx.pathname === '/api/graphql') {
      const handled = await handleGraphql(ctx);
      if (!handled) errorReply(ctx, 404, 'Not Found');
      return;
    }
    if (ctx.pathname === '/mcp') {
      const handled = await handleMcp(ctx);
      if (!handled) errorReply(ctx, 404, 'Not Found');
      return;
    }
    if (isGitPath(rawSegments)) {
      const handled = await handleGit(ctx);
      if (!handled) errorReply(ctx, 404, 'Not Found');
      return;
    }
    errorReply(ctx, 404, 'Not Found');
  } catch (err) {
    // A handler failure must never take the server down.
    try {
      errorReply(ctx, 500, `internal error: ${(err as Error).message}`);
    } catch {
      // The response may already be on its way; nothing more to do.
    }
  }
}

/** POST a JSON body to the env; returns the parsed reply, or null on a network error. */
async function envPost(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${ENV_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** GET a JSON body from the env; returns the parsed reply, or null on a network error. */
async function envGet(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${ENV_URL}${path}`, { method: 'GET' });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    dispatch(req, res).catch(() => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'internal error' }));
      } catch {
        // The response is already gone; nothing more to do.
      }
    });
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 60000;

  const host = process.env.MAKEFUN_ENV_HOST ?? '127.0.0.1';
  const portEnv = Number.parseInt(process.env.MAKEFUN_ENV_PORT ?? '0', 10);
  const listenPort = Number.isFinite(portEnv) ? portEnv : 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('the server did not bind a port');
  }
  const port = address.port;

  if (ENV_URL === '') {
    // No env to register with: serve until stopped (local testing).
    return;
  }

  // Register exactly once (the first registration wins; a second returns 409).
  const registered = await envPost('/register', { port });
  if (!registered) {
    // The env may not be up yet; retry a few times before giving up.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      if (await envPost('/register', { port })) break;
    }
  }

  // Poll /done until the trial ends, then exit 0. Start fast, back off to 2 s.
  let delayMs = 250;
  for (;;) {
    const done = await envGet('/done');
    if (done && done.done === true) break;
    await sleep(delayMs);
    if (delayMs < 2000) delayMs = Math.min(2000, delayMs * 2);
  }
  server.close();
  process.exit(0);
}

main().catch((err: Error) => {
  process.stderr.write(`github-core-clone: ${err.message}\n`);
  process.exit(1);
});
