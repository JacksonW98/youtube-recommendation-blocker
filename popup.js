const thresholdSlider = document.getElementById("thresholdSlider");
const thresholdValue = document.getElementById("thresholdValue");
const thresholdDisplay = document.getElementById("thresholdDisplay");
const thresholdUnit = document.getElementById("thresholdUnit");
const decayDaysSlider = document.getElementById("decayDaysSlider");
const decayDaysValue = document.getElementById("decayDaysValue");
const decayDaysDisplay = document.getElementById("decayDaysDisplay");
const pauseTrackingToggle = document.getElementById("pauseTrackingToggle");
const pauseBlockingToggle = document.getElementById("pauseBlockingToggle");
const viewAllowlistBtn = document.getElementById("viewAllowlistBtn");
const exportDataBtn = document.getElementById("exportDataBtn");
const importDataBtn = document.getElementById("importDataBtn");
const dataImportInput = document.getElementById("dataImportInput");
const dataStatus = document.getElementById("dataStatus");
const clearBtn = document.getElementById("clearBtn");
const clearStatus = document.getElementById("clearStatus");

function updatePauseUI(states) {
  if (!states) return;
  if (pauseTrackingToggle) pauseTrackingToggle.checked = !!states.pauseTracking;
  if (pauseBlockingToggle) pauseBlockingToggle.checked = !!states.pauseBlocking;
}

function updateDecayUI(value) {
  const days = Number.isFinite(value) ? value : 0;
  const label = days === 0 ? "Disabled" : String(days);
  const status = days === 0
    ? "View counts never decay."
    : `Remove one from a video's view count after ${days} ${days === 1 ? "day" : "days"}.`;

  if (decayDaysSlider) decayDaysSlider.value = String(days);
  if (decayDaysValue) decayDaysValue.textContent = label;
  if (decayDaysDisplay) decayDaysDisplay.textContent = status;
}

function setDataStatus(message, isError = false) {
  if (!dataStatus) return;
  dataStatus.textContent = message;
  dataStatus.style.background = isError ? "#fee2e2" : "#f0fdf4";
  dataStatus.style.color = isError ? "#991b1b" : "#166534";
}

function clearDataStatus() {
  if (!dataStatus) return;
  dataStatus.textContent = "";
  dataStatus.style.background = "";
  dataStatus.style.color = "";
}

function sendMessagePromise(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function getLocalStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
  const storageResult = await getLocalStorage([
    "videoCounts",
    "threshold",
    "decayDays",
    "pauseTracking",
    "pauseBlocking",
    "allowlistedVideos",
    "allowlistedChannels"
  ]);
  const backup = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    data: {
      videoCounts: storageResult.videoCounts || {},
      threshold: storageResult.threshold || 5,
      decayDays: storageResult.decayDays ?? 0,
      pauseTracking: !!storageResult.pauseTracking,
      pauseBlocking: !!storageResult.pauseBlocking,
      allowlistedVideos: storageResult.allowlistedVideos || [],
      allowlistedChannels: storageResult.allowlistedChannels || []
    }
  };

  const filename = `youtube-recommendation-blocker-backup-${new Date().toISOString().replaceAll(":", "-")}.json`;
  downloadJson(filename, backup);
  setDataStatus("Backup downloaded.");
}

async function importDataFromFile(file) {
  const text = await file.text();
  const backup = JSON.parse(text);
  const response = await sendMessagePromise({ action: "importData", backup });

  if (!response?.success) {
    throw new Error(response?.error || "Import failed.");
  }

  setDataStatus("Data imported.");
}

chrome.runtime.sendMessage({ action: "getThreshold" }, (response) => {
  const threshold = response.threshold || 5;
  thresholdSlider.value = threshold;
  thresholdValue.textContent = threshold;
  thresholdDisplay.textContent = threshold;
  if (thresholdUnit) thresholdUnit.textContent = threshold === 1 ? "time" : "times";
});

chrome.runtime.sendMessage({ action: "getDecayDays" }, (response) => {
  updateDecayUI(Number.isFinite(response?.decayDays) ? response.decayDays : 0);
});

chrome.runtime.sendMessage({ action: "getPauseStates" }, (states) => {
  updatePauseUI(states);
});

thresholdSlider.addEventListener("input", (e) => {
  const value = parseInt(e.target.value);
  thresholdValue.textContent = value;
  thresholdDisplay.textContent = value;
  if (thresholdUnit) thresholdUnit.textContent = value === 1 ? "time" : "times";

  chrome.runtime.sendMessage(
    { action: "setThreshold", threshold: value },
    () => {
      console.log("Threshold updated to", value);
    }
  );
});

if (decayDaysSlider) {
  decayDaysSlider.addEventListener("input", (e) => {
    const value = parseInt(e.target.value, 10);
    updateDecayUI(value);

    chrome.runtime.sendMessage(
      { action: "setDecayDays", decayDays: value },
      () => {
        console.log("Decay days updated to", value);
      }
    );
  });
}

clearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clearCounts" }, () => {
    clearStatus.textContent = "✓ Video counts cleared";
    clearStatus.style.background = "#dcfce7";
    clearStatus.style.color = "#166534";

    setTimeout(() => {
      clearStatus.textContent = "";
      clearStatus.style.background = "";
      clearStatus.style.color = "";
    }, 2000);
  });
});

function setPauseStates(states, cb) {
  chrome.runtime.sendMessage({ action: "setPauseStates", states }, () => {
    if (typeof cb === "function") cb();
    chrome.runtime.sendMessage({ action: "getPauseStates" }, (newStates) => {
      updatePauseUI(newStates);
    });
  });
}

if (pauseTrackingToggle) {
  pauseTrackingToggle.addEventListener("change", (e) => {
    setPauseStates({ pauseTracking: !!e.target.checked, pauseBlocking: !!(pauseBlockingToggle && pauseBlockingToggle.checked) });
  });
}

if (pauseBlockingToggle) {
  pauseBlockingToggle.addEventListener("change", (e) => {
    setPauseStates({ pauseTracking: !!(pauseTrackingToggle && pauseTrackingToggle.checked), pauseBlocking: !!e.target.checked });
  });
}

if (viewAllowlistBtn) {
  viewAllowlistBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL("allowlist-manager.html");
    chrome.windows.create({ url, width: 700, height: 800, type: "popup" });
  });
}

if (exportDataBtn) {
  exportDataBtn.addEventListener("click", () => {
    clearDataStatus();
    exportData().catch((error) => {
      setDataStatus(error.message || "Export failed.", true);
    });
  });
}

if (importDataBtn && dataImportInput) {
  importDataBtn.addEventListener("click", () => {
    clearDataStatus();
    dataImportInput.click();
  });

  dataImportInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];

    if (!file) {
      return;
    }

    try {
      await importDataFromFile(file);
    } catch (error) {
      setDataStatus(error.message || "Import failed.", true);
    } finally {
      e.target.value = "";
    }
  });
}
