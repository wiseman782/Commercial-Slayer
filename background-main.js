// background.js (MV3 service worker)

const MODE = {
  UNKNOWN: "UNKNOWN",
  SHOW: "SHOW",
  AD: "AD"
};

const DEFAULT_STATE = {
  peacockTabId: null,
  peacockTabSnapshot: null,
  spotifyTabId: null,
  spotifyTabSnapshot: null,
  enabled: false,
  lastMode: MODE.UNKNOWN
};

function isPeacockUrl(url = "") {
  return /^https:\/\/www\.peacocktv\.com\//.test(url);
}

function isSpotifyUrl(url = "") {
  return /^https:\/\/open\.spotify\.com\//.test(url);
}

async function getState() {
  const data = await chrome.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...data };
}

async function setState(patch) {
  const current = await getState();
  await chrome.storage.local.set({ ...current, ...patch });
}

function buildTabSnapshot(tab) {
  if (!tab?.id) return null;

  return {
    id: tab.id,
    title: tab.title || tab.url || "Untitled tab",
    url: tab.url || "",
    muted: tab.mutedInfo?.muted ?? false
  };
}

function snapshotChanged(previous, next) {
  if (!previous && !next) return false;
  if (!previous || !next) return true;

  return (
    previous.id !== next.id ||
    previous.title !== next.title ||
    previous.url !== next.url ||
    previous.muted !== next.muted
  );
}

function setBadge(text) {
  chrome.action.setBadgeText({ text: text || "" });
}

function setBadgeTheme(mode) {
  const color =
    mode === MODE.AD ? "#b42318" :
    mode === MODE.SHOW ? "#18794e" :
    "#6b7280";

  chrome.action.setBadgeBackgroundColor({ color });
}

async function getTabIfUsable(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab || null;
  } catch (e) {
    return null;
  }
}

async function safeUpdateMute(tabId, muted) {
  const tab = await getTabIfUsable(tabId);
  if (!tab) return false;

  try {
    if (tab.mutedInfo?.muted === muted) return true;
    await chrome.tabs.update(tabId, { muted });
    return true;
  } catch (e) {
    return false;
  }
}

async function buildTabSummary(tabId, matcher) {
  const tab = await getTabIfUsable(tabId);
  if (!tab) return null;
  if (!matcher(tab.url || "")) return null;

  return {
    id: tab.id,
    title: tab.title || tab.url || "Untitled tab",
    url: tab.url || "",
    muted: tab.mutedInfo?.muted ?? false
  };
}

async function cleanupState() {
  const state = await getState();
  const peacockTab = await buildTabSummary(state.peacockTabId, isPeacockUrl);
  const spotifyTab = await buildTabSummary(state.spotifyTabId, isSpotifyUrl);
  const patch = {};

  if (!peacockTab && state.peacockTabId !== null) {
    patch.peacockTabId = null;
    patch.peacockTabSnapshot = null;
    patch.enabled = false;
  }
  if (peacockTab && snapshotChanged(state.peacockTabSnapshot, peacockTab)) {
    patch.peacockTabSnapshot = peacockTab;
  }

  if (!spotifyTab && state.spotifyTabId !== null) {
    patch.spotifyTabId = null;
    patch.spotifyTabSnapshot = null;
    patch.enabled = false;
  }
  if (spotifyTab && snapshotChanged(state.spotifyTabSnapshot, spotifyTab)) {
    patch.spotifyTabSnapshot = spotifyTab;
  }

  if (Object.keys(patch).length) {
    await setState(patch);
  }

  return {
    ...(await getState()),
    peacockTab,
    spotifyTab
  };
}

async function saveTabSelection(kind, tabId) {
  const tab = await getTabIfUsable(tabId);
  if (!tab) {
    return { ok: false, error: "Tab no longer exists." };
  }

  const url = tab.url || "";
  if (kind === "peacock" && !isPeacockUrl(url)) {
    return { ok: false, error: "Selected tab is not a Peacock tab." };
  }
  if (kind === "spotify" && !isSpotifyUrl(url)) {
    return { ok: false, error: "Selected tab is not a Spotify tab." };
  }

  await setState(
    kind === "peacock"
      ? { peacockTabId: tabId, peacockTabSnapshot: buildTabSnapshot(tab) }
      : { spotifyTabId: tabId, spotifyTabSnapshot: buildTabSnapshot(tab) }
  );

  return { ok: true };
}

async function getPeacockDetectorState(tabId) {
  if (!tabId) {
    return { ok: false, error: "Peacock tab is not set." };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_DETECTOR_STATE"
    });

    if (!response?.ok || !response?.detector) {
      return { ok: false, error: "Peacock detector did not respond." };
    }

    return { ok: true, detector: response.detector };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Peacock detector is unavailable."
    };
  }
}

async function controlSpotifyPlayback(tabId, action) {
  if (!tabId) {
    return { ok: false, reason: "Spotify tab is not set." };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "SPOTIFY_PLAYBACK",
      action
    });

    return response || { ok: false, reason: "Spotify did not return a response." };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "Spotify content script is unavailable."
    };
  }
}

async function getSpotifyPlaybackState(tabId) {
  if (!tabId) {
    return { ok: false, reason: "Spotify tab is not set." };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_SPOTIFY_PLAYBACK_STATE"
    });

    return response || { ok: false, reason: "Spotify did not return a response." };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "Spotify content script is unavailable."
    };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSpotifyPlayback(tabId, shouldPlay) {
  const desiredAction = shouldPlay ? "PLAY" : "PAUSE";
  const desiredPlaying = shouldPlay;
  let lastState = await getSpotifyPlaybackState(tabId);

  if (lastState.ok && lastState.isPlaying === desiredPlaying) {
    return { ok: true, action: desiredAction, state: lastState, attempts: 0 };
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controlResult = await controlSpotifyPlayback(tabId, desiredAction);
    await wait(180);
    lastState = await getSpotifyPlaybackState(tabId);

    if (lastState.ok && lastState.isPlaying === desiredPlaying) {
      return {
        ok: true,
        action: desiredAction,
        state: lastState,
        attempts: attempt,
        controlResult
      };
    }
  }

  return {
    ok: false,
    action: desiredAction,
    state: lastState,
    attempts: 3,
    reason: lastState?.reason || "Spotify playback state did not reach the requested mode."
  };
}

async function applyMode(mode, sourceTabId = null, options = {}) {
  const { force = false } = options;
  const state = await cleanupState();
  const { peacockTabId, spotifyTabId, lastMode, enabled } = state;

  if (!force && mode === lastMode) return;
  if (!peacockTabId) return;
  if (!force && !enabled) {
    return { ok: false, error: "CommercialSlayer is not started." };
  }
  if (sourceTabId && peacockTabId !== sourceTabId) return;

  if (mode === MODE.AD) {
    await safeUpdateMute(peacockTabId, true);
    await safeUpdateMute(spotifyTabId, false);
    const spotifyResult = await ensureSpotifyPlayback(spotifyTabId, true);
    setBadge("AD");
    setBadgeTheme(MODE.AD);
    await setState({ lastMode: MODE.AD });
    return { ok: true, mode: MODE.AD, spotifyResult };
  } else if (mode === MODE.SHOW) {
    const spotifyResult = await ensureSpotifyPlayback(spotifyTabId, false);
    await safeUpdateMute(peacockTabId, false);
    await safeUpdateMute(spotifyTabId, true);
    setBadge("SHOW");
    setBadgeTheme(MODE.SHOW);
    await setState({ lastMode: MODE.SHOW });
    return { ok: true, mode: MODE.SHOW, spotifyResult };
  } else {
    setBadge("");
    setBadgeTheme(MODE.UNKNOWN);
    await setState({ lastMode: MODE.UNKNOWN });
    return { ok: true, mode: MODE.UNKNOWN };
  }
}

async function startCommercialSlayer() {
  const state = await cleanupState();
  if (!state.peacockTabId || !state.spotifyTabId) {
    return {
      ok: false,
      error: "Set both Peacock and Spotify tabs before starting."
    };
  }

  await setState({ enabled: true });

  const detectorState = await getPeacockDetectorState(state.peacockTabId);
  if (!detectorState.ok) {
    return {
      ok: false,
      error: detectorState.error || "Could not read Peacock detector state."
    };
  }

  const applyResult = await applyMode(
    detectorState.detector.inAd ? MODE.AD : MODE.SHOW,
    state.peacockTabId,
    { force: true }
  );

  return {
    ok: true,
    enabled: true,
    startedMode: detectorState.detector.inAd ? MODE.AD : MODE.SHOW,
    applyResult: applyResult || null
  };
}

async function stopCommercialSlayer() {
  await setState({ enabled: false });
  return { ok: true, enabled: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "SET_PEACOCK_TAB") {
      const result = await saveTabSelection("peacock", msg.tabId);
      sendResponse(result);
      return;
    }
    if (msg?.type === "SET_SPOTIFY_TAB") {
      const result = await saveTabSelection("spotify", msg.tabId);
      sendResponse(result);
      return;
    }
    if (msg?.type === "REGISTER_PEACOCK_TAB") {
      const tabId = sender.tab?.id;
      const url = sender.tab?.url || "";
      if (!tabId || !isPeacockUrl(url)) {
        sendResponse({ ok: false, error: "Message did not come from a Peacock tab." });
        return;
      }

      await setState({
        peacockTabId: tabId,
        peacockTabSnapshot: buildTabSnapshot(sender.tab)
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "AD_STATE") {
      const result = await applyMode(msg.inAd ? MODE.AD : MODE.SHOW, sender.tab?.id ?? null);
      sendResponse(result || { ok: true });
      return;
    }
    if (msg?.type === "START_SLAYER") {
      const result = await startCommercialSlayer();
      sendResponse(result);
      return;
    }
    if (msg?.type === "STOP_SLAYER") {
      const result = await stopCommercialSlayer();
      sendResponse(result);
      return;
    }
    if (msg?.type === "GET_STATE") {
      const state = await cleanupState();
      sendResponse({ ok: true, state });
      return;
    }
    if (msg?.type === "RUN_TEST_MODE") {
      const result = await applyMode(msg.mode, null, { force: true });
      sendResponse(result || { ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type" });
  })();

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  const patch = {};
  if (state.peacockTabId === tabId) {
    patch.peacockTabId = null;
    patch.peacockTabSnapshot = null;
  }
  if (state.spotifyTabId === tabId) {
    patch.spotifyTabId = null;
    patch.spotifyTabSnapshot = null;
  }
  if (Object.keys(patch).length) {
    await setState(patch);
    setBadge("");
    setBadgeTheme(MODE.UNKNOWN);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const state = await getState();
  const patch = {};

  if (state.peacockTabId === tabId && !isPeacockUrl(changeInfo.url)) {
    patch.peacockTabId = null;
    patch.peacockTabSnapshot = null;
  }

  if (state.spotifyTabId === tabId && !isSpotifyUrl(changeInfo.url)) {
    patch.spotifyTabId = null;
    patch.spotifyTabSnapshot = null;
  }

  if (Object.keys(patch).length) {
    await setState(patch);
  }
});

setBadgeTheme(MODE.UNKNOWN);
