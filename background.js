let videoCounts = null;
let threshold = null;
let decayDays = null;
let pauseTracking = null;
let pauseBlocking = null;
let allowlistedVideos = null;
let allowlistedChannels = null;

const BACKUP_SCHEMA_VERSION = 2;
const BACKUP_KEYS = [
  "videoCounts",
  "threshold",
  "decayDays",
  "pauseTracking",
  "pauseBlocking",
  "allowlistedVideos",
  "allowlistedChannels"
];

function normalizeAllowlistEntry(entry, fallbackName) {
  if (typeof entry === "string") {
    return { id: entry, name: fallbackName || entry };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const id = entry.id || "";

  if (!id) {
    return null;
  }

  return {
    id,
    name: entry.name || fallbackName || id
  };
}

function normalizeAllowlistList(entries, fallbackName) {
  return (entries || [])
    .map((entry) => normalizeAllowlistEntry(entry, fallbackName))
    .filter(Boolean);
}

function upsertAllowlistEntry(list, entry) {
  const index = list.findIndex((item) => item.id === entry.id);

  if (index === -1) {
    list.push(entry);
  } else {
    list[index] = {
      id: list[index].id,
      name: entry.name || list[index].name || list[index].id
    };
  }
}

function normalizeCountsMap(counts) {
  const normalized = {};

  if (!counts || typeof counts !== "object") {
    return normalized;
  }

  for (const [key, value] of Object.entries(counts)) {
    const entry = normalizeCountEntry(value);

    if (key && entry) {
      normalized[key] = entry;
    }
  }

  return normalized;
}

function normalizeCountEntry(entry) {
  if (Number.isFinite(entry)) {
    const count = Math.trunc(entry);

    return count > 0 ? { count, updatedAt: Date.now() } : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const count = Number(entry.count);
  const updatedAt = Number(entry.updatedAt);

  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  return {
    count: Math.trunc(count),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : Date.now()
  };
}

function normalizeThreshold(value) {
  const thresholdValue = Number(value);

  if (!Number.isFinite(thresholdValue)) {
    return 5;
  }

  return Math.min(20, Math.max(1, Math.trunc(thresholdValue)));
}

function normalizeDecayDays(value) {
  const decayValue = Number(value);

  if (!Number.isFinite(decayValue)) {
    return 0;
  }

  return Math.min(30, Math.max(0, Math.trunc(decayValue)));
}

function buildExportPayload(storageResult) {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      videoCounts: normalizeCountsMap(storageResult.videoCounts),
      threshold: normalizeThreshold(storageResult.threshold),
      decayDays: normalizeDecayDays(storageResult.decayDays),
      pauseTracking: !!storageResult.pauseTracking,
      pauseBlocking: !!storageResult.pauseBlocking,
      allowlistedVideos: normalizeAllowlistList(storageResult.allowlistedVideos, "Video"),
      allowlistedChannels: normalizeAllowlistList(storageResult.allowlistedChannels, "Channel")
    }
  };
}

function parseImportPayload(payload) {
  const source = payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload;

  const pauseTracking = source?.pauseTracking !== undefined ? !!source.pauseTracking : !!source?.pauseAll;
  const pauseBlocking = source?.pauseBlocking !== undefined ? !!source.pauseBlocking : !!source?.pauseAll;

  return {
    videoCounts: normalizeCountsMap(source?.videoCounts),
    threshold: normalizeThreshold(source?.threshold),
    decayDays: normalizeDecayDays(source?.decayDays),
    pauseTracking,
    pauseBlocking,
    allowlistedVideos: normalizeAllowlistList(source?.allowlistedVideos, "Video"),
    allowlistedChannels: normalizeAllowlistList(source?.allowlistedChannels, "Channel")
  };
}

function sendMessageToTab(tabId, message) {
  try {
    const result = chrome.tabs.sendMessage(tabId, message);

    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (error) {}
}

function broadcastToYouTubeTabs(message) {
  chrome.tabs.query({ url: "https://*.youtube.com/*" }, (tabs) => {
    for (const tab of tabs) {
      sendMessageToTab(tab.id, message);
    }
  });
}

async function getThreshold() {
  if (threshold === null) {
    const result = await chrome.storage.local.get(["threshold"]);
    threshold = result.threshold || 5;
  }
  return threshold;
}

async function getDecayDays() {
  if (decayDays === null) {
    const result = await chrome.storage.local.get(["decayDays"]);
    decayDays = normalizeDecayDays(result.decayDays);
  }

  return decayDays;
}

async function setThreshold(newThreshold) {
  threshold = newThreshold;
  await chrome.storage.local.set({ threshold: newThreshold });
}

async function setDecayDays(newDecayDays) {
  decayDays = normalizeDecayDays(newDecayDays);
  await chrome.storage.local.set({ decayDays });
}

async function getPauseStates() {
  if (pauseTracking === null || pauseBlocking === null) {
    const result = await chrome.storage.local.get(["pauseTracking", "pauseBlocking", "pauseAll"]);
    const legacyPauseAll = result.pauseAll !== undefined ? !!result.pauseAll : false;
    pauseTracking = result.pauseTracking !== undefined ? result.pauseTracking : legacyPauseAll;
    pauseBlocking = result.pauseBlocking !== undefined ? result.pauseBlocking : legacyPauseAll;

    if (result.pauseAll !== undefined && (result.pauseTracking === undefined || result.pauseBlocking === undefined)) {
      await chrome.storage.local.set({
        pauseTracking,
        pauseBlocking
      });
      chrome.storage.local.remove("pauseAll");
    }
  }
  return { pauseTracking, pauseBlocking };
}

async function setPauseStates(states) {
  if (states.pauseTracking !== undefined) pauseTracking = states.pauseTracking;
  if (states.pauseBlocking !== undefined) pauseBlocking = states.pauseBlocking;

  await chrome.storage.local.set({
    pauseTracking: pauseTracking,
    pauseBlocking: pauseBlocking
  });
  chrome.storage.local.remove("pauseAll");
}

async function getAllowlists() {
  if (allowlistedVideos === null || allowlistedChannels === null) {
    const result = await chrome.storage.local.get(["allowlistedVideos", "allowlistedChannels"]);
    allowlistedVideos = normalizeAllowlistList(result.allowlistedVideos, "Video");
    allowlistedChannels = normalizeAllowlistList(result.allowlistedChannels, "Channel");
    await chrome.storage.local.set({
      allowlistedVideos,
      allowlistedChannels
    });
  }
  return { videos: allowlistedVideos, channels: allowlistedChannels };
}

async function addAllowlistVideo(videoId, videoName) {
  if (allowlistedVideos === null) {
    const result = await chrome.storage.local.get(["allowlistedVideos"]);
    allowlistedVideos = normalizeAllowlistList(result.allowlistedVideos, "Video");
  }
  const entry = normalizeAllowlistEntry({ id: videoId, name: videoName }, "Video");

  if (!entry) {
    return;
  }

  upsertAllowlistEntry(allowlistedVideos, entry);
  await chrome.storage.local.set({ allowlistedVideos });
  broadcastAllowlistUpdate();
}

async function addAllowlistChannel(channelId, channelName) {
  if (allowlistedChannels === null) {
    const result = await chrome.storage.local.get(["allowlistedChannels"]);
    allowlistedChannels = normalizeAllowlistList(result.allowlistedChannels, "Channel");
  }
  const entry = normalizeAllowlistEntry({ id: channelId, name: channelName }, "Channel");

  if (!entry) {
    return;
  }

  upsertAllowlistEntry(allowlistedChannels, entry);
  await chrome.storage.local.set({ allowlistedChannels });
  broadcastAllowlistUpdate();
}

async function removeAllowlist(type, id) {
  if (type === "video") {
    if (allowlistedVideos === null) {
      const result = await chrome.storage.local.get(["allowlistedVideos"]);
      allowlistedVideos = normalizeAllowlistList(result.allowlistedVideos, "Video");
    }
    allowlistedVideos = allowlistedVideos.filter((v) => v.id !== id);
    await chrome.storage.local.set({ allowlistedVideos });
    broadcastAllowlistUpdate();
  } else if (type === "channel") {
    if (allowlistedChannels === null) {
      const result = await chrome.storage.local.get(["allowlistedChannels"]);
      allowlistedChannels = normalizeAllowlistList(result.allowlistedChannels, "Channel");
    }
    allowlistedChannels = allowlistedChannels.filter((c) => c.id !== id);
    await chrome.storage.local.set({ allowlistedChannels });
    broadcastAllowlistUpdate();
  }
}

async function clearAllowlist(type) {
  // Load both lists first so the broadcast below never sends a stale empty list.
  await getAllowlists();

  if (type === "video") {
    allowlistedVideos = [];
    await chrome.storage.local.set({ allowlistedVideos });
  } else if (type === "channel") {
    allowlistedChannels = [];
    await chrome.storage.local.set({ allowlistedChannels });
  } else {
    return;
  }

  broadcastAllowlistUpdate();
}

async function broadcastAllowlistUpdate() {
  const lists = await getAllowlists();

  broadcastToYouTubeTabs({
    action: "allowlistUpdated",
    videos: lists.videos,
    channels: lists.channels
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "exportData") {
    chrome.storage.local.get(BACKUP_KEYS, (result) => {
      sendResponse({ backup: buildExportPayload(result) });
    });
    return true;
  } else if (message.action === "importData") {
    try {
      const imported = parseImportPayload(message.backup);

      videoCounts = imported.videoCounts;
      threshold = imported.threshold;
      decayDays = imported.decayDays;
      pauseTracking = imported.pauseTracking;
      pauseBlocking = imported.pauseBlocking;
      allowlistedVideos = imported.allowlistedVideos;
      allowlistedChannels = imported.allowlistedChannels;

      chrome.storage.local.set(
        {
          videoCounts,
          threshold,
          decayDays,
          pauseTracking,
          pauseBlocking,
          allowlistedVideos,
          allowlistedChannels
        },
        () => {
          chrome.storage.local.remove("pauseAll");
          broadcastToYouTubeTabs({ action: "thresholdChanged", threshold });
          broadcastToYouTubeTabs({ action: "decayDaysChanged", decayDays });
          broadcastToYouTubeTabs({
            action: "pauseStatesChanged",
            states: { pauseTracking, pauseBlocking }
          });
          broadcastToYouTubeTabs({ action: "countsUpdated" });
          broadcastAllowlistUpdate();
          sendResponse({ success: true });
        }
      );
    } catch (error) {
      sendResponse({ success: false, error: error?.message || "Import failed" });
    }
    return true;
  } else if (message.action === "getCounts") {
    if (videoCounts === null) {
      chrome.storage.local.get(["videoCounts"], (result) => {
        videoCounts = result.videoCounts || {};
        sendResponse({ counts: videoCounts });
      });
      return true;
    }
    sendResponse({ counts: videoCounts });
  } else if (message.action === "updateCounts") {
    videoCounts = message.counts;
    chrome.storage.local.set({ videoCounts });
    sendResponse({ success: true });
  } else if (message.action === "getThreshold") {
    getThreshold().then((t) => {
      sendResponse({ threshold: t });
    });
    return true;
  } else if (message.action === "getDecayDays") {
    getDecayDays().then((value) => {
      sendResponse({ decayDays: value });
    });
    return true;
  } else if (message.action === "setThreshold") {
    setThreshold(message.threshold).then(() => {
      broadcastToYouTubeTabs({
        action: "thresholdChanged",
        threshold: message.threshold
      });
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "setDecayDays") {
    setDecayDays(message.decayDays).then(() => {
      broadcastToYouTubeTabs({
        action: "decayDaysChanged",
        decayDays
      });
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "getPauseStates") {
    getPauseStates().then((s) => {
      sendResponse(s);
    });
    return true;
  } else if (message.action === "setPauseStates") {
    setPauseStates(message.states).then(() => {
      broadcastToYouTubeTabs({
        action: "pauseStatesChanged",
        states: {
          pauseTracking: pauseTracking,
          pauseBlocking: pauseBlocking
        }
      });
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "clearCounts") {
    videoCounts = {};
    chrome.storage.local.set({ videoCounts: {} }, () => {
      broadcastToYouTubeTabs({ action: "countsCleared" });
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "getAllowlists") {
    getAllowlists().then((lists) => {
      sendResponse(lists);
    });
    return true;
  } else if (message.action === "addAllowlistVideo") {
    addAllowlistVideo(message.videoId, message.videoName).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "addAllowlistChannel") {
    addAllowlistChannel(message.channelId, message.channelName).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "removeAllowlist") {
    removeAllowlist(message.type, message.id).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "clearAllowlist") {
    clearAllowlist(message.type).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});

