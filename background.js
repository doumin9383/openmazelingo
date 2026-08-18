// OpenMazelingo — background service worker
// 右クリックメニューから「このサイトを除外」「このタブだけ一時無効化」を操作する。
// 外部サーバーへの通信は一切行わない。

const MENU_DISABLE_SITE = "openmzl-disable-site";
const MENU_TEMP_DISABLE = "openmzl-temp-disable";

const DEFAULTS = {
  enabled: true,
  mode: "ja-en",
  ratio: 0.3,
  minTextLength: 4,
  pageListInclude: "*://*",
  pageListExclude: "",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_DISABLE_SITE,
      title: "OpenMazelingo: このサイトを翻訳除外リストに追加",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_TEMP_DISABLE,
      title: "OpenMazelingo: このタブで一時的に無効にする(リロードで解除)",
      contexts: ["page"],
    });
  });
});

async function addToExcludeList(origin) {
  const data = await chrome.storage.sync.get(DEFAULTS);
  const lines = String(data.pageListExclude || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pattern = `${origin}/*`;
  if (!lines.includes(pattern)) lines.push(pattern);
  await chrome.storage.sync.set({ pageListExclude: lines.join("\n") });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;

  if (info.menuItemId === MENU_TEMP_DISABLE) {
    chrome.tabs.sendMessage(tab.id, { type: "openmzl:temp-disable" }).catch(() => {});
    return;
  }

  if (info.menuItemId === MENU_DISABLE_SITE) {
    let origin;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      return;
    }
    await addToExcludeList(origin);
    chrome.tabs.sendMessage(tab.id, { type: "openmzl:settings-changed" }).catch(() => {});
  }
});
