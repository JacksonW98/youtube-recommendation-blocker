const backBtn = document.getElementById("backBtn");
const clearVideosBtn = document.getElementById("clearVideosBtn");
const clearChannelsBtn = document.getElementById("clearChannelsBtn");
const videoList = document.getElementById("videoList");
const channelList = document.getElementById("channelList");

let allowlistedVideos = [];
let allowlistedChannels = [];

function normalizeItem(item, fallbackName) {
  if (typeof item === "string") {
    return { id: item, name: fallbackName || item };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const id = item.id || "";

  if (!id) {
    return null;
  }

  return {
    id,
    name: item.name || fallbackName || id
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadAllowlists() {
  chrome.runtime.sendMessage({ action: "getAllowlists" }, (response) => {
    allowlistedVideos = (response?.videos || [])
      .map((item) => normalizeItem(item, "Video"))
      .filter(Boolean);
    allowlistedChannels = (response?.channels || [])
      .map((item) => normalizeItem(item, "Channel"))
      .filter(Boolean);

    renderVideos();
    renderChannels();
  });
}

function renderVideos() {
  clearVideosBtn.disabled = allowlistedVideos.length === 0;

  if (allowlistedVideos.length === 0) {
    videoList.innerHTML = `<div class="empty-state">No allowlisted videos</div>`;
    return;
  }

  videoList.innerHTML = allowlistedVideos
    .map(
      (video) =>
        `
      <div class="item">
        <div class="item-text">
          <div class="item-name">${escapeHtml(video.name)}</div>
          <div class="item-id">${escapeHtml(video.id)}</div>
        </div>
        <button class="item-remove" data-type="video" data-id="${escapeHtml(video.id)}">Remove</button>
      </div>
    `
    )
    .join("");

  bindRemoveButtons(videoList);
}

function renderChannels() {
  clearChannelsBtn.disabled = allowlistedChannels.length === 0;

  if (allowlistedChannels.length === 0) {
    channelList.innerHTML = `<div class="empty-state">No allowlisted channels</div>`;
    return;
  }

  channelList.innerHTML = allowlistedChannels
    .map(
      (channel) =>
        `
      <div class="item">
        <div class="item-text">
          <div class="item-name">${escapeHtml(channel.name)}</div>
          <div class="item-id">${escapeHtml(channel.id)}</div>
        </div>
        <button class="item-remove" data-type="channel" data-id="${escapeHtml(channel.id)}">Remove</button>
      </div>
    `
    )
    .join("");

  bindRemoveButtons(channelList);
}

function bindRemoveButtons(list) {
  list.querySelectorAll(".item-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const type = e.target.dataset.type;
      const id = e.target.dataset.id;

      chrome.runtime.sendMessage({ action: "removeAllowlist", type, id }, () => {
        loadAllowlists();
      });
    });
  });
}

function clearAllowlist(type, confirmMessage) {
  if (!window.confirm(confirmMessage)) {
    return;
  }

  chrome.runtime.sendMessage({ action: "clearAllowlist", type }, () => {
    loadAllowlists();
  });
}

backBtn.addEventListener("click", () => {
  window.close();
});

clearChannelsBtn.addEventListener("click", () => {
  clearAllowlist("channel", "Remove every allowlisted channel? They can be hidden again once they pass the threshold.");
});

clearVideosBtn.addEventListener("click", () => {
  clearAllowlist("video", "Remove every allowlisted video? They can be hidden again once they pass the threshold.");
});

loadAllowlists();
