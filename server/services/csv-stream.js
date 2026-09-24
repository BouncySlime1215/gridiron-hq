/**
 * Stream a CSV file (optionally .gz) as header-keyed records without loading
 * the whole file into memory. Standing rule 13 is the reason: an nflverse
 * season is 50-100 MB of text, and parsing it in memory is what OOMs the
 * 2 GB production machine.
 *
 * RFC 4180 quoting: a quoted field may hold commas, doubled quotes ("") and
 * newlines. nflverse play descriptions carry all three.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export async function* csvRecords(file) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  input.setEncoding('utf8');

  let header = null;
  let fields = [];
  let cur = '';
  let quoted = false;
  let pendingQuote = false; // saw a quote inside a quoted field; next char decides
  let sawAny = false;

  const finishRecord = () => {
    fields.push(cur); cur = '';
    const done = fields; fields = [];
    if (!header) { header = done.map(h => h.trim()); return null; }
    if (done.length === 1 && done[0] === '') return null; // blank line
    const rec = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = done[i] ?? '';
    return rec;
  };

  for await (const chunk of input) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      sawAny = true;
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') { cur += '"'; continue; } // escaped quote
        quoted = false; // the quote closed the field; fall through with c
      }
      if (quoted) {
        if (c === '"') pendingQuote = true; else cur += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === ',') { fields.push(cur); cur = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { const rec = finishRecord(); if (rec) yield rec; continue; }
      cur += c;
    }
  }
  if (sawAny && (cur !== '' || fields.length)) {
    const rec = finishRecord();
    if (rec) yield rec;
  }
}
