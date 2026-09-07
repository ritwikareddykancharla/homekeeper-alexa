import type { ManualChunk } from "../types.js";
import type { AiProvider } from "../ai/bedrock.js";

/** Split manual text into overlapping chunks, keeping markdown headings as section labels. */
export function chunkText(text: string, opts: { maxChars?: number; overlap?: number } = {}): ManualChunk[] {
  const maxChars = opts.maxChars ?? 900;
  const overlap = opts.overlap ?? 120;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: ManualChunk[] = [];
  let section: string | undefined;
  let buf = "";
  let page: number | undefined;

  const push = () => {
    const t = buf.trim();
    if (t.length > 0) {
      chunks.push({ id: `c${chunks.length + 1}`, text: t, section, page });
    }
  };

  for (const line of lines) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    const pageMarker = /^\[\[page\s+(\d+)\]\]$/i.exec(line.trim());
    if (pageMarker) {
      page = Number(pageMarker[1]);
      continue;
    }
    if (heading) {
      push();
      buf = "";
      section = heading[1].trim();
      continue;
    }
    if (buf.length + line.length + 1 > maxChars) {
      push();
      buf = buf.slice(Math.max(0, buf.length - overlap)) + "\n" + line;
    } else {
      buf += (buf ? "\n" : "") + line;
    }
  }
  push();
  return chunks;
}

const STOP = new Set(
  "the a an and or of to in on for with is are be this that it its your you at by from as if not do does can will into than then so".split(" ")
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Lightweight BM25-style keyword scorer used when embeddings are unavailable. */
export function keywordScores(query: string, chunks: ManualChunk[]): number[] {
  const q = tokenize(query);
  const docs = chunks.map((c) => tokenize(`${c.section ?? ""} ${c.text}`));
  const N = docs.length || 1;
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
    }
    // Error codes like "E24" get a strong exact-match bonus.
    for (const code of query.match(/\b[a-z]{1,2}-?\d{1,3}\b/gi) ?? []) {
      if (new RegExp(`\\b${code.replace("-", "-?")}\\b`, "i").test(d.join(" "))) score += 5;
    }
    return score;
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface RetrievedChunk extends ManualChunk {
  score: number;
}

/**
 * Hybrid retrieval: cosine similarity on Bedrock embeddings when present,
 * blended with keyword scores so exact error codes always surface.
 */
export async function retrieve(ai: AiProvider, query: string, chunks: ManualChunk[], k = 4): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return [];
  const kw = keywordScores(query, chunks);
  const kwMax = Math.max(...kw, 1e-6);
  let sem: number[] | undefined;
  if (chunks.some((c) => c.embedding)) {
    const [qv] = (await ai.embed([query])) ?? [];
    if (qv) sem = chunks.map((c) => (c.embedding ? cosine(qv, c.embedding) : 0));
  }
  const scored = chunks.map((c, i) => {
    const kwNorm = kw[i] / kwMax;
    const s = sem ? 0.65 * sem[i] + 0.35 * kwNorm : kwNorm;
    const { embedding: _e, ...rest } = c;
    return { ...rest, score: s };
  });
  return scored
    .filter((c) => c.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
