/**
 * Minimal protobuf wire-format reader (no .proto, no dependencies).
 * Enough to walk known field numbers out of opaque vendor blobs: varints,
 * fixed32/64, and length-delimited fields that may be nested messages or
 * UTF-8 strings. Callers decide which LEN fields to descend into — anything
 * not asked for is skipped untouched, which is also the privacy-preserving
 * behavior (conversation text is never decoded).
 */

export interface WireField {
  wireType: number;
  /** wire types 0/1/5 */
  num: bigint;
  /** wire type 2 */
  bytes: Uint8Array;
}

export type WireMessage = Map<number, WireField[]>;

function readVarint(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (off >= buf.length) throw new Error('truncated varint');
    const b = buf[off++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, off];
    shift += 7n;
  }
  throw new Error('varint too long');
}

/** Parse one message level. Throws on malformed input — callers treat that as "not a message". */
export function decodeMessage(buf: Uint8Array): WireMessage {
  const fields: WireMessage = new Map();
  let off = 0;
  while (off < buf.length) {
    const [tag, afterTag] = readVarint(buf, off);
    off = afterTag;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNum === 0) throw new Error('field 0');
    let field: WireField;
    if (wireType === 0) {
      const [v, next] = readVarint(buf, off);
      off = next;
      field = { wireType, num: v, bytes: new Uint8Array(0) };
    } else if (wireType === 1 || wireType === 5) {
      const size = wireType === 1 ? 8 : 4;
      if (off + size > buf.length) throw new Error('truncated fixed');
      field = { wireType, num: 0n, bytes: buf.subarray(off, off + size) };
      off += size;
    } else if (wireType === 2) {
      const [len, next] = readVarint(buf, off);
      off = next;
      const end = off + Number(len);
      if (end > buf.length) throw new Error('truncated bytes');
      field = { wireType, num: 0n, bytes: buf.subarray(off, end) };
      off = end;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
    let list = fields.get(fieldNum);
    if (!list) fields.set(fieldNum, (list = []));
    list.push(field);
  }
  return fields;
}

/** First occurrence of a varint field, as Number (0 when absent). */
export function intField(msg: WireMessage | undefined, id: number): number {
  const f = msg?.get(id)?.find((x) => x.wireType === 0);
  return f ? Number(f.num) : 0;
}

/** First occurrence of a LEN field decoded as UTF-8 (undefined when absent). */
export function strField(msg: WireMessage | undefined, id: number): string | undefined {
  const f = msg?.get(id)?.find((x) => x.wireType === 2);
  return f ? new TextDecoder().decode(f.bytes) : undefined;
}

/** First occurrence of a LEN field parsed as a nested message (undefined when absent/not a message). */
export function msgField(msg: WireMessage | undefined, id: number): WireMessage | undefined {
  const f = msg?.get(id)?.find((x) => x.wireType === 2);
  if (!f) return undefined;
  try {
    return decodeMessage(f.bytes);
  } catch {
    return undefined;
  }
}

/** All occurrences of a repeated LEN field parsed as nested messages. */
export function msgFields(msg: WireMessage | undefined, id: number): WireMessage[] {
  const out: WireMessage[] = [];
  for (const f of msg?.get(id) ?? []) {
    if (f.wireType !== 2) continue;
    try {
      out.push(decodeMessage(f.bytes));
    } catch {
      /* not a message */
    }
  }
  return out;
}
