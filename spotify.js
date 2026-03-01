const PRIMARY_TOGGLE_SELECTOR = 'button[data-testid="control-button-playpause"]';
const PLAYER_SCOPE_SELECTORS = [
  '[data-testid="now-playing-bar"]',
  '[data-testid*="player"]',
  'footer',
  'body'
];

const FALLBACK_BUTTON_SELECTORS = [
  'button[aria-label*="Pause" i]',
  'button[aria-label*="Play" i]',
  'button[title*="Pause" i]',
  'button[title*="Play" i]'
];

function isVisibleButton(button) {
  if (!(button instanceof HTMLButtonElement)) return false;
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findPrimaryToggleButton() {
  for (const scopeSelector of PLAYER_SCOPE_SELECTORS) {
    const scope = document.querySelector(scopeSelector);
    if (!scope) continue;

    const button = scope.querySelector(PRIMARY_TOGGLE_SELECTOR);
    if (isVisibleButton(button)) {
      return { button, method: "data-testid" };
    }
  }

  for (const scopeSelector of PLAYER_SCOPE_SELECTORS) {
    const scope = document.querySelector(scopeSelector);
    if (!scope) continue;

    for (const selector of FALLBACK_BUTTON_SELECTORS) {
      const candidates = scope.querySelectorAll(selector);
      for (const button of candidates) {
        if (isVisibleButton(button)) {
          return { button, method: `fallback:${selector}` };
        }
      }
    }
  }

  return { button: null, method: null };
}

function getButtonLabel(button) {
  return (
    button?.getAttribute("aria-label") ||
    button?.getAttribute("title") ||
    ""
  ).trim();
}

function getPlaybackState() {
  const { button, method } = findPrimaryToggleButton();
  if (button) {
    const label = getButtonLabel(button).toLowerCase();
    if (label.includes("pause")) {
      return { ok: true, isPlaying: true, label, method };
    }
    if (label.includes("play")) {
      return { ok: true, isPlaying: false, label, method };
    }

    return {
      ok: true,
      isPlaying: null,
      label,
      method
    };
  }

  return {
    ok: false,
    isPlaying: null,
    reason: "Spotify play/pause button not found."
  };
}

function getActionButton(action) {
  return findPrimaryToggleButton();
}

function clickButton(button) {
  button.focus();
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  button.click();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setPlayback(action) {
  const shouldPlay = action === "PLAY";
  let state = getPlaybackState();
  if (!state.ok) {
    return state;
  }

  const alreadyInTargetState =
    state.isPlaying === null
      ? false
      : (shouldPlay ? state.isPlaying : !state.isPlaying);
  if (!alreadyInTargetState) {
    let clicked = false;
    let lastMethod = state.method || null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { button, method } = getActionButton(action);
      if (!button) {
        break;
      }

      lastMethod = method || lastMethod;
      clickButton(button);
      clicked = true;
      await wait(150);

      state = getPlaybackState();
      if (state.ok && (shouldPlay ? state.isPlaying : !state.isPlaying)) {
        break;
      }
    }

    if (!clicked) {
      return {
        ok: false,
        isPlaying: state.isPlaying,
        reason: "Spotify control disappeared before click.",
        method: lastMethod
      };
    }
  }

  const nextState = getPlaybackState();
  return {
    ok: nextState.ok,
    isPlaying: nextState.isPlaying,
    reason: nextState.reason || null,
    label: nextState.label || null,
    method: nextState.method || null
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "SPOTIFY_PLAYBACK") {
      const result = await setPlayback(msg.action);
      sendResponse(result);
      return;
    }

    if (msg?.type === "GET_SPOTIFY_PLAYBACK_STATE") {
      sendResponse(getPlaybackState());
      return;
    }

    sendResponse({ ok: false, reason: "Unknown message type." });
  })();

  return true;
});
