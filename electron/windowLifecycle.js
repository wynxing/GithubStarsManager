'use strict';

/**
 * Electron commits the native minimized state before emitting `minimize`.
 * Hide on the next event-loop turn instead of re-entering Windows window-state
 * handling from inside that dispatch.
 *
 * A restore can arrive before the scheduled callback runs, so re-check both
 * the preference and window state before hiding.
 */
function scheduleMinimizeToTray({ win, shouldHide, schedule = setImmediate }) {
  if (!shouldHide()) return;

  schedule(() => {
    if (!shouldHide() || win.isDestroyed() || !win.isMinimized()) return;
    win.hide();
  });
}

/**
 * Windows can leave a BrowserWindow's content view parked after the native
 * window becomes visible again — tray hide/show, full occlusion by another
 * window, or a display-topology switch. The HWND is back on screen and the
 * process stays alive and idle, but the compositor never commits another
 * frame, so the window keeps showing its last painted pixels forever.
 * `webContents.invalidate()` schedules a full repaint (and does nothing while
 * the page is still considered a background page), so the probe asks the
 * renderer for `document.visibilityState`: `visible` means the page resumed,
 * `hidden` means the browser process and the on-screen window disagree — a
 * real hide/show visibility cycle (`reveal`) is then the only thing that
 * clears it. A renderer that never answers is reloaded once per cooldown.
 *
 * Dependencies are injected so this stays unit-testable without Electron.
 */
const REPAINT_PROBE_TIMEOUT_MS = 3_000;
const REPAIR_COOLDOWN_MS = 60_000;
const MIN_PROBE_INTERVAL_MS = 1_000;

function createRepaintRecovery({
  win,
  invalidate,
  probe,
  reveal = () => {},
  reload,
  log = () => {},
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  timeoutMs = REPAINT_PROBE_TIMEOUT_MS,
  cooldownMs = REPAIR_COOLDOWN_MS,
  minProbeIntervalMs = MIN_PROBE_INTERVAL_MS,
}) {
  let probeTimer = null;
  let lastProbeAt = null;
  let lastRepairAt = null;
  let visible = false;
  let disposed = false;

  const usable = () => !disposed && !!win && !win.isDestroyed();

  function cancelProbe() {
    if (probeTimer !== null) {
      cancelSchedule(probeTimer);
      probeTimer = null;
    }
  }

  /**
   * Called from `show` / `restore` / `focus` and from the tray restore path.
   * Always forces a repaint; a probe only runs when none is pending and the
   * previous one is older than `minProbeIntervalMs` (focus fires on every
   * click, and each probe is a renderer round-trip).
   */
  function notifyShown(reason = 'show') {
    if (!usable()) return;
    visible = true;
    try {
      invalidate();
    } catch {
      // Best-effort: a broken invalidate must never break window handling.
    }
    // Keep an already armed probe: dropping it here would lose the repair.
    if (lastProbeAt !== null && now() - lastProbeAt < minProbeIntervalMs) return;
    lastProbeAt = now();
    cancelProbe();

    const startedAt = lastProbeAt;
    let settled = false;
    let probeError = null;

    probeTimer = schedule(() => {
      probeTimer = null;
      if (settled) return;
      settled = true;
      if (!usable() || !visible) return;
      const cooldownBlocked =
        lastRepairAt !== null && now() - lastRepairAt < cooldownMs;
      if (!cooldownBlocked) {
        lastRepairAt = now();
        try {
          reload();
        } catch {
          // Reload failure leaves the stale frame; the log below is the trail.
        }
      }
      log({
        reason,
        probeTimedOut: true,
        probeError,
        cooldownBlocked,
        reloaded: !cooldownBlocked,
        elapsedMs: now() - startedAt,
      });
    }, timeoutMs);

    Promise.resolve()
      .then(probe)
      .then(
        (visibilityState) => {
          // Renderer answered. `visible` means the page resumed and frames are
          // flowing again; `hidden` means the browser process still believes
          // this window is hidden even though it is on screen — the exact
          // divergence that leaves a stale frame. A real visibility cycle is
          // the only thing that clears it.
          if (visibilityState === 'hidden') {
            const cooldownBlocked =
              lastRepairAt !== null && now() - lastRepairAt < cooldownMs;
            if (!cooldownBlocked) {
              lastRepairAt = now();
              try {
                reveal();
              } catch {
                // Leaving the stale frame is still better than crashing here.
              }
            }
            settled = true;
            cancelProbe();
            log({
              reason,
              visibilityState,
              revealed: !cooldownBlocked,
              cooldownBlocked,
              reloaded: false,
              elapsedMs: now() - startedAt,
            });
            return;
          }
          settled = true;
          cancelProbe();
        },
        (error) => {
          // Keep the timer armed: a crashed/hung renderer still needs the reload.
          probeError = error instanceof Error ? error.message : String(error);
        },
      );
  }

  function notifyHidden() {
    visible = false;
    cancelProbe();
  }

  function dispose() {
    disposed = true;
    visible = false;
    cancelProbe();
  }

  return { notifyShown, notifyHidden, dispose };
}

module.exports = {
  scheduleMinimizeToTray,
  createRepaintRecovery,
  REPAINT_PROBE_TIMEOUT_MS,
  REPAIR_COOLDOWN_MS,
  MIN_PROBE_INTERVAL_MS,
};
