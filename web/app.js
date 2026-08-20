import {
  buildBilingualCache,
  buildMixPlan,
  flattenSentencePairs,
} from "../core/mazelingo-core.js";

const sourceTextEl = document.getElementById("sourceText");
const modeEl = document.getElementById("mode");
const alignmentStrategyEl = document.getElementById("alignmentStrategy");
const mixRatioEl = document.getElementById("mixRatio");
const mixRatioValueEl = document.getElementById("mixRatioValue");
const chunkSizeEl = document.getElementById("chunkSize");
const generateBtn = document.getElementById("generate");
const remixBtn = document.getElementById("remix");
const downloadCacheBtn = document.getElementById("downloadCache");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const cacheInfoEl = document.getElementById("cacheInfo");

let cache = null;
const translators = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function options() {
  return {
    chunkSize: Math.max(200, Number(chunkSizeEl.value) || 900),
    mixRatio: Number(mixRatioEl.value) / 100,
    mode: modeEl.value,
    alignmentStrategy: alignmentStrategyEl.value,
    seed: cache?.sourceHash || "openmazelingo-web",
    backTranslate,
  };
}

async function ensureTranslator(sourceLang, targetLang) {
  const key = `${sourceLang}-${targetLang}`;
  if (translators.has(key)) return translators.get(key);
  if (!("Translator" in self)) return null;

  const availability = await self.Translator.availability({
    sourceLanguage: sourceLang,
    targetLanguage: targetLang,
  });
  if (!["available", "downloadable", "downloading"].includes(availability)) return null;

  const instance = await self.Translator.create({
    sourceLanguage: sourceLang,
    targetLanguage: targetLang,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        setStatus(`${sourceLang}→${targetLang} model: ${Math.round(event.loaded * 100)}%`);
      });
    },
  });
  translators.set(key, instance);
  return instance;
}

async function runTranslation({ text, sourceLang, targetLang }) {
  const translator = await ensureTranslator(sourceLang, targetLang);
  if (!translator) return text;
  return translator.translate(text);
}

async function translateChunk({ text, sourceLang, targetLang, chunkIndex, sentenceIndex, strategy }) {
  const position = sentenceIndex == null
    ? `chunk ${chunkIndex + 1}`
    : `chunk ${chunkIndex + 1}, sentence ${sentenceIndex + 1}`;
  setStatus(`${strategy || "translation"}: ${position}…`);
  try {
    return await runTranslation({ text, sourceLang, targetLang });
  } catch (error) {
    console.warn("[OpenMazelingo Web] translation fallback", error);
    return text;
  }
}

async function backTranslate({ text, sourceLang, targetLang, chunkIndex, sentenceIndex }) {
  setStatus(`semantic align: chunk ${chunkIndex + 1}, back-translate ${sentenceIndex + 1}…`);
  try {
    return await runTranslation({ text, sourceLang, targetLang });
  } catch (error) {
    console.warn("[OpenMazelingo Web] back-translation fallback", error);
    return text;
  }
}

function render() {
  resultEl.replaceChildren();
  if (!cache) return;

  const pairs = flattenSentencePairs(cache);
  const mixed = buildMixPlan(pairs, options());
  for (const sentence of mixed) {
    const span = document.createElement("span");
    span.className = `sentence lang-${sentence.displayLang || sentence.sourceLang || "unknown"}`;
    if (sentence.useTranslation && sentence.translated) span.classList.add("translated");
    span.textContent = sentence.displayText;

    const confidence = Number.isFinite(sentence.confidence)
      ? ` / alignment ${sentence.alignment} ${(sentence.confidence * 100).toFixed(0)}%`
      : ` / alignment ${sentence.alignment || "unknown"}`;
    span.title = sentence.useTranslation && sentence.translated
      ? `Original: ${sentence.original}${confidence}`
      : sentence.translated
        ? `Translation: ${sentence.translated}${confidence}`
        : `Translation unavailable${confidence}`;
    resultEl.appendChild(span);
  }

  const fallbackCount = cache.chunks.filter((chunk) => chunk.semanticFallback).length;
  const fallbackInfo = fallbackCount ? ` / semantic fallback ${fallbackCount}` : "";
  cacheInfoEl.textContent = `${cache.chunks.length} chunks / ${pairs.length} units / ${cache.options.alignmentStrategy}${fallbackInfo} / cache ${cache.sourceHash}`;
}

async function generate() {
  const text = sourceTextEl.value.trim();
  if (!text) {
    setStatus("テキストを入力してください。");
    return;
  }

  generateBtn.disabled = true;
  remixBtn.disabled = true;
  downloadCacheBtn.disabled = true;
  resultEl.textContent = "";

  try {
    cache = await buildBilingualCache(text, translateChunk, options());
    render();
    remixBtn.disabled = false;
    downloadCacheBtn.disabled = false;
    setStatus(`Done. ${cache.options.alignmentStrategy} alignment で bilingual cache を生成しました。`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed: ${error.message || error}`);
  } finally {
    generateBtn.disabled = false;
  }
}

function downloadCache() {
  if (!cache) return;
  const blob = new Blob([JSON.stringify(cache, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openmazelingo-${cache.sourceHash}-${cache.options.alignmentStrategy}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

mixRatioEl.addEventListener("input", () => {
  mixRatioValueEl.textContent = `${mixRatioEl.value}%`;
  if (cache) render();
});
modeEl.addEventListener("change", () => cache && render());
alignmentStrategyEl.addEventListener("change", () => {
  if (cache) setStatus("Alignment strategy を変えたので Generate でキャッシュを再生成してください。");
});
generateBtn.addEventListener("click", generate);
remixBtn.addEventListener("click", render);
downloadCacheBtn.addEventListener("click", downloadCache);
