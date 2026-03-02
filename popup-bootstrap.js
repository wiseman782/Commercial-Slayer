(async () => {
  try {
    const data = await chrome.storage.local.get({
      peacockTabId: null,
      peacockTabSnapshot: null,
      spotifyTabId: null,
      spotifyTabSnapshot: null,
      enabled: false,
      lastMode: "UNKNOWN"
    });

    const peacockTab = data.peacockTabSnapshot || (data.peacockTabId ? {
      id: data.peacockTabId,
      title: "Saved Peacock tab",
      url: ""
    } : null);
    const spotifyTab = data.spotifyTabSnapshot || (data.spotifyTabId ? {
      id: data.spotifyTabId,
      title: "Saved Spotify tab",
      url: ""
    } : null);

    const setupComplete = Boolean(peacockTab && spotifyTab);
    const running = Boolean(data.enabled && setupComplete);
    const mode = data.lastMode || "UNKNOWN";

    if (!peacockTab && !spotifyTab && !data.enabled && mode === "UNKNOWN") {
      return;
    }

    const describe = (tab) => tab ? (tab.title || tab.url || `Tab ${tab.id}`) : "Not set";

    const statusPill = document.getElementById("statusPill");
    const statusLine = document.getElementById("statusLine");
    const setupCard = document.getElementById("setupCard");
    const tabsSummary = document.getElementById("tabsSummary");
    const mainToggle = document.getElementById("mainToggle");
    const statusBig = document.getElementById("statusBig");
    const statusSub = document.getElementById("statusSub");
    const statusMeta = document.getElementById("statusMeta");

    statusPill.textContent = running ? "ON" : "OFF";
    statusPill.className = running ? "status-pill on" : "status-pill";

    if (!setupComplete) {
      statusLine.textContent = "Set Peacock + Spotify, then turn it on.";
      setupCard.hidden = false;
      tabsSummary.hidden = true;
      mainToggle.textContent = "Turn On";
      mainToggle.disabled = true;
      mainToggle.className = "primary-button off";
      statusBig.textContent = "WAITING";
      statusSub.textContent = "Waiting for setup";
      statusMeta.textContent = "Detector: Loading...";
    } else {
      setupCard.hidden = true;
      tabsSummary.hidden = false;
      mainToggle.textContent = running ? "Turn Off" : "Turn On";
      mainToggle.disabled = false;
      mainToggle.className = running ? "primary-button on" : "primary-button off";

      if (running && mode === "AD") {
        statusLine.textContent = "Running — ad detected. Spotify taking over.";
        statusBig.textContent = "AD";
        statusSub.textContent = "Peacock muted • Spotify playing";
      } else if (running && mode === "SHOW") {
        statusLine.textContent = "Running — Peacock audio on.";
        statusBig.textContent = "SHOW";
        statusSub.textContent = "Peacock audio on • Spotify muted";
      } else {
        statusLine.textContent = "Ready. Turn it on when you start watching Peacock.";
        statusBig.textContent = "WAITING";
        statusSub.textContent = "Open Peacock playback to begin detection";
      }

      statusMeta.textContent = "Detector: Loading...";
    }

    document.getElementById("peacockTab").textContent = describe(peacockTab);
    document.getElementById("spotifyTab").textContent = describe(spotifyTab);
    document.getElementById("peacockSummary").textContent = describe(peacockTab);
    document.getElementById("spotifySummary").textContent = describe(spotifyTab);
    document.getElementById("peacockChecklist").textContent =
      `${peacockTab ? "✅" : "☐"} Peacock selected`;
    document.getElementById("spotifyChecklist").textContent =
      `${spotifyTab ? "✅" : "☐"} Spotify selected`;
  } catch (error) {
    // Leave the loading skeleton in place if bootstrap fails.
  }
})();
