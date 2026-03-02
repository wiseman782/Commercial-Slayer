// peacock.js
//
// Watches Peacock DOM to detect ad breaks.
// Primary signal: presence of ad countdown UI.
// This is based on selectors referenced by a popular "Mute Peacock Ads" userscript discussion.
// https://greasyfork.org/en/scripts/428949-mute-peacock-ads/discussions/242736

const DEBUG = false;

// --- Heuristics ---
const SELECTOR_SIGNALS = [
  ".ad-countdown__remaining-time",
  ".countdown__remaining-time.ad-countdown__remaining-time",
  '[data-testid="ad-countdown"]',
  '[data-testid*="countdown"]'
];

// Additional, more flexible selector patterns we can try.
const FUZZY_SIGNALS = [
  '[class*="ad-countdown"][class*="remaining"]',
  '[class*="ad-countdown"] [class*="remaining"]',
  '[class*="adCountdown"]',
  '[class*="advertis"]',
  '[class*="commercial"]',
  '[data-testid*="advert"]',
  '[data-testid*="commercial"]',
  '[id*="advert"]'
];

const TEXT_PATTERNS = [
  /\bAd\s+\d+\s+of\s+\d+\b/i,
  /\bAd\s+\d+\b/i,
  /\bYour\s+video\s+will\s+resume\b/i,
  /\bThis\s+event\s+will\s+resume\s+shortly\b/i,
  /\bEvent\s+will\s+resume\s+shortly\b/i,
  /\bAdvertisement\b/i,
  /\bCommercial\s+break\b/i,
  /\bSponsored\s+by\b/i,
  /\bWe('|’)ll\s+be\s+right\s+back\b/i,
  /\bEnjoying\s+the\s+show\?\b/i,
  /\bAd\s+choices\b/i
];

const IGNORED_TEXT_PATTERNS = [
  /targeted ads/i,
  /allow sale\/share/i,
  /your privacy choices/i,
  /strictly necessary cookies/i,
  /preference center/i,
  /opt-out form/i,
  /onetrust/i
];

const LIKELY_AD_RESOURCE_PATTERNS = [
  /freewheel/i,
  /doubleclick/i,
  /googlesyndication/i,
  /googleads/i,
  /pubads/i,
  /adsystem/i,
  /\/ads?\//i,
  /\bad\b.*\.m3u8/i,
  /\bvast\b/i,
  /\bvmap\b/i
];

// FreeWheel ad tracking pings can be spaced out during a long ad pod.
// Keep ad state alive long enough to bridge those gaps, while still letting
// the normal Peacock playback UI immediately force a return to SHOW.
const AD_RESOURCE_WINDOW_MS = 22000;

let detectorSnapshot = {
  inAd: false,
  matchedSelectors: [],
  matchedText: [],
  sampleText: "",
  playerSummary: null,
  candidateNodes: [],
  resourceHints: [],
  updatedAt: null
};

const recentResources = [];
const recentDetectorHistory = [];
const MAX_HISTORY_ITEMS = 30;

function log(...args) {
  if (DEBUG) console.log("[CommercialSlayer]", ...args);
}

function hasSelectorSignal() {
  const matches = [];
  for (const sel of SELECTOR_SIGNALS) {
    const elements = document.querySelectorAll(sel);
    for (const element of elements) {
      if (!isIgnoredElement(element)) {
        matches.push(sel);
        break;
      }
    }
  }
  return matches;
}

function hasFuzzySignal() {
  const matches = [];
  for (const sel of FUZZY_SIGNALS) {
    const elements = document.querySelectorAll(sel);
    for (const element of elements) {
      if (!isIgnoredElement(element)) {
        matches.push(sel);
        break;
      }
    }
  }
  return matches;
}

function getCandidateText() {
  const root =
    document.querySelector('[role="main"]') ||
    document.querySelector("main") ||
    document.querySelector("#root") ||
    document.body;

  return (root?.innerText || "").slice(0, 25000);
}

function getVisiblePlayerText() {
  const root =
    document.querySelector("#mainContainer") ||
    document.querySelector('[data-testid="video-id"]') ||
    document.querySelector('[data-testid="video-component"]') ||
    document.body;

  return (root?.innerText || "").slice(0, 4000);
}

function summarizeElement(element) {
  if (!element) return null;

  return {
    tag: element.tagName?.toLowerCase() || null,
    id: element.id || "",
    className:
      typeof element.className === "string"
        ? element.className.slice(0, 300)
        : "",
    role: element.getAttribute?.("role") || "",
    ariaLabel: element.getAttribute?.("aria-label") || "",
    dataTestId: element.getAttribute?.("data-testid") || "",
    text: (element.innerText || element.textContent || "").trim().slice(0, 180)
  };
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function matchesIgnoredContent(value = "") {
  return IGNORED_TEXT_PATTERNS.some((re) => re.test(value));
}

function isIgnoredElement(element) {
  const summary = summarizeElement(element);
  if (!summary) return false;

  const haystack = [
    summary.id,
    summary.className,
    summary.role,
    summary.ariaLabel,
    summary.dataTestId,
    summary.text
  ]
    .filter(Boolean)
    .join(" ");

  return matchesIgnoredContent(haystack);
}

function trackResource(url = "") {
  if (!url) return;

  recentResources.push({
    url,
    at: new Date().toISOString()
  });

  if (recentResources.length > 80) {
    recentResources.splice(0, recentResources.length - 80);
  }
}

function pushDetectorHistory(entry) {
  recentDetectorHistory.push(entry);
  if (recentDetectorHistory.length > MAX_HISTORY_ITEMS) {
    recentDetectorHistory.splice(0, recentDetectorHistory.length - MAX_HISTORY_ITEMS);
  }
}

function getLikelyAdResources() {
  const cutoff = Date.now() - AD_RESOURCE_WINDOW_MS;
  return recentResources
    .filter((entry) => {
      const age = new Date(entry.at).getTime();
      return age >= cutoff && LIKELY_AD_RESOURCE_PATTERNS.some((re) => re.test(entry.url));
    })
    .slice(-12);
}

function getCandidateNodes() {
  const selectors = [
    "video",
    '[data-testid*="player"]',
    '[class*="player"]',
    '[class*="video"]',
    '[class*="ad"]',
    '[class*="advert"]',
    '[class*="commercial"]',
    '[role="dialog"]',
    '[aria-live]'
  ];

  const nodes = [];

  for (const sel of selectors) {
    const elements = document.querySelectorAll(sel);
    for (const element of elements) {
      const summary = summarizeElement(element);
      if (summary && !isIgnoredElement(element)) {
        nodes.push({ selector: sel, ...summary });
      }
      if (nodes.length >= 12) {
        return nodes;
      }
    }
  }

  return nodes;
}

function getPlayerSummary() {
  const video = document.querySelector("video");
  if (!video) {
    return null;
  }

  const parentChain = [];
  let current = video.parentElement;

  while (current && parentChain.length < 5) {
    parentChain.push(summarizeElement(current));
    current = current.parentElement;
  }

  return {
    video: {
      paused: video.paused,
      ended: video.ended,
      currentTime: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(2)) : null,
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
      muted: video.muted,
      volume: Number.isFinite(video.volume) ? Number(video.volume.toFixed(2)) : null,
      readyState: video.readyState
    },
    parents: parentChain
  };
}

// Text-based fallback: scan visible text for common ad UI patterns.
function hasAdTextSignal() {
  const text = getCandidateText();
  return TEXT_PATTERNS
    .filter((re) => re.test(text))
    .map((re) => re.toString());
}

function hasShowPlaybackSignal() {
  const text = getVisiblePlayerText();
  if (!text) return false;

  const showPatterns = [
    /\bAUDIO\b/i,
    /\bSUBTITLES\b/i,
    /\bFONT SIZE\b/i,
    /\bSTYLE PRESETS\b/i,
    /\bAPPLY\b/i,
    /\bCANCEL\b/i,
    /\d{1,2}:\d{2}:\d{2}\s*\/\s*\d{1,2}:\d{2}:\d{2}/i
  ];

  return showPatterns.some((re) => re.test(text));
}

function updateSnapshot({ inAd, matchedSelectors, matchedText, sampleText }) {
  detectorSnapshot = {
    inAd,
    matchedSelectors,
    matchedText,
    sampleText,
    playerSummary: getPlayerSummary(),
    candidateNodes: getCandidateNodes(),
    resourceHints: getLikelyAdResources(),
    updatedAt: new Date().toISOString()
  };

  pushDetectorHistory({
    at: detectorSnapshot.updatedAt,
    inAd: detectorSnapshot.inAd,
    matchedSelectors: detectorSnapshot.matchedSelectors,
    matchedText: detectorSnapshot.matchedText,
    sampleText: detectorSnapshot.sampleText,
    playerSummary: detectorSnapshot.playerSummary,
    resourceHints: detectorSnapshot.resourceHints
  });
}

function getDebugSnapshot() {
  const fullText = getCandidateText();

  return {
    url: location.href,
    title: document.title,
    detector: detectorSnapshot,
    textMatches: hasAdTextSignal(),
    sampleText: fullText.slice(0, 1200),
    playerSummary: getPlayerSummary(),
    candidateNodes: getCandidateNodes(),
    resourceHints: getLikelyAdResources(),
    detectorHistory: recentDetectorHistory.slice(-12),
    documentMarkers: {
      bodyClassName:
        typeof document.body?.className === "string"
          ? document.body.className.slice(0, 400)
          : "",
      rootId: document.documentElement?.id || "",
      rootClassName:
        typeof document.documentElement?.className === "string"
          ? document.documentElement.className.slice(0, 400)
          : ""
    },
    matchedSelectors: unique([
      ...hasSelectorSignal(),
      ...hasFuzzySignal()
    ]),
    capturedAt: new Date().toISOString()
  };
}

function isAdNow() {
  const selectorMatches = hasSelectorSignal();
  const fuzzyMatches = hasFuzzySignal();
  const textMatches = hasAdTextSignal().filter((value) => !matchesIgnoredContent(value));
  const sampleText = getCandidateText().slice(0, 300);
  const matchedSelectors = [...selectorMatches, ...fuzzyMatches];
  const resourceHints = getLikelyAdResources();
  const showPlaybackSignal = hasShowPlaybackSignal();
  const inAd = showPlaybackSignal
    ? false
    : (
        matchedSelectors.length > 0 ||
        textMatches.length > 0 ||
        resourceHints.length > 0
      );

  updateSnapshot({
    inAd,
    matchedSelectors,
    matchedText: showPlaybackSignal
      ? [...textMatches, "show-playback-signal"]
      : textMatches,
    sampleText
  });

  return inAd;
}

// --- Stabilization (prevents rapid toggling) ---
if (window.top === window) {
  let lastRaw = null;
  let stableCount = 0;
  let stableState = null;

  const REQUIRED_STABLE_TICKS = 2;
  const POLL_MS = 500;

  let pollTimer = null;
  let registerTimer = null;

  if ("PerformanceObserver" in window) {
    try {
      const resourceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          trackResource(entry.name);
        }
      });

      resourceObserver.observe({ type: "resource", buffered: true });
    } catch (error) {
      log("Resource observer unavailable", error);
    }
  }

  async function sendAdState(inAd) {
    try {
      await chrome.runtime.sendMessage({ type: "AD_STATE", inAd });
    } catch (e) {
      // service worker may be asleep; polling will retry
    }
  }

  async function registerPeacockTab() {
    try {
      await chrome.runtime.sendMessage({ type: "REGISTER_PEACOCK_TAB" });
    } catch (e) {
      // service worker may be asleep; polling will retry
    }
  }

  function tick() {
    const raw = isAdNow();

    if (raw === lastRaw) stableCount += 1;
    else stableCount = 1;

    lastRaw = raw;

    if (stableCount >= REQUIRED_STABLE_TICKS && raw !== stableState) {
      stableState = raw;
      log("Stable state changed:", stableState ? "AD" : "SHOW");
      sendAdState(stableState);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "GET_DETECTOR_STATE") {
      sendResponse({ ok: true, detector: detectorSnapshot });
      return true;
    }
    if (msg?.type === "CAPTURE_DEBUG_SNAPSHOT") {
      sendResponse({ ok: true, snapshot: getDebugSnapshot() });
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => tick());

  function start() {
    registerPeacockTab();

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    pollTimer = setInterval(tick, POLL_MS);
    registerTimer = setInterval(registerPeacockTab, 15000);
    tick();
    log("Started Peacock ad detector.");
  }

  start();
}
