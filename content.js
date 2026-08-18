// OpenMazelingo — content script
// ページ内の日本語文を決定論的な比率で選び、Chrome内蔵の Translator API(オンデバイス翻訳)で
// 英訳を差し込む。外部サーバーへの通信は一切行わない。

(() => {
  const DEFAULTS = {
    enabled: true,
    ratio: 0.3,
    minTextLength: 4,
    pageListInclude: "*://*",
    pageListExclude: "",
  };

  const STATE = { ...DEFAULTS };
  const JA_RE = /[぀-ヿ㐀-䶿一-鿿]/;
  const SENTENCE_SPLIT_RE = /([^。！？\n]*[。！？])/g;
  const MAX_LEN = 120;

  // Mazelingoに倣い、ナビゲーション・フォーム・既存処理済み要素などは除外する
  const SKIP_SELECTOR = [
    "script", "style", "textarea", "input", "code", "pre", "noscript", "svg", "math",
    "select", "option", "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[contenteditable='true']", "[translate='no']", ".notranslate",
    ".openmzl-mix",
  ].join(",");

  let translator = null;
  let translatorState = "idle"; // idle | loading | ready | unavailable
  const processedNodes = new WeakSet();
  const queue = [];
  let draining = false;
  let mo = null;
  let includeMatchers = [];
  let excludeMatchers = [];
  let tempDisabled = false; // 右クリックメニューの「一時的に無効」。リロードで自動解除される

  function isActive() {
    return STATE.enabled && !tempDisabled && siteAllowed();
  }

  // ---- 設定読み込み ----

  async function loadSettings() {
    const data = await chrome.storage.sync.get(DEFAULTS);
    Object.assign(STATE, data);
    includeMatchers = parsePatternList(STATE.pageListInclude);
    excludeMatchers = parsePatternList(STATE.pageListExclude);
  }

  function normalizePattern(p) {
    return p.includes("://") ? p : `*://${p}`;
  }

  function globToRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
  }

  function parsePatternList(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => globToRegex(normalizePattern(l)));
  }

  function siteAllowed() {
    if (includeMatchers.length === 0) return false;
    const included = includeMatchers.some((re) => re.test(location.href));
    if (!included) return false;
    return !excludeMatchers.some((re) => re.test(location.href));
  }

  // ---- 決定論的な文選択(URL+文内容のハッシュをシードにした乱数) ----

  function hashString(str) {
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

  function pickIndices(count, ratio, seedStr) {
    const targetCount = Math.round(count * ratio);
    const idx = Array.from({ length: count }, (_, i) => i);
    const rand = mulberry32(hashString(seedStr));
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return new Set(idx.slice(0, targetCount));
  }

  // ---- Translator API ----

  async function ensureTranslator() {
    if (translator || translatorState === "unavailable") return translator;
    if (!("Translator" in self)) {
      translatorState = "unavailable";
      console.warn(
        "[OpenMazelingo] このブラウザでは内蔵翻訳API(Translator)が利用できません。Chrome 138以降が必要です。"
      );
      return null;
    }
    translatorState = "loading";
    try {
      const availability = await self.Translator.availability({
        sourceLanguage: "ja",
        targetLanguage: "en",
      });
      console.log(`[OpenMazelingo] Translator.availability(ja→en) = "${availability}"`);
      if (availability !== "available" && availability !== "downloadable" && availability !== "downloading") {
        translatorState = "unavailable";
        console.warn(
          `[OpenMazelingo] ja→en の翻訳モデルはこの端末では利用できません(availability="${availability}")。` +
            " chrome://on-device-translation-internals で言語パックの状態を確認してください。"
        );
        return null;
      }
      translator = await self.Translator.create({
        sourceLanguage: "ja",
        targetLanguage: "en",
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            console.log(
              `[OpenMazelingo] 翻訳モデルをダウンロード中: ${Math.round(e.loaded * 100)}%`
            );
          });
        },
      });
      translatorState = "ready";
      return translator;
    } catch (err) {
      translatorState = "unavailable";
      console.error(
        "[OpenMazelingo] 翻訳エンジンの初期化に失敗しました。" +
          " ja↔en の言語ペアがこのChromeビルドでサポートされていないか、chrome://on-device-translation-internals で" +
          " 言語パックのダウンロードが必要な可能性があります。",
        err
      );
      return null;
    }
  }

  // ---- 文分割・抽出 ----

  function splitSentences(text) {
    const matches = text.match(SENTENCE_SPLIT_RE);
    if (!matches) return [text];
    const joined = matches.join("");
    if (joined.length < text.length) matches.push(text.slice(joined.length));
    return matches.filter(Boolean);
  }

  function qualifies(sentence) {
    const trimmed = sentence.trim();
    return trimmed.length >= STATE.minTextLength && trimmed.length <= MAX_LEN && JA_RE.test(trimmed);
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!JA_RE.test(node.textContent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function buildFragment(textNode) {
    const sentences = splitSentences(textNode.textContent);
    const qualifyingIdx = [];
    sentences.forEach((s, i) => {
      if (qualifies(s)) qualifyingIdx.push(i);
    });
    if (qualifyingIdx.length === 0) return null;

    const seed = `${location.href}::${qualifyingIdx.map((i) => sentences[i]).join("|")}`;
    const chosenLocal = pickIndices(qualifyingIdx.length, STATE.ratio, seed);
    const chosen = new Set([...chosenLocal].map((i) => qualifyingIdx[i]));

    const frag = document.createDocumentFragment();
    sentences.forEach((sentence, i) => {
      if (chosen.has(i)) {
        const span = document.createElement("span");
        span.className = "openmzl-mix";
        span.dataset.original = sentence;
        span.dataset.state = "pending";
        span.textContent = sentence;
        frag.appendChild(span);
        attachInteraction(span);
        queueTranslation(span, sentence);
      } else {
        frag.appendChild(document.createTextNode(sentence));
      }
    });
    return frag;
  }

  // ---- 翻訳キュー ----

  function queueTranslation(span, sentence) {
    queue.push({ span, sentence });
    drainQueue();
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    const t = await ensureTranslator();
    while (queue.length) {
      const { span, sentence } = queue.shift();
      if (!span.isConnected) continue;
      if (!t) {
        span.dataset.state = "unavailable";
        continue;
      }
      try {
        const translated = await t.translate(sentence);
        span.dataset.translated = translated;
        span.dataset.state = "ready";
        applyDisplay(span);
      } catch (err) {
        span.dataset.state = "error";
        console.error("[OpenMazelingo] 翻訳エラー", err);
      }
    }
    draining = false;
  }

  // ---- 表示制御(ホバーでプレビュー、クリックで固定) ----

  function applyDisplay(span) {
    if (span.dataset.state !== "ready") return;
    if (span.matches(":hover") && !span.dataset.pinned) return; // ホバー中は既存のプレビュー表示を維持
    const lang = span.dataset.pinned || "en";
    span.textContent = lang === "ja" ? span.dataset.original : span.dataset.translated;
  }

  function attachInteraction(span) {
    span.addEventListener("mouseenter", () => {
      if (span.dataset.state !== "ready" || span.dataset.pinned) return;
      span.textContent = span.dataset.original;
    });
    span.addEventListener("mouseleave", () => {
      if (span.dataset.state !== "ready" || span.dataset.pinned) return;
      span.textContent = span.dataset.translated;
    });
    span.addEventListener("click", () => {
      if (span.dataset.state !== "ready") return;
      const currentlyJa = span.textContent === span.dataset.original;
      span.dataset.pinned = currentlyJa ? "en" : "ja";
      span.classList.add("openmzl-pinned");
      span.textContent =
        span.dataset.pinned === "ja" ? span.dataset.original : span.dataset.translated;
    });
  }

  // ---- スキャン ----

  function scan(root = document.body) {
    if (!isActive() || !root) return;
    const nodes = collectTextNodes(root);
    for (const node of nodes) {
      processedNodes.add(node);
      const frag = buildFragment(node);
      if (frag && node.parentNode) node.parentNode.replaceChild(frag, node);
    }
  }

  function startObserving() {
    if (mo) return;
    mo = new MutationObserver((mutations) => {
      if (!isActive()) return;
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) scan(added);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
  }

  // 既に挿入済みの英訳spanをすべて元の日本語テキストに戻す
  function revertAll() {
    document.querySelectorAll(".openmzl-mix").forEach((span) => {
      const text = document.createTextNode(span.dataset.original ?? span.textContent);
      span.replaceWith(text);
    });
  }

  // 設定変更・一時無効化のたびに呼び、有効/無効の状態をDOMに即反映する
  function refresh() {
    stopObserving();
    revertAll();
    if (isActive()) {
      scan();
      startObserving();
    }
  }

  // ---- メッセージ ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "openmzl:rescan") {
      loadSettings().then(() => refresh());
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "openmzl:settings-changed") {
      loadSettings().then(() => refresh());
      return;
    }
    if (msg?.type === "openmzl:temp-disable") {
      tempDisabled = true;
      refresh();
      sendResponse({ ok: true });
      return true;
    }
  });

  (async function init() {
    await loadSettings();
    if (!document.body) return;
    scan();
    startObserving();
  })();
})();
