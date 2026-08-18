// OpenMazelingo — content script
// ページ内の文を決定論的な比率で選び、Chrome内蔵の Translator API(オンデバイス翻訳)で
// 別言語に差し替える(ja→en / en→ja / 両方)。外部サーバーへの通信は一切行わない。

(() => {
  const DEFAULTS = {
    enabled: true,
    mode: "ja-en", // "ja-en" | "en-ja" | "both"
    ratio: 0.3,
    minTextLength: 4,
    pageListInclude: "*://*",
    pageListExclude: "",
  };

  const STATE = { ...DEFAULTS };
  const JA_RE = /[぀-ヿ㐀-䶿一-鿿]/;
  const EN_RE = /[A-Za-z]/;
  // 全角(。！？)と半角(.!?)どちらの文末記号でも分割する
  const SENTENCE_SPLIT_RE = /([^。！？.!?\n]*[。！？.!?])/g;
  const MAX_LEN = 160;

  function detectLang(sentence) {
    if (JA_RE.test(sentence)) return "ja";
    if (EN_RE.test(sentence)) return "en";
    return null;
  }

  function wantsLang(lang) {
    if (STATE.mode === "ja-en") return lang === "ja";
    if (STATE.mode === "en-ja") return lang === "en";
    return lang === "ja" || lang === "en"; // both
  }

  // Mazelingoに倣い、ナビゲーション・フォーム・既存処理済み要素などは除外する
  const SKIP_SELECTOR = [
    "script", "style", "textarea", "input", "code", "pre", "noscript", "svg", "math",
    "select", "option", "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[contenteditable='true']", "[translate='no']", ".notranslate",
    ".openmzl-mix",
  ].join(",");

  const translators = new Map(); // "ja-en" | "en-ja" -> { instance, state }
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

  // ---- Translator API(ja→en・en→jaの2方向を独立に管理) ----

  async function ensureTranslator(source, target) {
    const key = `${source}-${target}`;
    let entry = translators.get(key);
    if (!entry) {
      entry = { instance: null, state: "idle" };
      translators.set(key, entry);
    }
    if (entry.instance || entry.state === "unavailable") return entry.instance;

    if (!("Translator" in self)) {
      entry.state = "unavailable";
      console.warn(
        "[OpenMazelingo] このブラウザでは内蔵翻訳API(Translator)が利用できません。Chrome 138以降が必要です。"
      );
      return null;
    }
    entry.state = "loading";
    try {
      const availability = await self.Translator.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
      console.log(`[OpenMazelingo] Translator.availability(${source}→${target}) = "${availability}"`);
      if (availability !== "available" && availability !== "downloadable" && availability !== "downloading") {
        entry.state = "unavailable";
        console.warn(
          `[OpenMazelingo] ${source}→${target} の翻訳モデルはこの端末では利用できません(availability="${availability}")。` +
            " chrome://on-device-translation-internals で言語パックの状態を確認してください。"
        );
        return null;
      }
      entry.instance = await self.Translator.create({
        sourceLanguage: source,
        targetLanguage: target,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            console.log(
              `[OpenMazelingo] ${source}→${target} 翻訳モデルをダウンロード中: ${Math.round(e.loaded * 100)}%`
            );
          });
        },
      });
      entry.state = "ready";
      return entry.instance;
    } catch (err) {
      entry.state = "unavailable";
      console.error(
        `[OpenMazelingo] ${source}→${target} 翻訳エンジンの初期化に失敗しました。` +
          " この言語ペアがこのChromeビルドでサポートされていないか、chrome://on-device-translation-internals で" +
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
    return trimmed.length >= STATE.minTextLength && trimmed.length <= MAX_LEN;
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
        const text = node.textContent;
        const hasJa = JA_RE.test(text);
        const hasEn = EN_RE.test(text);
        if (STATE.mode === "ja-en" && !hasJa) return NodeFilter.FILTER_REJECT;
        if (STATE.mode === "en-ja" && !hasEn) return NodeFilter.FILTER_REJECT;
        if (STATE.mode === "both" && !hasJa && !hasEn) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // 対象言語ごと(ja/en)に、その言語の文の中から比率どおりの数を独立に選ぶ
  function buildFragment(textNode) {
    const sentences = splitSentences(textNode.textContent);
    const langs = sentences.map((s) => (qualifies(s) ? detectLang(s) : null));
    const groups = { ja: [], en: [] };
    langs.forEach((lang, i) => {
      if (lang && wantsLang(lang)) groups[lang].push(i);
    });
    if (groups.ja.length === 0 && groups.en.length === 0) return null;

    const chosen = new Set();
    for (const lang of ["ja", "en"]) {
      const idxs = groups[lang];
      if (idxs.length === 0) continue;
      const seed = `${location.href}::${lang}::${idxs.map((i) => sentences[i]).join("|")}`;
      const local = pickIndices(idxs.length, STATE.ratio, seed);
      for (const li of local) chosen.add(idxs[li]);
    }
    if (chosen.size === 0) return null;

    const frag = document.createDocumentFragment();
    sentences.forEach((sentence, i) => {
      if (chosen.has(i)) {
        const lang = langs[i];
        const span = document.createElement("span");
        span.className = "openmzl-mix";
        span.dataset.original = sentence;
        span.dataset.state = "pending";
        span.textContent = sentence;
        frag.appendChild(span);
        attachInteraction(span);
        queueTranslation(span, sentence, lang);
      } else {
        frag.appendChild(document.createTextNode(sentence));
      }
    });
    return frag;
  }

  // ---- 翻訳キュー ----

  function queueTranslation(span, sentence, lang) {
    queue.push({ span, sentence, lang });
    drainQueue();
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const { span, sentence, lang } = queue.shift();
      if (!span.isConnected) continue;
      const [source, target] = lang === "ja" ? ["ja", "en"] : ["en", "ja"];
      const t = await ensureTranslator(source, target);
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
  // pinned は "original"(元の言語) / "translated"(訳した言語) のどちらを表示中かを表す。
  // ja→en か en→ja かに関係なく同じロジックで扱える。

  function applyDisplay(span) {
    if (span.dataset.state !== "ready") return;
    if (span.matches(":hover") && !span.dataset.pinned) return; // ホバー中は既存のプレビュー表示を維持
    const variant = span.dataset.pinned || "translated";
    span.textContent = variant === "original" ? span.dataset.original : span.dataset.translated;
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
      const currentlyOriginal = span.textContent === span.dataset.original;
      span.dataset.pinned = currentlyOriginal ? "translated" : "original";
      span.classList.add("openmzl-pinned");
      span.textContent =
        span.dataset.pinned === "original" ? span.dataset.original : span.dataset.translated;
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

  // 既に挿入済みのspanをすべて元のテキストに戻す
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
