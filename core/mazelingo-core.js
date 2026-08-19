export const DEFAULT_CORE_OPTIONS = {
  chunkSize: 900,
  mixRatio: 0.3,
  mode: "both",
  seed: "openmazelingo",
};

const JA_RE = /[぀-ヿ㐀-䶿一-鿿]/;
const EN_RE = /[A-Za-z]/;
const SENTENCE_SPLIT_RE = /([^。！？.!?\n]*[。！？.!?])/g;

export function normalizeText(input) {
  return String(input || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function detectLang(text) {
  if (JA_RE.test(text)) return "ja";
  if (EN_RE.test(text)) return "en";
  return null;
}

export function splitSentences(text) {
  const matches = text.match(SENTENCE_SPLIT_RE);
  if (!matches) return text ? [text] : [];
  const joined = matches.join("");
  if (joined.length < text.length) matches.push(text.slice(joined.length));
  return matches.filter((part) => part.trim().length > 0);
}

export function chunkText(input, maxChars = DEFAULT_CORE_OPTIONS.chunkSize) {
  const text = normalizeText(input);
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  function flush() {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      const sentences = splitSentences(paragraph);
      let longChunk = "";
      for (const sentence of sentences) {
        if (longChunk && longChunk.length + sentence.length > maxChars) {
          chunks.push(longChunk.trim());
          longChunk = "";
        }
        longChunk += sentence;
      }
      if (longChunk.trim()) chunks.push(longChunk.trim());
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars) {
      flush();
      current = paragraph;
    } else {
      current = next;
    }
  }

  flush();
  return chunks;
}

export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildMixPlan(sentences, options = {}) {
  const { mixRatio, mode, seed } = { ...DEFAULT_CORE_OPTIONS, ...options };
  const groups = { ja: [], en: [] };

  sentences.forEach((sentence, index) => {
    const lang = sentence.sourceLang || detectLang(sentence.original || "");
    if (lang === "ja") groups.ja.push(index);
    if (lang === "en") groups.en.push(index);
  });

  const selected = new Set();
  for (const lang of ["ja", "en"]) {
    const enabled = mode === "both" || (mode === "ja-en" && lang === "ja") || (mode === "en-ja" && lang === "en");
    if (!enabled) continue;
    const candidates = groups[lang];
    const target = Math.round(candidates.length * mixRatio);
    const shuffled = [...candidates];
    const rand = mulberry32(hashString(`${seed}:${lang}:${sentences.map((s) => s.original).join("|")}`));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.slice(0, target).forEach((index) => selected.add(index));
  }

  return sentences.map((sentence, index) => ({
    ...sentence,
    useTranslation: selected.has(index),
    displayText: selected.has(index) && sentence.translated ? sentence.translated : sentence.original,
    displayLang: selected.has(index) && sentence.translated ? oppositeLang(sentence.sourceLang) : sentence.sourceLang,
  }));
}

export function oppositeLang(lang) {
  return lang === "ja" ? "en" : lang === "en" ? "ja" : null;
}

export async function buildBilingualCache(input, translateChunk, options = {}) {
  const mergedOptions = { ...DEFAULT_CORE_OPTIONS, ...options };
  const chunks = chunkText(input, mergedOptions.chunkSize);
  const documentCache = {
    version: 1,
    sourceHash: hashString(normalizeText(input)).toString(16),
    createdAt: new Date().toISOString(),
    options: { chunkSize: mergedOptions.chunkSize },
    chunks: [],
  };

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const original = chunks[chunkIndex];
    const sourceLang = detectLang(original);
    if (!sourceLang) continue;
    const targetLang = oppositeLang(sourceLang);
    const translated = await translateChunk({
      text: original,
      sourceLang,
      targetLang,
      chunkIndex,
      previousChunk: documentCache.chunks.at(-1)?.original || "",
    });

    const sourceSentences = splitSentences(original);
    const translatedSentences = splitSentences(translated || "");
    const sentenceCount = Math.max(sourceSentences.length, translatedSentences.length);
    const sentencePairs = [];

    for (let i = 0; i < sentenceCount; i++) {
      const sourceSentence = sourceSentences[i] || "";
      const translatedSentence = translatedSentences[i] || "";
      if (!sourceSentence && !translatedSentence) continue;
      sentencePairs.push({
        id: `${chunkIndex}:${i}`,
        original: sourceSentence,
        translated: translatedSentence,
        sourceLang,
      });
    }

    documentCache.chunks.push({
      id: chunkIndex,
      sourceLang,
      targetLang,
      original,
      translated,
      sentencePairs,
    });
  }

  return documentCache;
}

export function flattenSentencePairs(cache) {
  return cache.chunks.flatMap((chunk) => chunk.sentencePairs || []);
}
