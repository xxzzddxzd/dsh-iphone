(() => {
  const PROBE_INTERVAL_MS = 15_000;
  const PROBE_TIMEOUT_MS = 5_000;
  const RESUME_DEBOUNCE_MS = 1_000;
  // A hide this long leaves the streams unusable even though the connection
  // still reports connected; a shorter one usually resumes on the same mux.
  const STALE_HIDE_MS = 2_000;
  let release;

  function install({ connection, openProbe }) {
    release?.();
    let disposed = false;
    let timer;
    let pending;
    let hidden = document.visibilityState === "hidden";
    let hiddenAt = hidden ? Date.now() : 0;
    let lastReconnect = -Infinity;
    let lastTick = Date.now();
    // The on-device Host is reachable without a network path, so radio events
    // say nothing about this connection.
    const loopback = typeof location !== "undefined" && typeof location.hostname === "string"
      && /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(location.hostname);
    const status = { checks: 0, recoveries: 0, lastReason: null, lastCheckedAt: null,
      state: connection.state.getSnapshot() ?? "pending", errors: [] };
    window.__DSH_IOS_CONNECTION_RECOVERY__.status = status;
    function recordError(kind, error) {
      const name = typeof error?.name === "string" && /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|AbortError|RemoteError|NetworkError|TimeoutError)$/.test(error.name)
        ? error.name : "Error";
      const code = typeof error?.code === "string" && /^(ERR_|E[A-Z]+|[a-z]+\/)[A-Za-z0-9_/-]{0,64}$/.test(error.code)
        ? error.code : undefined;
      // Keep classifications only: exception messages can contain chat text,
      // request URLs or credentials. A bounded ring is enough to locate a fault.
      status.errors.push({ at: Date.now(), kind, name, ...(code ? { code } : {}) });
      if (status.errors.length > 10) status.errors.shift();
    }
    const pageError = event => recordError("page", event.error);
    const rejected = event => recordError("promise", event.reason);
    const originalConsoleError = console.error;
    const reportConsoleError = (...args) => {
      if (typeof args[0] === "string" && /^\[(session-controller|connection)\]/.test(args[0])) {
        recordError("session-stream", args.find(value => value && typeof value === "object"));
      }
      originalConsoleError.apply(console, args);
    };
    console.error = reportConsoleError;
    window.addEventListener("error", pageError);
    window.addEventListener("unhandledrejection", rejected);

    function cancelProbe() {
      const probe = pending;
      pending = undefined;
      if (probe) {
        clearTimeout(probe.timeout);
        probe.controller.abort();
      }
    }
    function schedule() {
      clearTimeout(timer);
      if (!disposed && !hidden && connection.state.getSnapshot() === "connected") {
        lastTick = Date.now();
        timer = setTimeout(() => {
          if (Date.now() - lastTick > PROBE_INTERVAL_MS * 2) reconnect("page-resumed");
          else void check();
        }, PROBE_INTERVAL_MS);
      }
    }
    function reconnect(reason) {
      if (disposed || hidden || Date.now() - lastReconnect < RESUME_DEBOUNCE_MS) return;
      lastReconnect = Date.now();
      clearTimeout(timer);
      cancelProbe();
      status.recoveries += 1;
      status.lastReason = reason;
      // The official lifecycle replaces all subscriptions and resumes their
      // durable cursors. It leaves the page, composer, and running Host alone.
      connection.reconnect();
      schedule();
    }
    async function check(failureReason = "event-stream-unresponsive") {
      if (disposed || hidden || pending || connection.state.getSnapshot() !== "connected") return;
      const controller = new AbortController();
      const probe = { controller, generation: connection.generation.getSnapshot(), timeout: undefined };
      pending = probe;
      let iterator;
      try {
        // A fresh read-only control baseline must traverse the same physical
        // mux as conversation events; an HTTP response alone cannot prove it.
        iterator = openProbe(controller.signal)[Symbol.asyncIterator]();
        const deadline = new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          probe.timeout = setTimeout(() => {
            controller.abort(new Error("event stream probe timed out"));
          }, PROBE_TIMEOUT_MS);
        });
        const first = await Promise.race([iterator.next(), deadline]);
        if (first.done || first.value?.type !== "baseline") throw new Error("missing control baseline");
        if (pending === probe) {
          status.checks += 1;
          status.lastCheckedAt = Date.now();
        }
      } catch {
        if (pending === probe && connection.state.getSnapshot() === "connected" &&
            connection.generation.getSnapshot() === probe.generation) {
          reconnect(failureReason);
        }
      } finally {
        clearTimeout(probe.timeout);
        controller.abort();
        if (iterator) void Promise.resolve(iterator.return?.()).catch(() => {
          // Cancellation may reject the probe iterator after its final frame.
        });
        if (pending === probe) pending = undefined;
        schedule();
      }
    }
    const stateChanged = () => {
      status.state = connection.state.getSnapshot() ?? "pending";
      if (connection.state.getSnapshot() !== "connected") cancelProbe();
      schedule();
    };
    const visibilityChanged = () => {
      const wasHidden = hidden;
      hidden = document.visibilityState === "hidden";
      if (hidden) {
        hiddenAt = Date.now();
        clearTimeout(timer);
        cancelProbe();
        return;
      }
      if (!wasHidden) return;
      // A long hide suspends the web process and its streams; a short one
      // usually resumes on the same mux, so prove that mux with a probe
      // instead of replacing every subscription on each app switch.
      if (Date.now() - hiddenAt >= STALE_HIDE_MS) reconnect("page-visible");
      else void check("page-visible");
    };
    const pageShown = event => { if (event.persisted) reconnect("page-restored"); };
    const online = () => { if (!loopback) reconnect("network-returned"); };
    const focused = () => {
      if (!hidden && Date.now() - lastTick >= PROBE_INTERVAL_MS) void check();
    };
    const unsubscribe = connection.state.subscribe(stateChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pageshow", pageShown);
    window.addEventListener("online", online);
    window.addEventListener("focus", focused);
    schedule();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      cancelProbe();
      unsubscribe();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pageshow", pageShown);
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focused);
      window.removeEventListener("error", pageError);
      window.removeEventListener("unhandledrejection", rejected);
      if (console.error === reportConsoleError) console.error = originalConsoleError;
      if (release === dispose) release = undefined;
    };
    release = dispose;
    return dispose;
  }
  window.__DSH_IOS_CONNECTION_RECOVERY__ = { install };
})();
