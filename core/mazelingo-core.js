export const DEFAULT_CORE_OPTIONS = {
  chunkSize: 900,
  mixRatio: 0.3,
  mode: "both",
  seed: "openmazelingo",
  alignmentStrategy: "ordered", // ordered | strict | semantic
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

function makeOrderedPairs(chunkIndex, sourceLang, sourceSentences, translatedSentences) {
  const count = Math.max(sourceSentences.length, translatedSentences.length);
  const pairs = [];
  for (let i = 0; i < count; i++) {
    const original = sourceSentences[i] || "";
    const translated = translatedSentences[i] || "";
    if (!original && !translated) continue;
    pairs.push({
      id: `${chunkIndex}:${i}`,
      semanticUnitId: `u:${chunkIndex}:${i}`,
      sourceSentenceIds: original ? [`s:${chunkIndex}:${i}`] : [],
      targetSentenceIds: translated ? [`t:${chunkIndex}:${i}`] : [],
      original,
      translated,
      sourceLang,
      alignment: "ordered",
      confidence: null,
    });
  }
  return pairs;
}

function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function bigrams(text) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set();
  if (normalized.length === 1) return new Set([normalized]);
  const result = new Set();
  for (let i = 0; i < normalized.length - 1; i++) result.add(normalized.slice(i, i + 2));
  return result;
}

export function textSimilarity(a, b) {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (!aa.size && !bb.size) return 1;
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const gram of aa) if (bb.has(gram)) overlap++;
  return (2 * overlap) / (aa.size + bb.size);
}

function joinRange(items, start, count) {
  return items.slice(start, start + count).join("");
}

export function alignSemanticUnits(sourceSentences, targetSentences, backTranslations, options = {}) {
  const mergePenalty = options.mergePenalty ?? 0.08;
  const n = sourceSentences.length;
  const m = targetSentences.length;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  dp[0][0] = { score: 0, prev: null, sourceCount: 0, targetCount: 0, similarity: 1 };

  const transitions = [
    [1, 1],
    [1, 2],
    [2, 1],
  ];

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cell = dp[i][j];
      if (!cell) continue;
      for (const [sourceCount, targetCount] of transitions) {
        if (i + sourceCount > n || j + targetCount > m) continue;
        const sourceText = joinRange(sourceSentences, i, sourceCount);
        const backText = joinRange(backTranslations, j, targetCount);
        const similarity = textSimilarity(sourceText, backText);
        const penalty = (sourceCount + targetCount - 2) * mergePenalty;
        const score = cell.score + similarity - penalty;
        const next = dp[i + sourceCount][j + targetCount];
        if (!next || score > next.score) {
          dp[i + sourceCount][j + targetCount] = {
            score,
            prev: [i, j],
            sourceCount,
            targetCount,
            similarity,
          };
        }
      }
    }
  }

  if (!dp[n][m]) return null;

  const units = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const cell = dp[i][j];
    if (!cell?.prev) return null;
    const [pi, pj] = cell.prev;
    units.push({
      sourceStart: pi,
      targetStart: pj,
      sourceCount: cell.sourceCount,
      targetCount: cell.targetCount,
      similarity: cell.similarity,
    });
    i = pi;
    j = pj;
  }
  return units.reverse();
}

async function buildStrictPairs({ original, sourceLang, targetLang, chunkIndex, translateChunk, previousChunk }) {
  const sourceSentences = splitSentences(original);
  const pairs = [];
  for (let i = 0; i < sourceSentences.length; i++) {
    const sourceSentence = sourceSentences[i];
    const translated = await translateChunk({
      text: sourceSentence,
      sourceLang,
      targetLang,
      chunkIndex,
      sentenceIndex: i,
      previousChunk,
      strategy: "strict",
    });
    pairs.push({
      id: `${chunkIndex}:${i}`,
      semanticUnitId: `u:${chunkIndex}:${i}`,
      sourceSentenceIds: [`s:${chunkIndex}:${i}`],
      targetSentenceIds: [`t:${chunkIndex}:${i}`],
      original: sourceSentence,
      translated: translated || "",
      sourceLang,
      alignment: "strict",
      confidence: 1,
    });
  }
  return { translated: pairs.map((p) => p.translated).join(""), sentencePairs: pairs };
}

async function buildSemanticPairs({ original, sourceLang, targetLang, chunkIndex, translateChunk, backTranslate, previousChunk }) {
  const translated = await translateChunk({
    text: original,
    sourceLang,
    targetLang,
    chunkIndex,
    previousChunk,
    strategy: "semantic",
  });
  const sourceSentences = splitSentences(original);
  const targetSentences = splitSentences(translated || "");
  if (!sourceSentences.length || !targetSentences.length || !backTranslate) {
    return {
      translated,
      sentencePairs: makeOrderedPairs(chunkIndex, sourceLang, sourceSentences, targetSentences),
      semanticFallback: true,
    };
  }

  const backTranslations = [];
  for (let i = 0; i < targetSentences.length; i++) {
    backTranslations.push(await backTranslate({
      text: targetSentences[i],
      sourceLang: targetLang,
      targetLang: sourceLang,
      chunkIndex,
      sentenceIndex: i,
      strategy: "semantic-backtranslation",
    }));
  }

  const alignment = alignSemanticUnits(sourceSentences, targetSentences, backTranslations);
  if (!alignment) {
    return {
      translated,
      sentencePairs: makeOrderedPairs(chunkIndex, sourceLang, sourceSentences, targetSentences),
      semanticFallback: true,
    };
  }

  const sentencePairs = alignment.map((unit, unitIndex) => {
    const sourceIds = Array.from({ length: unit.sourceCount }, (_, offset) => `s:${chunkIndex}:${unit.sourceStart + offset}`);
    const targetIds = Array.from({ length: unit.targetCount }, (_, offset) => `t:${chunkIndex}:${unit.targetStart + offset}`);
    return {
      id: `${chunkIndex}:${unitIndex}`,
      semanticUnitId: `u:${chunkIndex}:${unitIndex}`,
      sourceSentenceIds: sourceIds,
      targetSentenceIds: targetIds,
      original: joinRange(sourceSentences, unit.sourceStart, unit.sourceCount),
      translated: joinRange(targetSentences, unit.targetStart, unit.targetCount),
      sourceLang,
      alignment: "semantic",
      confidence: unit.similarity,
    };
  });

  return { translated, sentencePairs, backTranslations, semanticFallback: false };
}

export async function buildBilingualCache(input, translateChunk, options = {}) {
  const mergedOptions = { ...DEFAULT_CORE_OPTIONS, ...options };
  const chunks = chunkText(input, mergedOptions.chunkSize);
  const documentCache = {
    version: 2,
    sourceHash: hashString(normalizeText(input)).toString(16),
    createdAt: new Date().toISOString(),
    options: {
      chunkSize: mergedOptions.chunkSize,
      alignmentStrategy: mergedOptions.alignmentStrategy,
    },
    chunks: [],
  };

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const original = chunks[chunkIndex];
    const sourceLang = detectLang(original);
    if (!sourceLang) continue;
    const targetLang = oppositeLang(sourceLang);
    const previousChunk = documentCache.chunks.at(-1)?.original || "";
    let result;

    if (mergedOptions.alignmentStrategy === "strict") {
      result = await buildStrictPairs({
        original,
        sourceLang,
        targetLang,
        chunkIndex,
        translateChunk,
        previousChunk,
      });
    } else if (mergedOptions.alignmentStrategy === "semantic") {
      result = await buildSemanticPairs({
        original,
        sourceLang,
        targetLang,
        chunkIndex,
        translateChunk,
        backTranslate: mergedOptions.backTranslate,
        previousChunk,
      });
    } else {
      const translated = await translateChunk({
        text: original,
        sourceLang,
        targetLang,
        chunkIndex,
        previousChunk,
        strategy: "ordered",
      });
      result = {
        translated,
        sentencePairs: makeOrderedPairs(
          chunkIndex,
          sourceLang,
          splitSentences(original),
          splitSentences(translated || "")
        ),
      };
    }

    documentCache.chunks.push({
      id: chunkIndex,
      sourceLang,
      targetLang,
      original,
      translated: result.translated,
      sentencePairs: result.sentencePairs,
      backTranslations: result.backTranslations,
      semanticFallback: result.semanticFallback || false,
    });
  }

  return documentCache;
}

export function flattenSentencePairs(cache) {
  return cache.chunks.flatMap((chunk) => chunk.sentencePairs || []);
}
