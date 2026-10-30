const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  scheduleMinimizeToTray,
  createRepaintRecovery,
  REPAINT_PROBE_TIMEOUT_MS,
  REPAIR_COOLDOWN_MS,
} = require('./windowLifecycle');

function makeWindow({ minimized = true, destroyed = false } = {}) {
  return {
    hidden: false,
    minimized,
    destroyed,
    hide() {
      this.hidden = true;
    },
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
  };
}

describe('scheduleMinimizeToTray', () => {
  it('defers hide until after the native minimize dispatch', () => {
    const win = makeWindow();
    let deferred;

    scheduleMinimizeToTray({
      win,
      shouldHide: () => true,
      schedule: (callback) => {
        deferred = callback;
      },
    });

    assert.equal(win.hidden, false);
    deferred();
    assert.equal(win.hidden, true);
  });

  it('does not schedule when minimize-to-tray is disabled', () => {
    const win = makeWindow();
    let scheduled = false;

    scheduleMinimizeToTray({
      win,
      shouldHide: () => false,
      schedule: () => {
        scheduled = true;
      },
    });

    assert.equal(scheduled, false);
    assert.equal(win.hidden, false);
  });

  it('skips a stale hide if the window was restored first', () => {
    const win = makeWindow();
    let deferred;

    scheduleMinimizeToTray({
      win,
      shouldHide: () => true,
      schedule: (callback) => {
        deferred = callback;
      },
    });
    win.minimized = false;
    deferred();

    assert.equal(win.hidden, false);
  });

  it('rechecks the preference and destroyed state at fire time', () => {
    let enabled = true;
    const win = makeWindow();
    const callbacks = [];

    scheduleMinimizeToTray({
      win,
      shouldHide: () => enabled,
      schedule: (callback) => callbacks.push(callback),
    });
    enabled = false;
    callbacks[0]();
    assert.equal(win.hidden, false);

    enabled = true;
    scheduleMinimizeToTray({
      win,
      shouldHide: () => enabled,
      schedule: (callback) => callbacks.push(callback),
    });
    win.destroyed = true;
    callbacks[1]();
    assert.equal(win.hidden, false);
  });
});

function makeRecoveryHarness(overrides = {}) {
  const calls = { invalidate: 0, reveal: 0, reload: 0, logs: [] };
  const win = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  let clock = 0;
  let timer = null;

  const recovery = createRepaintRecovery({
    win,
    invalidate: () => {
      calls.invalidate += 1;
    },
    // Default: renderer never answers, i.e. the wedged case we repair.
    probe: () => new Promise(() => {}),
    reveal: () => {
      calls.reveal += 1;
    },
    reload: () => {
      calls.reload += 1;
    },
    log: (entry) => {
      calls.logs.push(entry);
    },
    now: () => clock,
    schedule: (callback) => {
      timer = callback;
      return timer;
    },
    cancelSchedule: () => {
      timer = null;
    },
    ...overrides,
  });

  return {
    recovery,
    calls,
    win,
    advance(ms) {
      clock += ms;
    },
    fireTimer() {
      const callback = timer;
      timer = null;
      if (callback) callback();
    },
    hasTimer() {
      return timer !== null;
    },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('createRepaintRecovery', () => {
  it('forces a repaint whenever the window becomes visible', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    assert.equal(harness.calls.invalidate, 1);

    harness.advance(5_000);
    harness.recovery.notifyShown('focus');
    assert.equal(harness.calls.invalidate, 2);
  });

  it('drops the reload fallback once the renderer answers the probe', async () => {
    const harness = makeRecoveryHarness({ probe: () => Promise.resolve('visible') });

    harness.recovery.notifyShown('show');
    await flushMicrotasks();

    assert.equal(harness.hasTimer(), false);
    assert.equal(harness.calls.reload, 0);
    assert.deepEqual(harness.calls.logs, []);
  });

  it('reloads once when the probe never answers', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.advance(REPAINT_PROBE_TIMEOUT_MS);
    harness.fireTimer();

    assert.equal(harness.calls.reload, 1);
    assert.equal(harness.calls.logs.length, 1);
    assert.equal(harness.calls.logs[0].reason, 'show');
    assert.equal(harness.calls.logs[0].probeTimedOut, true);
    assert.equal(harness.calls.logs[0].reloaded, true);
    assert.equal(harness.calls.logs[0].cooldownBlocked, false);
  });

  it('does not reload twice inside the cooldown window', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.advance(REPAINT_PROBE_TIMEOUT_MS);
    harness.fireTimer();
    assert.equal(harness.calls.reload, 1);

    harness.advance(5_000);
    harness.recovery.notifyShown('restore');
    harness.fireTimer();

    assert.equal(harness.calls.reload, 1);
    assert.equal(harness.calls.logs.length, 2);
    assert.equal(harness.calls.logs[1].cooldownBlocked, true);
    assert.equal(harness.calls.logs[1].reloaded, false);
  });

  it('arms a new probe once the cooldown has elapsed', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.advance(REPAINT_PROBE_TIMEOUT_MS);
    harness.fireTimer();

    harness.advance(REPAIR_COOLDOWN_MS);
    harness.recovery.notifyShown('show');
    harness.fireTimer();

    assert.equal(harness.calls.reload, 2);
  });

  it('skips the repair when the window is hidden again before the probe times out', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.recovery.notifyHidden();
    harness.fireTimer();

    assert.equal(harness.calls.reload, 0);
    assert.equal(harness.calls.invalidate, 1);
  });

  it('keeps a single probe armed when focus events arrive back to back', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.recovery.notifyShown('focus');
    harness.recovery.notifyShown('focus');

    assert.equal(harness.calls.invalidate, 3);
    harness.fireTimer();
    assert.equal(harness.calls.reload, 1);
  });

  it('ignores a destroyed window', () => {
    const harness = makeRecoveryHarness();
    harness.win.destroyed = true;

    harness.recovery.notifyShown('show');

    assert.equal(harness.calls.invalidate, 0);
    assert.equal(harness.hasTimer(), false);
  });

  it('ignores everything after dispose', () => {
    const harness = makeRecoveryHarness();

    harness.recovery.notifyShown('show');
    harness.recovery.dispose();
    harness.fireTimer();

    assert.equal(harness.calls.reload, 0);
  });

  it('records the probe error when the renderer rejects', async () => {
    const harness = makeRecoveryHarness({
      probe: () => Promise.reject(new Error('renderer gone')),
    });

    harness.recovery.notifyShown('show');
    await flushMicrotasks();
    harness.fireTimer();

    assert.equal(harness.calls.reload, 1);
    assert.equal(harness.calls.logs[0].probeError, 'renderer gone');
  });
});

describe('createRepaintRecovery visibility divergence', () => {
  it('cycles the window once when the page still reports hidden', async () => {
    const harness = makeRecoveryHarness({ probe: () => Promise.resolve('hidden') });

    harness.recovery.notifyShown('tray');
    await flushMicrotasks();

    assert.equal(harness.calls.reveal, 1);
    assert.equal(harness.calls.reload, 0);
    assert.equal(harness.hasTimer(), false);
    assert.equal(harness.calls.logs[0].visibilityState, 'hidden');
    assert.equal(harness.calls.logs[0].revealed, true);
    assert.equal(harness.calls.logs[0].reloaded, false);
  });

  it('does not cycle the window again inside the cooldown', async () => {
    const harness = makeRecoveryHarness({ probe: () => Promise.resolve('hidden') });

    harness.recovery.notifyShown('show');
    await flushMicrotasks();
    harness.advance(5_000);
    harness.recovery.notifyShown('focus');
    await flushMicrotasks();

    assert.equal(harness.calls.reveal, 1);
    assert.equal(harness.calls.logs[1].cooldownBlocked, true);
    assert.equal(harness.calls.logs[1].revealed, false);
  });
});
