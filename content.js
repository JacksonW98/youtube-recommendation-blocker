console.log("YT EXTENSION LOADED");

let THRESHOLD = 5;
let DECAY_DAYS = 0;
const DEBUG = false;
let PAUSE_ALL = false;
let PAUSE_TRACKING = false;
let PAUSE_BLOCKING = false;
let ALLOWLISTED_VIDEOS = [];
let ALLOWLISTED_CHANNELS = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const cardVideoIds = new WeakMap();

let countsCache = null;
let isProcessing = false;
let hasPendingRun = false;
let saveTimer = null;
let processTimer = null;

function log(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

function ensureCountBadge(card) {
  let badge = card.querySelector(".yt-extension-count-badge");

  if (badge) {
    return badge;
  }

  const badgeHost = card.querySelector("#thumbnail") || card;

  if (getComputedStyle(badgeHost).position === "static") {
    badgeHost.style.position = "relative";
  }

  badge = document.createElement("div");
  badge.className = "yt-extension-count-badge";
  badge.style.cssText = `
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 9999;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    pointer-events: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  `;

  badgeHost.appendChild(badge);

  return badge;
}

function removeCountBadge(card) {
  const badge = card.querySelector(".yt-extension-count-badge");

  if (badge) {
    badge.remove();
  }
}

function isAllowlistedVideo(videoId) {
  return ALLOWLISTED_VIDEOS.some((item) => item && item.id === videoId);
}

function isAllowlistedChannel(channelId) {
  return ALLOWLISTED_CHANNELS.some((item) => item && item.id === channelId);
}

// Only the home feed is tracked or filtered. The content script still has to
// load on every YouTube page, because YouTube is a single-page app: a script
// injected only at "/" would never run for someone who lands on a watch page
// and then navigates home.
function isHomePage() {
  return window.location.pathname === "/";
}

function removeExtensionUi() {
  const injected = document.querySelectorAll(
    ".yt-extension-count-badge, .yt-extension-allow-buttons"
  );

  for (const node of injected) {
    node.remove();
  }
}

// Restores only what this extension hid. restoreAllCards() clears any inline
// display:none it finds, which off the home feed could reveal something YouTube
// itself meant to keep hidden.
function restoreHiddenByExtension() {
  const hidden = document.querySelectorAll('[data-yt-ext-hidden="true"]');

  for (const container of hidden) {
    container.style.display = "";
    delete container.dataset.ytExtHidden;
  }
}

function deactivate() {
  restoreHiddenByExtension();
  removeExtensionUi();
  resetProcessedCards();
}

function getCardContainer(card) {
  return card.closest(
    "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer"
  ) || card;
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

function normalizeCountsCache(counts) {
  const normalized = {};

  for (const [videoId, entry] of Object.entries(counts || {})) {
    const normalizedEntry = normalizeCountEntry(entry);

    if (videoId && normalizedEntry) {
      normalized[videoId] = normalizedEntry;
    }
  }

  return normalized;
}

function extractVideoTitle(card) {
  const titleLink = card.querySelector("a#video-title, yt-formatted-string#video-title");

  if (titleLink) {
    const title = titleLink.textContent?.trim();

    if (title) {
      return title;
    }
  }

  return "Video";
}

function parseChannelId(href) {
  try {
    const url = new URL(href, window.location.origin);
    const channelMatch = url.pathname.match(/\/channel\/([^/?]+)/);
    const handleMatch = url.pathname.match(/\/@([^/?]+)/);

    return channelMatch?.[1] || handleMatch?.[1] || null;
  } catch (e) {
    return null;
  }
}

function extractChannelInfo(card) {
  // Match on href rather than class/id
  const channelLinks = card.querySelectorAll("a[href*='/@'], a[href*='/channel/']");

  let fallback = null;

  for (const link of channelLinks) {
    if (!link.href) {
      continue;
    }

    const channelId = parseChannelId(link.href);

    if (!channelId) {
      continue;
    }

    const channelName = link.textContent?.trim() || link.getAttribute("aria-label")?.trim() || "";

    if (channelName) {
      return { channelId, channelName };
    }

    if (!fallback) {
      fallback = { channelId, channelName: channelId };
    }
  }

  return fallback;
}

function createAllowButton(className, label, title) {
  const button = document.createElement("button");

  button.className = className;
  button.textContent = label;
  button.title = title;
  button.style.cssText = `
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    font-size: 12px;
    font-weight: bold;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  `;
  button.addEventListener("mouseenter", () => {
    button.style.background = "rgba(0, 0, 0, 0.9)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "rgba(0, 0, 0, 0.7)";
  });

  return button;
}

function ensureAllowButtons(card, videoId, videoName, channelInfo) {
  let buttonContainer = card.querySelector(".yt-extension-allow-buttons");

  if (buttonContainer && buttonContainer.dataset.ytExtVideoId !== videoId) {
    buttonContainer.remove();
    buttonContainer = null;
  }

  if (!buttonContainer) {
    const badgeHost = card.querySelector("#thumbnail") || card;

    if (getComputedStyle(badgeHost).position === "static") {
      badgeHost.style.position = "relative";
    }

    buttonContainer = document.createElement("div");
    buttonContainer.className = "yt-extension-allow-buttons";
    buttonContainer.dataset.ytExtVideoId = videoId;
    buttonContainer.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 9998;
      display: flex;
      gap: 4px;
      pointer-events: auto;
    `;

    const allowVideoBtn = createAllowButton("yt-extension-allow-video", "V", "Allow this video");

    allowVideoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: "addAllowlistVideo", videoId, videoName });
      allowVideoBtn.style.opacity = "0.5";
      allowVideoBtn.disabled = true;
    });

    buttonContainer.appendChild(allowVideoBtn);
    badgeHost.appendChild(buttonContainer);
  }

  // The channel row hydrates after the thumbnail, so the "C" button usually has
  // to be added on a later pass than the "V" button.
  if (channelInfo?.channelId && !buttonContainer.querySelector(".yt-extension-allow-channel")) {
    const allowChannelBtn = createAllowButton("yt-extension-allow-channel", "C", "Allow channel");

    allowChannelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({
        action: "addAllowlistChannel",
        channelId: channelInfo.channelId,
        channelName: channelInfo.channelName
      });
      allowChannelBtn.style.opacity = "0.5";
      allowChannelBtn.disabled = true;
    });

    buttonContainer.appendChild(allowChannelBtn);
  }
}

function updateCountBadge(card, count) {
  if (!Number.isFinite(count) || count < 2) {
    removeCountBadge(card);
    return;
  }

  const badge = ensureCountBadge(card);

  badge.textContent = `Seen ${count - 1}x`;
}

async function getCounts() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getCounts" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({});
        return;
      }

      resolve(response.counts || {});
    });
  });
}

async function saveCounts(counts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: "updateCounts", counts },
      () => resolve()
    );
  });
}

async function getThreshold() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getThreshold" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve(5);
        return;
      }

      resolve(response.threshold || 5);
    });
  });
}

async function getDecayDays() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getDecayDays" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve(0);
        return;
      }

      resolve(Number.isFinite(response.decayDays) ? response.decayDays : 0);
    });
  });
}

async function getCountsCache() {
  if (!countsCache) {
    countsCache = normalizeCountsCache(await getCounts());
  }

  return countsCache;
}

function getValidCount(counts, videoId) {
  const value = counts[videoId];

  if (Number.isFinite(value)) {
    return value > 0 ? Math.trunc(value) : 0;
  }

  if (!value || typeof value !== "object") {
    return 0;
  }

  const count = Number(value.count);

  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function getDecayedCount(entry, now = Date.now()) {
  const normalized = normalizeCountEntry(entry);

  if (!normalized) {
    return null;
  }

  if (DECAY_DAYS <= 0) {
    return normalized;
  }

  const intervalMs = DECAY_DAYS * DAY_MS;
  const elapsed = now - normalized.updatedAt;

  if (!Number.isFinite(elapsed) || elapsed < intervalMs) {
    return normalized;
  }

  const steps = Math.floor(elapsed / intervalMs);
  const nextCount = normalized.count - steps;

  if (nextCount <= 0) {
    return null;
  }

  return {
    count: nextCount,
    updatedAt: normalized.updatedAt + steps * intervalMs
  };
}

function decayCountsCache(now = Date.now()) {
  if (!countsCache) {
    return false;
  }

  let changed = false;

  for (const [videoId, entry] of Object.entries(countsCache)) {
    const decayed = getDecayedCount(entry, now);

    if (!decayed) {
      delete countsCache[videoId];
      changed = true;
      continue;
    }

    if (
      !entry ||
      typeof entry !== "object" ||
      entry.count !== decayed.count ||
      entry.updatedAt !== decayed.updatedAt
    ) {
      countsCache[videoId] = decayed;
      changed = true;
    }
  }

  return changed;
}

function scheduleCountsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (countsCache) {
      saveCounts(countsCache);
    }
  }, 400);
}

function extractVideoId(urlString) {
  try {
    const url = new URL(urlString, window.location.origin);

    if (url.pathname.startsWith("/shorts/")) {
      const parts = url.pathname.split("/").filter(Boolean);

      return parts[1] || null;
    }

    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

function findCards() {
  return document.querySelectorAll(`
    ytd-rich-item-renderer,
    ytd-compact-video-renderer,
    ytd-video-renderer,
    ytd-grid-video-renderer
  `);
}

function findVideoLink(card) {
  return card.querySelector(`
    a#thumbnail[href*="/watch"],
    a.yt-simple-endpoint[href*="/watch"],
    a[href*="/watch?v="],
    a[href*="/shorts/"]
  `);
}

function removeCardFromLayout(card) {
  const container = getCardContainer(card);

  container.style.display = "none";
  container.dataset.ytExtHidden = "true";
}

function restoreCardVisibility(card) {
  const container = getCardContainer(card);

  if (container.dataset.ytExtHidden === "true") {
    container.style.display = "";
    delete container.dataset.ytExtHidden;
  }
}

function compactHomeGrid() {
  const rows = document.querySelectorAll("ytd-rich-grid-row");

  for (const row of rows) {
    const items = row.querySelectorAll("ytd-rich-item-renderer");

    for (const item of items) {
      if (item.style.display === "none" || !findVideoLink(item)) {
        item.remove();
      }
    }

    if (!row.querySelector("ytd-rich-item-renderer")) {
      row.remove();
    }
  }
}
async function fastBlockAlreadyBlocked() {
  if (!isHomePage() || !countsCache) {
    return;
  }

  if (decayCountsCache()) {
    scheduleCountsSave();
  }

  const cards = findCards();

  for (const card of cards) {
    if (card.dataset.ytExtFastChecked) {
      continue;
    }

    const link = findVideoLink(card);

    if (!link || !link.href) {
      card.dataset.ytExtFastChecked = "true";
      continue;
    }

    const videoId = extractVideoId(link.href);

    if (!videoId) {
      card.dataset.ytExtFastChecked = "true";
      continue;
    }

    card.dataset.ytExtFastChecked = "true";

    const count = getValidCount(countsCache, videoId);

    if (count > THRESHOLD && !PAUSE_BLOCKING && !isAllowlistedVideo(videoId)) {
      removeCardFromLayout(card);
      log(`FAST BLOCKED ${videoId} (count: ${count})`);
    }
  }
}

  function restoreAllCards() {
    const cards = findCards();

    for (const card of cards) {
      const container = card.closest(
        "ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer"
      ) || card;
      if (container.style.display === "none") {
        container.style.display = "";
      }

      // Clear internal markers so cards will be re-processed when blocking resumes
      try {
        delete card.dataset.ytExtRenderedVideoId;
        delete card.dataset.videoId;
        delete card.dataset.ytExtFastChecked;
      } catch (e) {}
    }
  }

function resetProcessedCards() {
  const cards = findCards();

  for (const card of cards) {
    try {
      delete card.dataset.ytExtRenderedVideoId;
      delete card.dataset.videoId;
      delete card.dataset.ytExtFastChecked;
    } catch (e) {}
  }
}

function refreshHomeGridLayout() {
  compactHomeGrid();
  window.dispatchEvent(new Event("resize"));
}

async function processVideos() {
  if (!isHomePage() || (PAUSE_TRACKING && PAUSE_BLOCKING)) {
    isProcessing = false;
    return;
  }

  if (isProcessing) {
    hasPendingRun = true;
    return;
  }

  // Mark active here rather than only in runPass, so anything this touches is
  // torn down on navigation no matter which entry point started the pass.
  wasActive = true;
  isProcessing = true;

  try {
    const counts = await getCountsCache();

    if (decayCountsCache()) {
      scheduleCountsSave();
    }

    const cards = findCards();
    let removedAnyCard = false;

    log("PROCESSING CARDS:", cards.length);

    for (const card of cards) {
      const link = findVideoLink(card);

      if (!link || !link.href) {
        continue;
      }

      const videoId = extractVideoId(link.href);

      if (!videoId) {
        continue;
      }

      if (card.dataset.ytExtRenderedVideoId === videoId) {
        // Already counted, but the channel row may have rendered since this card
        // was first processed, so give the "C" button another chance to appear.
        if (!card.querySelector(".yt-extension-allow-channel")) {
          const lateChannelInfo = extractChannelInfo(card);

          if (lateChannelInfo?.channelId) {
            ensureAllowButtons(card, videoId, extractVideoTitle(card), lateChannelInfo);
          }
        }

        continue;
      }

      const previousVideoId = cardVideoIds.get(card);

      if (previousVideoId !== videoId) {
        if (!PAUSE_TRACKING) {
          const currentEntry = counts[videoId];
          const decayedEntry = getDecayedCount(currentEntry) || { count: 0, updatedAt: Date.now() };

          counts[videoId] = {
            count: decayedEntry.count + 1,
            updatedAt: Date.now()
          };
        }
        cardVideoIds.set(card, videoId);
      }

      const currentCount = getValidCount(counts, videoId);

      log(`VIDEO ${videoId} COUNT ${currentCount}`);

      card.dataset.videoId = videoId;
      card.dataset.ytExtRenderedVideoId = videoId;
      updateCountBadge(card, currentCount);

      const videoName = extractVideoTitle(card);
      const channelInfo = extractChannelInfo(card);
      ensureAllowButtons(card, videoId, videoName, channelInfo);

      if (
        currentCount > THRESHOLD &&
        !PAUSE_BLOCKING &&
        !isAllowlistedVideo(videoId) &&
        !(channelInfo?.channelId && isAllowlistedChannel(channelInfo.channelId))
      ) {
        removeCardFromLayout(card);
        removedAnyCard = true;

        log(`HIDING ${videoId}`);
      } else {
        restoreCardVisibility(card);
      }
    }

    if (removedAnyCard) {
      refreshHomeGridLayout();
    }

    scheduleCountsSave();
  } finally {
    isProcessing = false;

    if (hasPendingRun) {
      hasPendingRun = false;
      scheduleProcessVideos(100);
    }
  }
}

function scheduleProcessVideos(delay = 150) {
  if (processTimer) {
    clearTimeout(processTimer);
  }

  processTimer = setTimeout(() => {
    processTimer = null;
    processVideos();
  }, delay);
}

// Tracks whether the last run touched the page, so leaving the home feed tears
// down injected UI exactly once instead of on every mutation.
let wasActive = false;

function runPass() {
  if (!isHomePage()) {
    if (wasActive) {
      wasActive = false;
      deactivate();
    }

    return;
  }

  wasActive = true;

  if (PAUSE_ALL) {
    restoreAllCards();
  } else {
    if (!PAUSE_BLOCKING) fastBlockAlreadyBlocked();
    compactHomeGrid();
    scheduleProcessVideos(150);
  }
}

const observer = new MutationObserver(runPass);

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// YouTube swaps pages without a reload, so react to its own navigation event
// rather than waiting for the next stray mutation.
window.addEventListener("yt-navigate-finish", runPass);

chrome.storage.local.get(["pauseTracking", "pauseBlocking", "pauseAll", "allowlistedVideos", "allowlistedChannels"], (res) => {
  const legacyPauseAll = res.pauseAll !== undefined ? !!res.pauseAll : false;
  PAUSE_TRACKING = res.pauseTracking !== undefined ? res.pauseTracking : legacyPauseAll;
  PAUSE_BLOCKING = res.pauseBlocking !== undefined ? res.pauseBlocking : legacyPauseAll;
  ALLOWLISTED_VIDEOS = res.allowlistedVideos || [];
  ALLOWLISTED_CHANNELS = res.allowlistedChannels || [];

  Promise.all([getCountsCache(), getThreshold(), getDecayDays()]).then(([, t, decay]) => {
    THRESHOLD = t;
    DECAY_DAYS = decay;

    if (decayCountsCache()) {
      scheduleCountsSave();
    }

    if (!isHomePage()) {
      return;
    }

    wasActive = true;

    if (PAUSE_TRACKING && PAUSE_BLOCKING) {
      restoreAllCards();
    } else {
      fastBlockAlreadyBlocked();
      processVideos();
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "thresholdChanged") {
    THRESHOLD = message.threshold;
    processVideos();
  } else if (message.action === "decayDaysChanged") {
    DECAY_DAYS = Number.isFinite(message.decayDays) ? message.decayDays : 0;
    if (decayCountsCache()) {
      scheduleCountsSave();
    }
    processVideos();
  } else if (message.action === "pauseStatesChanged") {
    const s = message.states || {};
    PAUSE_TRACKING = !!s.pauseTracking;
    PAUSE_BLOCKING = !!s.pauseBlocking;

    if (!isHomePage()) {
      return;
    }

    if (PAUSE_TRACKING && PAUSE_BLOCKING) {
      restoreAllCards();
    } else {
      fastBlockAlreadyBlocked();
      processVideos();
    }
  } else if (message.action === "countsCleared") {
    countsCache = null;
    resetProcessedCards();
    getCountsCache().then(() => {
      processVideos();
    });
  } else if (message.action === "countsUpdated") {
    countsCache = null;
    resetProcessedCards();
    getCountsCache().then(() => {
      if (decayCountsCache()) {
        scheduleCountsSave();
      }
      processVideos();
    });
  } else if (message.action === "allowlistUpdated") {
    ALLOWLISTED_VIDEOS = message.videos || [];
    ALLOWLISTED_CHANNELS = message.channels || [];
    processVideos();
  }
});
