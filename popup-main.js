async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && !String(tab.url || "").startsWith("chrome-extension://")) {
    return tab;
  }

  const focusedTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const focusedActive = focusedTabs.find((candidate) => candidate.active && !String(candidate.url || "").startsWith("chrome-extension://"));
  if (focusedActive) {
    return focusedActive;
  }

  const allActiveTabs = await chrome.tabs.query({ active: true });
  return allActiveTabs.find((candidate) => !String(candidate.url || "").startsWith("chrome-extension://")) || null;
}

async function send(msg) {
  return await chrome.runtime.sendMessage(msg);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REFRESH_INTERVAL_MS = 750;

let refreshInFlight = null;
let autoRefreshId = null;
let showSetupCard = false;
let latestState = null;
let latestDetector = null;
let latestSnapshot = null;
let latestActiveTab = null;
let latestSpotifyReadiness = null;
let lastUnavailableReason = "";
let usingFallbackState = false;
let liveDetailsPending = false;

function shortTab(tabId) {
  if (!tabId) return "—";
  return String(tabId);
}

function truncate(text, max = 36) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeTab(tab) {
  if (!tab) return "Not set";
  return truncate(tab.title || tab.url || `Tab ${shortTab(tab.id)}`, 36);
}

function setMessage(text, isError = false) {
  const el = document.getElementById("message");
  el.textContent = text || "";
  el.style.color = isError ? "#a63b30" : "#1b7f55";
}

function setDetectorState(text, meta = "") {
  const titleEl = document.getElementById("detectorState");
  const metaEl = document.getElementById("detectorMeta");
  if (titleEl) titleEl.textContent = text;
  if (metaEl) metaEl.textContent = meta;
}

function setSpotifyPrimeText(text) {
  const primeTip = document.getElementById("spotifyPrimeTip");
  const summaryTip = document.getElementById("spotifySummaryTip");
  if (primeTip) primeTip.textContent = text;
  if (summaryTip) summaryTip.textContent = text;
}

function renderLoading() {
  const statusPill = document.getElementById("statusPill");
  statusPill.textContent = "OFF";
  statusPill.className = "status-pill";
  document.getElementById("statusLine").textContent = "Loading CommercialSlayer state...";
  document.getElementById("setupCard").hidden = true;
  document.getElementById("tabsSummary").hidden = true;
  document.getElementById("mainToggle").textContent = "Loading...";
  document.getElementById("mainToggle").disabled = true;
  document.getElementById("mainToggle").className = "primary-button off";
  document.getElementById("statusBig").textContent = "LOADING";
  document.getElementById("statusSub").textContent = "Reading saved tabs and status";
  document.getElementById("statusMeta").textContent = "Detector: Loading...";
  setDetectorState("Detector: Loading...", "Waiting for saved state and live detector details.");
}

function isPeacockUrl(url = "") {
  return /^https:\/\/www\.peacocktv\.com\//.test(url);
}

function isSpotifyUrl(url = "") {
  return /^https:\/\/open\.spotify\.com\//.test(url);
}

async function persistTabSelection(kind, tab) {
  if (!tab?.id) {
    return { ok: false, error: "Tab no longer exists." };
  }

  const url = tab.url || "";
  if (kind === "peacock" && !isPeacockUrl(url)) {
    return { ok: false, error: "Selected tab is not a Peacock tab." };
  }

  if (kind === "spotify" && !isSpotifyUrl(url)) {
    return { ok: false, error: "Selected tab is not a Spotify tab." };
  }

  const key = kind === "peacock" ? "peacockTabId" : "spotifyTabId";
  const snapshotKey = kind === "peacock" ? "peacockTabSnapshot" : "spotifyTabSnapshot";
  await chrome.storage.local.set({
    [key]: tab.id,
    [snapshotKey]: {
      id: tab.id,
      title: tab.title || tab.url || `Tab ${shortTab(tab.id)}`,
      url: tab.url || "",
      muted: tab.mutedInfo?.muted ?? false
    }
  });
  return { ok: true };
}

function renderUnavailable(reason) {
  lastUnavailableReason = reason || "Could not reach the background worker. Click Refresh or reopen the popup.";
  const statusPill = document.getElementById("statusPill");
  statusPill.textContent = "OFF";
  statusPill.className = "status-pill";
  document.getElementById("statusLine").textContent = "Can't reach background service. Try again.";
  document.getElementById("setupCard").hidden = false;
  document.getElementById("tabsSummary").hidden = true;
  document.getElementById("peacockTab").textContent = "UNAVAILABLE";
  document.getElementById("spotifyTab").textContent = "UNAVAILABLE";
  document.getElementById("peacockChecklist").textContent = "☐ Peacock selected";
  document.getElementById("spotifyChecklist").textContent = "☐ Spotify selected";
  document.getElementById("mainToggle").textContent = "Turn On";
  document.getElementById("mainToggle").disabled = true;
  document.getElementById("mainToggle").className = "primary-button off";
  document.getElementById("statusBig").textContent = "WAITING";
  document.getElementById("statusSub").textContent = "Waiting for setup";
  document.getElementById("statusMeta").textContent = "Detector: Unavailable";
  setDetectorState("Detector: Unavailable", "Background worker could not be reached.");
  document.getElementById("debugOutput").textContent = lastUnavailableReason;
  setMessage(lastUnavailableReason, true);
}

async function buildStoredTabSummary(tabId, matcher) {
  if (!tabId) return null;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !matcher(tab.url || "")) {
      return null;
    }

    return {
      id: tab.id,
      title: tab.title || tab.url || `Tab ${shortTab(tab.id)}`,
      url: tab.url || "",
      muted: tab.mutedInfo?.muted ?? false
    };
  } catch (error) {
    return null;
  }
}

function buildStoredSnapshotFallback(kind, tabId, snapshot) {
  if (!tabId) return null;

  if (snapshot?.id === tabId) {
    return {
      id: snapshot.id,
      title: snapshot.title || snapshot.url || `Saved ${kind} tab`,
      url: snapshot.url || "",
      muted: snapshot.muted ?? false
    };
  }

  return {
    id: tabId,
    title: `Saved ${kind} tab`,
    url: "",
    muted: false
  };
}

async function getStoredStateFallback() {
  const stored = await chrome.storage.local.get({
    peacockTabId: null,
    peacockTabSnapshot: null,
    spotifyTabId: null,
    spotifyTabSnapshot: null,
    enabled: false,
    lastMode: "UNKNOWN"
  });

  return {
    peacockTabId: stored.peacockTabId ?? null,
    peacockTab: buildStoredSnapshotFallback("Peacock", stored.peacockTabId, stored.peacockTabSnapshot),
    spotifyTabId: stored.spotifyTabId ?? null,
    spotifyTab: buildStoredSnapshotFallback("Spotify", stored.spotifyTabId, stored.spotifyTabSnapshot),
    enabled: Boolean(stored.enabled && stored.peacockTabId && stored.spotifyTabId),
    lastMode: stored.lastMode || "UNKNOWN",
    peacockTabSnapshot: stored.peacockTabSnapshot || null,
    spotifyTabSnapshot: stored.spotifyTabSnapshot || null
  };
}

async function readSpotifyReadiness(spotifyTabId) {
  if (!spotifyTabId) {
    return { ok: false, reason: "Spotify tab is not set." };
  }

  try {
    const response = await chrome.tabs.sendMessage(spotifyTabId, {
      type: "GET_SPOTIFY_READINESS"
    });

    if (!response?.ok) {
      return {
        ok: false,
        reason: response?.reason || "Spotify readiness is unavailable."
      };
    }

    return response;
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "Spotify readiness is unavailable."
    };
  }
}

async function bootstrapFromStorage() {
  try {
    const state = await getStoredStateFallback();

    const hasUsableState = Boolean(
      state.peacockTab ||
      state.spotifyTab ||
      state.enabled ||
      state.lastMode !== "UNKNOWN"
    );

    if (hasUsableState) {
      latestState = state;
      usingFallbackState = true;
      lastUnavailableReason = "";
      render();
    }

    getActiveTab()
      .then((activeTab) => {
        latestActiveTab = activeTab;
        if (latestState) {
          render();
        }
      })
      .catch(() => {});

    Promise.all([
      buildStoredTabSummary(state.peacockTabId, isPeacockUrl),
      buildStoredTabSummary(state.spotifyTabId, isSpotifyUrl)
    ])
      .then(([peacockTab, spotifyTab]) => {
        if (peacockTab || spotifyTab) {
          latestState = {
            ...(latestState || {}),
            peacockTab: peacockTab || latestState?.peacockTab || null,
            spotifyTab: spotifyTab || latestState?.spotifyTab || null
          };
          render();
        }
      })
      .catch(() => {});
  } catch (error) {
    // Initial render can continue with the static HTML defaults.
  }
}

async function getStateWithRetry() {
  const delays = [80, 160, 240];
  let lastError = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await send({ type: "GET_STATE" });
      if (!response?.ok) {
        throw new Error(response?.error || "GET_STATE failed.");
      }
      usingFallbackState = false;
      return response.state;
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) {
        await wait(delays[attempt]);
      }
    }
  }

  const fallbackState = await getStoredStateFallback();
  const hasUsableState = Boolean(
    fallbackState.peacockTab ||
    fallbackState.spotifyTab ||
    fallbackState.enabled ||
    fallbackState.lastMode !== "UNKNOWN"
  );

  if (hasUsableState) {
    usingFallbackState = true;
    return fallbackState;
  }

  throw lastError || new Error("Could not reach background worker.");
}

function deriveDetectionSource(detector) {
  if (!detector?.ok || !detector.detector) {
    return "Unavailable";
  }

  const matchedSelectors = detector.detector.matchedSelectors || [];
  const matchedText = detector.detector.matchedText || [];
  const resourceHints = detector.detector.resourceHints || [];

  if (matchedSelectors.some((value) => /countdown/i.test(value))) {
    return "Ad countdown";
  }
  if (matchedText.some((value) => value !== "show-playback-signal")) {
    return "Text marker";
  }
  if (resourceHints.length) {
    return "Network signal";
  }
  return "Unknown";
}

async function readDetector(peacockTabId) {
  if (!peacockTabId) {
    const unavailable = {
      ok: false,
      reason: "Set a Peacock tab to inspect detector output."
    };
    setDetectorState("Detector: Unavailable", unavailable.reason);
    return unavailable;
  }

  try {
    const response = await chrome.tabs.sendMessage(peacockTabId, { type: "GET_DETECTOR_STATE" });
    if (!response?.ok || !response?.detector) {
      const unavailable = {
        ok: false,
        reason: "Peacock content script did not respond."
      };
      setDetectorState("Detector: Unavailable", unavailable.reason);
      return unavailable;
    }

    const source = deriveDetectionSource({ ok: true, detector: response.detector });
    setDetectorState(`Detector: ${source}`, "Raw detector details are available in Advanced.");
    return { ok: true, detector: response.detector };
  } catch (error) {
    const unavailable = {
      ok: false,
      reason: "Open Peacock playback to inspect detector details."
    };
    setDetectorState("Detector: Unavailable", unavailable.reason);
    return unavailable;
  }
}

async function captureSnapshot() {
  try {
    const state = await getStateWithRetry();
    if (!state?.peacockTabId) {
      setMessage("No Peacock tab is set.", true);
      return;
    }

    const capture = await chrome.tabs.sendMessage(state.peacockTabId, {
      type: "CAPTURE_DEBUG_SNAPSHOT"
    });

    if (!capture?.snapshot) {
      setMessage("Could not capture Peacock snapshot.", true);
      return;
    }

    latestSnapshot = capture.snapshot;
    render();
    setMessage("Debug snapshot captured.");
  } catch (error) {
    setMessage("Peacock snapshot failed. Open Peacock playback and try again.", true);
  }
}

function buildStatusText(view) {
  if (view.unavailable) {
    return "Can't reach background service. Try again.";
  }
  if (!view.running && !view.setupComplete) {
    return "Set Peacock + Spotify, then turn it on.";
  }
  if (!view.running && view.setupComplete && view.spotifyNeedsPrime) {
    return "Ready. Spotify may need one manual click before the first break.";
  }
  if (!view.running && view.setupComplete) {
    return "Ready. Turn it on when you start watching Peacock.";
  }
  if (view.running && view.mode === "AD") {
    return "Running — ad detected. Spotify taking over.";
  }
  if (view.running && view.mode === "SHOW") {
    return "Running — Peacock audio on.";
  }
  if (view.stale) {
    return "Using saved state while background wakes up.";
  }
  return "Running — waiting for Peacock playback.";
}

function buildSpotifyPrimeText(view) {
  if (!latestState?.spotifyTab) {
    return "Tip: Select your Spotify Web Player tab.";
  }

  if (view.spotifyNeedsPrime) {
    return "Spotify has not been interacted with in this tab yet. If Chrome blocks autoplay, click once in Spotify before the first break.";
  }

  if (latestSpotifyReadiness?.ok && (latestSpotifyReadiness.hasUserActivation || latestSpotifyReadiness.isPlaying === true)) {
    return "Spotify is ready for automatic resume during breaks.";
  }

  return "Tip: Start Spotify playback once so Chrome can resume it during breaks.";
}

function buildStatusCard(view) {
  if (!view.setupComplete) {
    return {
      label: "WAITING",
      subtext: "Waiting for setup",
      meta: "Detector: Unavailable"
    };
  }

  if (!view.running) {
    return {
      label: "WAITING",
      subtext: "Open Peacock playback to begin detection",
      meta: `Detected via: ${view.detectionSource}`
    };
  }

  if (view.mode === "AD") {
    return {
      label: "AD",
      subtext: "Peacock muted • Spotify playing",
      meta: `Detected via: ${view.detectionSource}`
    };
  }

  if (view.mode === "SHOW") {
    return {
      label: "SHOW",
      subtext: "Peacock audio on • Spotify muted",
      meta: `Detected via: ${view.detectionSource}`
    };
  }

  return {
    label: "WAITING",
    subtext: "Open Peacock playback to begin detection",
    meta: `Detected via: ${view.detectionSource}`
  };
}

function buildDebugInfo(view) {
  return {
    state: latestState,
    running: view.running,
    setupComplete: view.setupComplete,
    mode: view.mode,
    detectionSource: view.detectionSource,
    activeTab: latestActiveTab
      ? {
          id: latestActiveTab.id,
          title: latestActiveTab.title || "",
          url: latestActiveTab.url || ""
        }
      : null,
    detector: latestDetector?.detector || latestDetector || null,
    snapshotSummary: latestSnapshot
      ? {
          capturedAt: latestSnapshot.capturedAt || null,
          sampleText: latestSnapshot.sampleText || "",
          matchedSelectors: latestSnapshot.matchedSelectors || [],
          textMatches: latestSnapshot.textMatches || [],
          resourceHints: latestSnapshot.resourceHints || []
        }
      : null,
    spotifyReadiness: latestSpotifyReadiness
  };
}

function render() {
  if (!latestState && lastUnavailableReason) {
    renderUnavailable(lastUnavailableReason);
    return;
  }

  const setupComplete = Boolean(latestState?.peacockTab && latestState?.spotifyTab);
  const running = Boolean(latestState?.enabled);
  const mode = latestState?.lastMode || "UNKNOWN";
  const detectionSource = deriveDetectionSource(latestDetector);
  const spotifyNeedsPrime = Boolean(latestSpotifyReadiness?.ok && latestSpotifyReadiness.needsManualPrime);
  const unavailable = Boolean(lastUnavailableReason && !latestState);
  const stale = usingFallbackState;
  const view = { setupComplete, running, mode, detectionSource, unavailable, stale, spotifyNeedsPrime };

  const statusPill = document.getElementById("statusPill");
  statusPill.textContent = running ? "ON" : "OFF";
  statusPill.className = running ? "status-pill on" : "status-pill";
  document.getElementById("statusLine").textContent = buildStatusText(view);

  const activeIsPeacock = isPeacockUrl(latestActiveTab?.url || "");
  const activeIsSpotify = isSpotifyUrl(latestActiveTab?.url || "");
  document.getElementById("setPeacock").textContent = activeIsPeacock ? "Use this tab" : "Choose";
  document.getElementById("setSpotify").textContent = activeIsSpotify ? "Use this tab" : "Choose";

  const shouldShowSetup = !setupComplete || showSetupCard;
  document.getElementById("setupCard").hidden = !shouldShowSetup;
  document.getElementById("tabsSummary").hidden = shouldShowSetup || !setupComplete;

  document.getElementById("peacockTab").textContent = describeTab(latestState?.peacockTab);
  document.getElementById("spotifyTab").textContent = describeTab(latestState?.spotifyTab);
  document.getElementById("peacockSummary").textContent = describeTab(latestState?.peacockTab);
  document.getElementById("spotifySummary").textContent = describeTab(latestState?.spotifyTab);
  document.getElementById("peacockChecklist").textContent =
    `${latestState?.peacockTab ? "✅" : "☐"} Peacock selected`;
  document.getElementById("spotifyChecklist").textContent =
    `${latestState?.spotifyTab ? "✅" : "☐"} Spotify selected`;
  setSpotifyPrimeText(buildSpotifyPrimeText(view));

  const mainToggle = document.getElementById("mainToggle");
  mainToggle.textContent = running ? "Turn Off" : "Turn On";
  mainToggle.className = running ? "primary-button on" : "primary-button off";
  mainToggle.disabled = !setupComplete;

  const statusCard = buildStatusCard(view);
  document.getElementById("statusBig").textContent = statusCard.label;
  document.getElementById("statusSub").textContent = statusCard.subtext;
  document.getElementById("statusMeta").textContent = liveDetailsPending
    ? "Detector: Loading..."
    : latestDetector?.ok
    ? statusCard.meta
    : stale
      ? "Detector: Unavailable while background wakes up"
      : "Detector: Unavailable";

  document.getElementById("stopSlayer").disabled = !running;

  const debugInfo = buildDebugInfo(view);
  document.getElementById("debugOutput").textContent = JSON.stringify(debugInfo, null, 2);
}

async function refresh() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      liveDetailsPending = true;
      const state = await getStateWithRetry();
      latestState = state;
      lastUnavailableReason = "";
      render();

      const [activeTab, detector, spotifyReadiness] = await Promise.all([
        getActiveTab().catch(() => null),
        readDetector(state?.peacockTabId),
        readSpotifyReadiness(state?.spotifyTabId)
      ]);
      latestActiveTab = activeTab;
      latestDetector = detector;
      latestSpotifyReadiness = spotifyReadiness;
      lastUnavailableReason = "";
      liveDetailsPending = false;
      render();
    } catch (error) {
      liveDetailsPending = false;
      if (latestState) {
        usingFallbackState = true;
        lastUnavailableReason = error?.message || "Could not reach background service. Try again.";
        latestDetector = latestDetector?.ok ? latestDetector : null;
        latestSpotifyReadiness = latestSpotifyReadiness?.ok ? latestSpotifyReadiness : null;
        render();
        setMessage("Using saved state while background wakes up.", true);
      } else {
        latestState = null;
        latestDetector = null;
        latestSpotifyReadiness = null;
        renderUnavailable("Could not reach background service. Try again.");
      }
    } finally {
      liveDetailsPending = false;
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function selectTab(type) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setMessage("Could not find the active browser tab. Click the Peacock or Spotify tab, then reopen the popup.", true);
    return;
  }

  const messageType = type === "peacock" ? "SET_PEACOCK_TAB" : "SET_SPOTIFY_TAB";
  let result;

  try {
    result = await send({ type: messageType, tabId: tab.id });
  } catch (error) {
    result = await persistTabSelection(type, tab);
  }

  if (!result?.ok) {
    const fallbackResult = await persistTabSelection(type, tab);
    if (!fallbackResult?.ok) {
      setMessage(fallbackResult?.error || result?.error || "Unable to save tab.", true);
      return;
    }
    result = fallbackResult;
  }

  if (type === "spotify") {
    const readiness = await readSpotifyReadiness(tab.id);
    latestSpotifyReadiness = readiness;
    setMessage(
      readiness.ok && readiness.needsManualPrime
        ? "Spotify tab selected. If Chrome blocks autoplay, click once in Spotify before the first break."
        : "Spotify tab selected."
    );
  } else {
    setMessage("Peacock tab selected.");
  }
  await refresh();

  if (latestState?.peacockTab && latestState?.spotifyTab) {
    showSetupCard = false;
    render();
  }
}

async function startSlayer() {
  const result = await send({ type: "START_SLAYER" });
  if (!result?.ok) {
    setMessage(result?.error || "Unable to start CommercialSlayer.", true);
    await refresh();
    return;
  }

  await refresh();

  const spotifyResult = result?.applyResult?.spotifyResult;
  if (spotifyResult?.reasonCode === "MANUAL_PRIME_REQUIRED" || latestSpotifyReadiness?.needsManualPrime) {
    setMessage(
      "CommercialSlayer is on. Spotify needs one manual click or Play in its tab before Chrome can take over.",
      true
    );
    return;
  }

  if (spotifyResult && !spotifyResult.ok) {
    setMessage(
      `CommercialSlayer started, but Spotify ${result.startedMode === "AD" ? "play" : "pause"} failed: ${spotifyResult.reason || "unknown error"}`,
      true
    );
    return;
  }

  setMessage(`CommercialSlayer started in ${result.startedMode || "UNKNOWN"} mode.`);
}

async function stopSlayer() {
  const result = await send({ type: "STOP_SLAYER" });
  if (!result?.ok) {
    setMessage("Unable to turn off CommercialSlayer.", true);
    return;
  }

  setMessage("CommercialSlayer turned off.");
  await refresh();
}

async function toggleRunning() {
  if (latestState?.enabled) {
    await stopSlayer();
  } else {
    await startSlayer();
  }
}

async function forceMode(mode) {
  const result = await send({ type: "RUN_TEST_MODE", mode });
  if (!result?.ok) {
    setMessage("Unable to force test mode.", true);
    return;
  }

  const spotifyResult = result.spotifyResult;
  if (spotifyResult?.reasonCode === "MANUAL_PRIME_REQUIRED") {
    setMessage(
      "Forced AD, but Spotify needs one manual click or Play in its tab before Chrome can resume it.",
      true
    );
  } else if (spotifyResult && !spotifyResult.ok) {
    setMessage(
      `Forced ${mode}, but Spotify ${mode === "AD" ? "play" : "pause"} failed: ${spotifyResult.reason || "unknown error"}`,
      true
    );
  } else if (spotifyResult) {
    setMessage(`Forced ${mode}. Spotify ${mode === "AD" ? "play" : "pause"} confirmed.`);
  } else {
    setMessage(`Forced ${mode}.`);
  }

  await refresh();
}

async function copyDebugInfo() {
  try {
    const setupComplete = Boolean(latestState?.peacockTab && latestState?.spotifyTab);
    const running = Boolean(latestState?.enabled);
    const debugPayload = buildDebugInfo({
      setupComplete,
      running,
      mode: latestState?.lastMode || "UNKNOWN",
      detectionSource: deriveDetectionSource(latestDetector)
    });
    await navigator.clipboard.writeText(JSON.stringify(debugPayload, null, 2));
    setMessage("Debug info copied.");
  } catch (error) {
    setMessage("Could not copy debug info.", true);
  }
}

document.getElementById("setPeacock").addEventListener("click", async () => {
  await selectTab("peacock");
});

document.getElementById("setSpotify").addEventListener("click", async () => {
  await selectTab("spotify");
});

document.getElementById("changeTabs").addEventListener("click", () => {
  showSetupCard = true;
  render();
});

document.getElementById("mainToggle").addEventListener("click", async () => {
  await toggleRunning();
});

document.getElementById("refresh").addEventListener("click", async () => {
  await refresh();
  setMessage("Status refreshed.");
});

document.getElementById("copyDebug").addEventListener("click", async () => {
  await copyDebugInfo();
});

document.getElementById("testAd").addEventListener("click", async () => {
  await forceMode("AD");
});

document.getElementById("testShow").addEventListener("click", async () => {
  await forceMode("SHOW");
});

document.getElementById("captureSnapshot").addEventListener("click", async () => {
  await captureSnapshot();
});

document.getElementById("stopSlayer").addEventListener("click", async () => {
  await stopSlayer();
});

window.addEventListener("focus", async () => {
  await refresh();
});

window.addEventListener("unhandledrejection", (event) => {
  const message = event?.reason?.message || event?.reason || "Unexpected popup error.";
  setMessage(String(message), true);
});

autoRefreshId = window.setInterval(() => {
  refresh();
}, REFRESH_INTERVAL_MS);

window.addEventListener("beforeunload", () => {
  if (autoRefreshId) {
    window.clearInterval(autoRefreshId);
  }
});

(async () => {
  renderLoading();
  await bootstrapFromStorage();
  await refresh();
})();
