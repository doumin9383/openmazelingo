const DEFAULTS = {
  enabled: true,
  mode: "ja-en",
  ratio: 0.3,
  minTextLength: 4,
  pageListInclude: "*://*",
  pageListExclude: "",
};

const enabledEl = document.getElementById("enabled");
const modeBtns = Array.from(document.querySelectorAll(".mode-btn"));
const ratioEl = document.getElementById("ratio");
const ratioValueEl = document.getElementById("ratioValue");
const ratioJaValueEl = document.getElementById("ratioJaValue");
const waveFillEl = document.getElementById("waveFill");
const minTextLengthEl = document.getElementById("minTextLength");
const pageListIncludeEl = document.getElementById("pageListInclude");
const pageListExcludeEl = document.getElementById("pageListExclude");
const addCurrentIncludeBtn = document.getElementById("addCurrentInclude");
const addCurrentExcludeBtn = document.getElementById("addCurrentExclude");
const statusEl = document.getElementById("status");
const rescanBtn = document.getElementById("rescan");

let currentOrigin = "";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function init() {
  const tab = await getActiveTab();
  try {
    currentOrigin = new URL(tab.url).origin;
  } catch {
    currentOrigin = "";
  }

  const data = await getSettings();
  enabledEl.checked = data.enabled;
  setActiveMode(data.mode);
  ratioEl.value = Math.round(data.ratio * 100);
  updateRatioDisplay();
  minTextLengthEl.value = data.minTextLength;
  pageListIncludeEl.value = data.pageListInclude;
  pageListExcludeEl.value = data.pageListExclude;

  addCurrentIncludeBtn.disabled = !currentOrigin;
  addCurrentExcludeBtn.disabled = !currentOrigin;

  startWobble();
}

async function notifyContentScript() {
  const tab = await getActiveTab();
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "openmzl:settings-changed" }).catch(() => {});
  }
}

async function save(partial) {
  const data = await getSettings();
  await chrome.storage.sync.set({ ...data, ...partial });
  notifyContentScript();
}

// Splatoon風の陣取りバトルバー: EN(緑)とJA(青)の境界をギザギザの波形にして、
// 常に小さく揺れ動かすことで「拮抗している」感じを出す。
function buildZigzagClipPath(boundaryPercent, phase) {
  const teeth = 4;
  const amplitude = 1.8; // 境界の基本的なギザギザの振れ幅(%)
  const wobble = 0.5; // 揺れアニメーションの振れ幅(%)
  const b = Math.max(0, Math.min(100, boundaryPercent));
  const points = ["0% 0%"];
  for (let i = 0; i <= teeth; i++) {
    const y = (i / teeth) * 100;
    const dir = i % 2 === 0 ? 1 : -1;
    const sway = Math.sin(phase + i * 1.3) * wobble;
    const x = Math.max(0, Math.min(100, b + dir * amplitude + sway));
    points.push(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
  }
  points.push("0% 100%");
  return `polygon(${points.join(", ")})`;
}

let wobblePhase = 0;
let wobbleTimer = null;

function renderWave() {
  const en = Number(ratioEl.value);
  waveFillEl.style.clipPath = buildZigzagClipPath(en, wobblePhase);
}

function startWobble() {
  if (wobbleTimer) return;
  wobbleTimer = setInterval(() => {
    wobblePhase += 0.12;
    renderWave();
  }, 140);
}

function updateRatioDisplay() {
  const en = Number(ratioEl.value);
  ratioValueEl.textContent = `${en}%`;
  ratioJaValueEl.textContent = `${100 - en}%`;
  renderWave();
}

// ちょっとしたバウンス演出(トースト的な完了表示や数値更新に使う)
function pop(el) {
  el.classList.remove("is-pop");
  void el.offsetWidth; // reflow でアニメーションを再始動させる
  el.classList.add("is-pop");
}

function setActiveMode(mode) {
  modeBtns.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.mode === mode));
}

modeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    setActiveMode(btn.dataset.mode);
    pop(btn);
    save({ mode: btn.dataset.mode });
  });
});

enabledEl.addEventListener("change", () => save({ enabled: enabledEl.checked }));

ratioEl.addEventListener("input", updateRatioDisplay);
ratioEl.addEventListener("change", () => {
  save({ ratio: Number(ratioEl.value) / 100 });
  pop(ratioValueEl);
  pop(ratioJaValueEl);
});

minTextLengthEl.addEventListener("change", () => {
  const v = Math.max(1, Math.min(100, Number(minTextLengthEl.value) || DEFAULTS.minTextLength));
  minTextLengthEl.value = v;
  save({ minTextLength: v });
});

pageListIncludeEl.addEventListener("change", () => save({ pageListInclude: pageListIncludeEl.value }));
pageListExcludeEl.addEventListener("change", () => save({ pageListExclude: pageListExcludeEl.value }));

function addLineIfMissing(textarea, line) {
  const lines = textarea.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.includes(line)) lines.push(line);
  textarea.value = lines.join("\n");
}

addCurrentIncludeBtn.addEventListener("click", () => {
  if (!currentOrigin) return;
  addLineIfMissing(pageListIncludeEl, `${currentOrigin}/*`);
  save({ pageListInclude: pageListIncludeEl.value });
});

addCurrentExcludeBtn.addEventListener("click", () => {
  if (!currentOrigin) return;
  addLineIfMissing(pageListExcludeEl, `${currentOrigin}/*`);
  save({ pageListExclude: pageListExcludeEl.value });
});

rescanBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  statusEl.textContent = "再スキャン中...";
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "openmzl:rescan" });
    statusEl.textContent = "✨ 完了しました！";
    pop(statusEl);
  } catch {
    statusEl.textContent = "このページでは実行できません(拡張機能ページ等)。";
  }
});

init();
