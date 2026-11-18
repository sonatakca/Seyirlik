// Seyirlik Control — dashboard client. No framework, no build step: this
// file is served as-is by the control service. Every value from the server is
// written with textContent, never as HTML.
"use strict";

const GROUP_LABELS = {
  storage: "Storage",
  process: "Process & network",
  database: "Database",
  credentials: "Credentials",
  media: "Media processing",
  library: "Library & files",
  integrations: "Integrations",
  other: "Other",
};
const TABS = [
  ["overview", "Overview"],
  ["settings", "Settings"],
  ["logs", "Logs"],
  ["activity", "Activity"],
];

const state = {
  tab: "overview",
  session: null,
  overview: null,
  overviewError: null,
  config: null,
  pending: {
    settings: { set: {}, unset: new Set() },
    secrets: { set: {}, unset: new Set() },
  },
  replacing: new Set(),
  filter: "",
  busy: new Set(),
  logs: null,
  logName: null,
  logTail: null,
  logFollow: false,
  activity: null,
};

// ------------------------------------------------------------------ helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") el.className = value;
    else if (name === "text") el.textContent = value;
    else if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else if (name === "value") el.value = value;
    else if (name === "checked") el.checked = Boolean(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return el;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status}).`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const init = {
    method,
    headers: { "x-seyirlik-control": "1" },
    credentials: "same-origin",
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") {
    state.session = { ...(state.session || {}), authenticated: false };
    render();
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

function bytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function ago(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function duration(ms) {
  if (typeof ms !== "number") return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

let toastTimer;
function toast(message, kind = "ok") {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === "err" ? 9000 : 5000);
}

function pendingCount() {
  let n = 0;
  for (const file of ["settings", "secrets"]) {
    n +=
      Object.keys(state.pending[file].set).length +
      state.pending[file].unset.size;
  }
  return n;
}

function serviceDot(s) {
  if (state.busy.has(s)) return "busy";
  return (
    {
      running: "ok",
      stopped: "crit",
      missing: "crit",
      starting: "busy",
      stopping: "busy",
    }[s] ?? "warn"
  );
}

// ------------------------------------------------------------------- loading

async function loadSession() {
  try {
    state.session = await api("/api/session");
  } catch (error) {
    state.session = { authenticated: false, error: error.message };
  }
}

async function loadOverview() {
  try {
    state.overview = await api("/api/overview");
    state.overviewError = null;
  } catch (error) {
    if (error.status !== 401) state.overviewError = error.message;
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
}

async function loadTab() {
  if (!state.session?.authenticated) return;
  try {
    if (state.tab === "overview") await loadOverview();
    if (state.tab === "settings") await loadConfig();
    if (state.tab === "logs") {
      state.logs = (await api("/api/logs")).logs;
      if (!state.logName && state.logs.length)
        state.logName = state.logs[0].name;
      if (state.logName) await loadTail();
    }
    if (state.tab === "activity")
      state.activity = (await api("/api/activity")).activity;
  } catch (error) {
    if (error.status !== 401) toast(error.message, "err");
  }
}

async function loadTail() {
  state.logTail = await api(
    `/api/logs/tail?name=${encodeURIComponent(state.logName)}&bytes=${256 * 1024}`,
  );
}

// -------------------------------------------------------------------- render

function render() {
  const root = document.getElementById("root");
  if (!state.session) return;
  if (!state.session.authenticated) {
    root.replaceChildren(renderLogin());
    root.querySelector("input")?.focus();
    return;
  }
  const body =
    state.tab === "overview"
      ? renderOverview()
      : state.tab === "settings"
        ? renderSettings()
        : state.tab === "logs"
          ? renderLogs()
          : renderActivity();
  root.replaceChildren(
    h("div", { class: "shell" }, renderTopbar(), body),
    renderSavebar(),
  );
}

function renderLogin() {
  const error = h("p", { class: "note err", role: "alert" });
  const input = h("input", {
    class: "input",
    type: "password",
    name: "password",
    autocomplete: "current-password",
    required: true,
    "aria-label": "Password",
  });
  const button = h(
    "button",
    { class: "btn primary", type: "submit" },
    "Sign in",
  );
  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        error.textContent = "";
        try {
          await api("/api/login", {
            method: "POST",
            body: { password: input.value },
          });
          state.session = await api("/api/session");
          await loadTab();
          render();
        } catch (e) {
          error.textContent = e.message;
          button.disabled = false;
          input.select();
        }
      },
    },
    h(
      "div",
      { class: "brand" },
      h("img", { src: "/icon.svg", alt: "" }),
      "Seyirlik Control",
    ),
    h("h1", { text: "Sign in" }),
    state.session?.configured === false
      ? h(
          "p",
          { class: "note warn" },
          "No password is set yet. On the server, run the set-password command from the install guide.",
        )
      : h(
          "p",
          { class: "muted" },
          "Settings, services and logs for the Seyirlik server. Reachable over Tailscale only.",
        ),
    input,
    button,
    error,
  );
  return h("main", { class: "login" }, form);
}

function renderTopbar() {
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "brand" },
      h("img", { src: "/icon.svg", alt: "" }),
      "Seyirlik Control",
    ),
    h(
      "nav",
      { class: "tabs", role: "tablist" },
      TABS.map(([id, label]) =>
        h("button", {
          class: "tab",
          role: "tab",
          "aria-selected": state.tab === id ? "true" : "false",
          text: label,
          onclick: async () => {
            state.tab = id;
            render();
            await loadTab();
            render();
          },
        }),
      ),
    ),
    h("div", { class: "spacer" }),
    state.session.platform === "dev"
      ? h(
          "span",
          { class: "badge dev", title: "Services are simulated" },
          "Development",
        )
      : null,
    h("button", {
      class: "btn ghost small",
      text: "Sign out",
      onclick: async () => {
        await api("/api/logout", { method: "POST" }).catch(() => {});
        state.session = { ...state.session, authenticated: false };
        render();
      },
    }),
  );
}

// ------------------------------------------------------------------ overview

function renderOverview() {
  const o = state.overview;
  if (!o) {
    return h(
      "section",
      {},
      h("h1", { text: "Overview" }),
      h(
        "p",
        { class: state.overviewError ? "note err" : "muted" },
        state.overviewError || "Checking the server…",
      ),
    );
  }
  return h(
    "section",
    {},
    h("h1", { text: "Overview" }),
    h(
      "p",
      { class: "lede" },
      `Checked ${ago(o.checkedAt)}. Refreshes every 10 seconds.`,
    ),
    renderHealth(o.health),
    o.missing?.length
      ? h(
          "div",
          { class: "panel warn", style: "margin-top:12px" },
          h("h3", { text: "Required settings are missing" }),
          h("p", { class: "muted" }, o.missing.join(", ")),
        )
      : null,
    h("h2", { text: "Services" }),
    renderServices(o.services),
    h("h2", { text: "Storage paths" }),
    renderPaths(o.paths),
    h("h2", { text: "Drives" }),
    renderDrives(o.drives),
  );
}

function renderHealth(health) {
  let dot = "crit";
  let headline = "Not answering";
  let detail =
    "The health endpoint did not respond. The server process is probably not running.";
  const body = health?.body;
  if (!health) {
    dot = "warn";
    headline = "Unknown";
    detail = "No health URL is configured.";
  } else if (health.reachable && body?.ready) {
    dot = "ok";
    headline = "Ready";
    detail = "Every startup phase finished and the API is serving.";
  } else if (health.reachable && body?.alive) {
    const phase = body.startup?.phases?.find(
      (p) => p.id === body.startup.phase,
    );
    dot = body.startup?.state === "degraded" ? "crit" : "warn";
    headline =
      body.startup?.state === "degraded"
        ? `Stuck at: ${phase?.label ?? body.startup.phase}`
        : `Starting: ${phase?.label ?? body.startup?.phase ?? "…"}`;
    detail = phase?.detail ?? "The process is up but not ready yet.";
  } else if (health.reachable) {
    headline = `Answering with HTTP ${health.status}`;
    detail = "The health endpoint answered, but not in the expected shape.";
  } else if (health.error) {
    detail = `The health endpoint did not respond (${health.error}).`;
  }

  const phases = body?.startup?.phases ?? [];
  const stuck = phases.find((p) => p.state === "degraded");
  return h(
    "div",
    {
      class: `panel ${dot === "crit" ? "alert" : dot === "warn" ? "warn" : ""}`,
    },
    h("div", { class: "stat-label", text: "Seyirlik server" }),
    h("div", { class: "stat" }, h("span", { class: `dot ${dot}` }), headline),
    h("p", { class: "muted", style: "margin:6px 0 0" }, detail),
    stuck?.id === "media-storage" || stuck?.id === "generated-storage"
      ? h(
          "div",
          { class: "actions", style: "margin-top:12px" },
          h("button", {
            class: "btn primary small",
            text: "Change the path",
            onclick: () =>
              jumpToSetting(
                stuck.id === "media-storage"
                  ? "SEYIRLIK_MEDIA_ROOT"
                  : "SEYIRLIK_GENERATED_STORAGE",
              ),
          }),
          h(
            "span",
            { class: "faint" },
            "Or reconnect the drive. The server retries on its own.",
          ),
        )
      : null,
    phases.length
      ? h(
          "div",
          { class: "rows", style: "margin-top:14px" },
          phases.map((p) =>
            h(
              "div",
              { class: "row" },
              h("span", {
                class: `dot ${p.state === "ready" ? "ok" : p.state === "degraded" ? "crit" : p.state === "pending" ? "" : "busy"}`,
              }),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "title" }, p.label),
                p.detail && p !== stuck
                  ? h("div", { class: "sub" }, p.detail)
                  : null,
              ),
              h(
                "span",
                { class: "faint" },
                p.state === "pending"
                  ? "waiting"
                  : `${p.state} · ${duration(p.elapsedMs)}${p.attempt ? ` · attempt ${p.attempt}` : ""}`,
              ),
            ),
          ),
        )
      : null,
  );
}

function renderServices(services) {
  if (!services) return h("p", { class: "empty" }, "No services configured.");
  if (services.error) return h("div", { class: "panel alert" }, services.error);
  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "rows" },
      services.map((s) => {
        const busy = state.busy.has(s.name);
        return h(
          "div",
          { class: "row" },
          h("span", { class: `dot ${busy ? "busy" : serviceDot(s.state)}` }),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title mono" }, s.name),
            h(
              "div",
              { class: "sub" },
              busy
                ? "Working…"
                : [
                    s.state,
                    s.startMode ? ` · ${s.startMode}` : "",
                    s.pid ? ` · pid ${s.pid}` : "",
                  ].join(""),
            ),
          ),
          h(
            "div",
            { class: "actions" },
            s.state !== "running"
              ? h("button", {
                  class: "btn small",
                  disabled: busy || s.state === "missing",
                  text: "Start",
                  onclick: () => serviceAction(s.name, "start"),
                })
              : null,
            h("button", {
              class: "btn small",
              disabled: busy || s.state === "missing",
              text: "Restart",
              onclick: () => serviceAction(s.name, "restart"),
            }),
            s.state === "running"
              ? h("button", {
                  class: "btn small danger",
                  disabled: busy,
                  text: "Stop",
                  onclick: () => serviceAction(s.name, "stop"),
                })
              : null,
          ),
        );
      }),
    ),
  );
}

async function serviceAction(name, action) {
  const verb = { start: "Start", stop: "Stop", restart: "Restart" }[action];
  if (
    action !== "start" &&
    !confirm(`${verb} ${name}? Anyone watching will be interrupted.`)
  )
    return;
  state.busy.add(name);
  render();
  try {
    await api("/api/services/action", {
      method: "POST",
      body: { name, action },
    });
    toast(`${name}: ${action} done.`);
  } catch (error) {
    toast(error.message, "err");
  } finally {
    state.busy.delete(name);
    await loadOverview();
    render();
  }
}

function renderPaths(paths) {
  if (!paths?.length) return h("p", { class: "empty" }, "No path settings.");
  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "rows" },
      paths.map((p) => {
        const ok = p.exists && (p.directory || p.file);
        const low =
          typeof p.free === "number" &&
          typeof p.size === "number" &&
          p.size > 0 &&
          p.free / p.size < 0.08;
        return h(
          "div",
          { class: "row" },
          h("span", { class: `dot ${ok ? (low ? "warn" : "ok") : "crit"}` }),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title" }, p.label),
            h("div", { class: "sub mono" }, p.path),
            ok && typeof p.free === "number"
              ? h(
                  "div",
                  {
                    class: `meter ${low ? "low" : ""}`,
                    title: `${bytes(p.free)} free of ${bytes(p.size)}`,
                  },
                  h("span", {
                    style: `width:${Math.max(2, 100 - (p.free / p.size) * 100).toFixed(1)}%`,
                  }),
                )
              : null,
          ),
          h(
            "span",
            { class: ok ? "faint" : "note err" },
            ok
              ? typeof p.free === "number"
                ? `${bytes(p.free)} free`
                : "found"
              : p.error || "Not found",
          ),
          h("button", {
            class: "btn ghost small",
            text: "Edit",
            onclick: () => jumpToSetting(p.key),
          }),
        );
      }),
    ),
  );
}

function renderDrives(drives) {
  if (drives?.error) return h("div", { class: "panel alert" }, drives.error);
  if (!drives?.length)
    return h(
      "p",
      { class: "empty" },
      state.session.platform === "dev"
        ? "Drives are only listed on Windows."
        : "No drives reported.",
    );
  return h(
    "div",
    { class: "grid" },
    drives.map((d) =>
      h(
        "div",
        { class: "panel" },
        h(
          "div",
          { class: "stat-label" },
          `${d.type}${d.fileSystem ? ` · ${d.fileSystem}` : ""}`,
        ),
        h(
          "div",
          { class: "stat" },
          d.id,
          d.label
            ? h(
                "span",
                { class: "muted", style: "font-size:14px;font-weight:600" },
                d.label,
              )
            : null,
        ),
        typeof d.size === "number"
          ? [
              h(
                "div",
                { class: "meter" },
                h("span", {
                  style: `width:${(100 - (d.free / d.size) * 100).toFixed(1)}%`,
                }),
              ),
              h(
                "div",
                { class: "faint", style: "margin-top:6px" },
                `${bytes(d.free)} free of ${bytes(d.size)}`,
              ),
            ]
          : h(
              "div",
              { class: "note warn" },
              "No size reported. The drive may be offline.",
            ),
      ),
    ),
  );
}

async function jumpToSetting(key) {
  state.tab = "settings";
  state.filter = key;
  render();
  await loadTab();
  render();
}

// ------------------------------------------------------------------ settings

function renderSettings() {
  const c = state.config;
  if (!c)
    return h(
      "section",
      {},
      h("h1", { text: "Settings" }),
      h("p", { class: "muted" }, "Loading…"),
    );
  const q = state.filter.trim().toLowerCase();
  const visible = c.entries.filter(
    (e) =>
      !q ||
      e.key.toLowerCase().includes(q) ||
      e.label.toLowerCase().includes(q) ||
      (e.value ?? "").toLowerCase().includes(q),
  );
  const groups = Object.keys(GROUP_LABELS)
    .map((id) => [
      id,
      visible.filter((e) => (GROUP_LABELS[e.group] ? e.group : "other") === id),
    ])
    .filter(([, list]) => list.length);

  const search = h("input", {
    class: "input search",
    type: "search",
    placeholder: "Filter settings",
    value: state.filter,
    "aria-label": "Filter settings",
    oninput: (event) => {
      state.filter = event.target.value;
      const pos = event.target.selectionStart;
      render();
      const again = document.querySelector(".search");
      again?.focus();
      again?.setSelectionRange(pos, pos);
    },
  });

  return h(
    "section",
    {},
    h("h1", { text: "Settings" }),
    h(
      "p",
      { class: "lede" },
      "Both env files the services load. Credentials are write-only: you can replace or remove one, but a stored value is never shown. The services read these files only when they start, so save with a restart.",
    ),
    h(
      "div",
      { class: "toolbar" },
      search,
      h("button", {
        class: "btn",
        text: "Add setting",
        onclick: openAddDialog,
      }),
      h("span", { class: "spacer", style: "flex:1" }),
      h("button", {
        class: "btn ghost small",
        text: "settings.env history",
        onclick: () => openHistory("settings"),
      }),
      h("button", {
        class: "btn ghost small",
        text: "secrets.env history",
        onclick: () => openHistory("secrets"),
      }),
    ),
    h(
      "p",
      { class: "faint", style: "margin:4px 0 0" },
      ["settings", "secrets"]
        .map(
          (f) => `${c.files[f].path}${c.files[f].exists ? "" : " (missing)"}`,
        )
        .join("   ·   "),
    ),
    c.missing?.length
      ? h(
          "p",
          { class: "note warn" },
          `Missing required settings: ${c.missing.join(", ")}. Use “Add setting”.`,
        )
      : null,
    groups.length === 0 ? h("p", { class: "empty" }, "Nothing matches.") : null,
    groups.map(([id, list]) => [
      h("h2", { text: GROUP_LABELS[id] }),
      h("div", { class: "panel" }, list.map(renderEntry)),
    ]),
  );
}

function entryId(e) {
  return `${e.file}:${e.key}`;
}

function renderEntry(e) {
  const pend = state.pending[e.file];
  const removing = pend.unset.has(e.key);
  const changed = Object.hasOwn(pend.set, e.key);
  const row = h("div", {
    class: `setting ${changed || removing ? "dirty" : ""}`,
    "data-id": entryId(e),
  });

  const markDirty = () => {
    row.classList.toggle(
      "dirty",
      Object.hasOwn(pend.set, e.key) || pend.unset.has(e.key),
    );
    updateSavebar();
  };
  const setValue = (value) => {
    if (
      !e.isNew &&
      !e.masked &&
      e.visibility === "visible" &&
      value === (e.value ?? "")
    )
      delete pend.set[e.key];
    else pend.set[e.key] = value;
    markDirty();
  };

  const notes = [];
  if (e.overridden)
    notes.push(
      h(
        "div",
        { class: "note warn" },
        "secrets.env also sets this, and that value wins.",
      ),
    );
  if (e.occurrences > 1)
    notes.push(
      h(
        "div",
        { class: "note warn" },
        `Appears ${e.occurrences} times; the last one wins. Saving writes it once.`,
      ),
    );
  if (e.warning) notes.push(h("div", { class: "note warn" }, e.warning));
  if (e.misplaced) notes.push(h("div", { class: "note warn" }, e.misplaced));

  let control;
  if (removing) {
    control = h(
      "div",
      { class: "line" },
      h("span", { class: "note err" }, "Will be removed"),
      h("button", {
        class: "btn ghost small",
        text: "Undo",
        onclick: () => {
          pend.unset.delete(e.key);
          render();
        },
      }),
    );
  } else if (
    (e.visibility !== "visible" || e.masked) &&
    !state.replacing.has(entryId(e)) &&
    !e.isNew
  ) {
    control = h(
      "div",
      { class: "line" },
      e.visibility === "secret"
        ? h(
            "span",
            { class: "secret-state" },
            h("span", { class: "lock" }, "Write-only"),
            e.empty ? "Empty" : "Set",
          )
        : h(
            "code",
            { class: "mono", style: "overflow-wrap:anywhere" },
            e.value,
          ),
      h("span", { style: "flex:1" }),
      h("button", {
        class: "btn small",
        text: "Replace",
        onclick: () => {
          state.replacing.add(entryId(e));
          render();
          document
            .querySelector(
              `[data-id="${CSS.escape(entryId(e))}"] input, [data-id="${CSS.escape(entryId(e))}"] textarea`,
            )
            ?.focus();
        },
      }),
      h("button", {
        class: "btn ghost small danger",
        text: "Remove",
        onclick: () => {
          pend.unset.add(e.key);
          delete pend.set[e.key];
          render();
        },
      }),
    );
  } else {
    const secret = e.visibility === "secret";
    const current = changed
      ? pend.set[e.key]
      : e.visibility === "visible" && !e.masked
        ? (e.value ?? "")
        : "";
    let input;
    if (e.kind === "enum" || e.kind === "bool") {
      const options =
        e.kind === "bool" ? ["true", "false"] : [...(e.values ?? [])];
      if (current && !options.includes(current)) options.unshift(current);
      input = h(
        "select",
        {
          class: "select",
          onchange: (ev) => setValue(ev.target.value),
          "aria-label": e.label,
        },
        e.isNew || current === ""
          ? h("option", { value: "", text: "(empty)" })
          : null,
        options.map((v) =>
          h("option", { value: v, text: v, selected: v === current }),
        ),
      );
    } else if (e.kind === "json") {
      input = h("textarea", {
        class: "textarea",
        spellcheck: "false",
        value: current,
        oninput: (ev) => setValue(ev.target.value),
        "aria-label": e.label,
      });
    } else {
      input = h("input", {
        class: `input ${e.kind === "text" && !secret ? "" : "mono"}`,
        type: secret ? "password" : "text",
        autocomplete: secret ? "new-password" : "off",
        spellcheck: "false",
        value: current,
        placeholder: secret || e.masked ? "Enter the new value" : "",
        oninput: (ev) => setValue(ev.target.value),
        "aria-label": e.label,
      });
    }
    const status = h("div", { class: "note" });
    const extras = [];
    if (secret) {
      extras.push(
        h("button", {
          class: "btn ghost small",
          text: "Show",
          onclick: (ev) => {
            input.type = input.type === "password" ? "text" : "password";
            ev.target.textContent = input.type === "password" ? "Show" : "Hide";
          },
        }),
      );
    }
    if (e.kind === "path") {
      extras.push(
        h("button", {
          class: "btn small",
          text: "Check",
          onclick: () => checkPath(input.value, status),
        }),
      );
    }
    if (e.kind === "json") {
      extras.push(
        h("button", {
          class: "btn ghost small",
          text: "Format",
          onclick: () => {
            try {
              input.value = JSON.stringify(JSON.parse(input.value));
              setValue(input.value);
              status.className = "note ok";
              status.textContent = "Valid JSON.";
            } catch (err) {
              status.className = "note err";
              status.textContent = err.message;
            }
          },
        }),
      );
    }
    if (state.replacing.has(entryId(e))) {
      extras.push(
        h("button", {
          class: "btn ghost small",
          text: "Cancel",
          onclick: () => {
            state.replacing.delete(entryId(e));
            delete pend.set[e.key];
            render();
          },
        }),
      );
    } else if (e.isNew) {
      extras.push(
        h("button", {
          class: "btn ghost small",
          text: "Discard",
          onclick: () => {
            delete pend.set[e.key];
            state.config.entries = state.config.entries.filter((x) => x !== e);
            render();
          },
        }),
      );
    } else {
      extras.push(
        h("button", {
          class: "btn ghost small danger",
          text: "Remove",
          onclick: () => {
            pend.unset.add(e.key);
            delete pend.set[e.key];
            render();
          },
        }),
      );
    }
    control = [h("div", { class: "line" }, input, extras), status];
  }

  row.append(
    h(
      "div",
      {},
      h(
        "div",
        { class: "name" },
        e.label,
        " ",
        e.file === "secrets"
          ? h("span", { class: "badge secrets" }, "secrets.env")
          : null,
        e.isNew ? h("span", { class: "badge" }, "new") : null,
      ),
      h("div", { class: "key" }, e.key),
      h("div", { class: "help" }, e.help),
    ),
    h("div", { class: "control" }, control, notes),
  );
  return row;
}

async function checkPath(value, status) {
  status.className = "note";
  status.textContent = "Checking…";
  try {
    const { paths } = await api("/api/paths/check", {
      method: "POST",
      body: { paths: [value] },
    });
    const p = paths[0];
    if (!p) {
      status.className = "note err";
      status.textContent = "Not an absolute path.";
    } else if (p.exists) {
      status.className = "note ok";
      status.textContent = `${p.directory ? "Folder" : "File"} found${typeof p.free === "number" ? `, ${bytes(p.free)} free` : ""}.`;
    } else {
      status.className = "note err";
      status.textContent =
        p.error ||
        "Not found. You can still save it, for example before reconnecting a drive.";
    }
  } catch (error) {
    status.className = "note err";
    status.textContent = error.message;
  }
}

function renderSavebar() {
  return h("div", { id: "savebar-slot" }, savebarContent());
}

function savebarContent() {
  const n = pendingCount();
  if (n === 0 || state.tab !== "settings") return null;
  return h(
    "div",
    { class: "savebar", role: "region", "aria-label": "Unsaved changes" },
    h("span", {}, `${n} unsaved change${n === 1 ? "" : "s"}`),
    h("button", {
      class: "btn ghost small",
      text: "Discard",
      onclick: () => {
        resetPending();
        render();
      },
    }),
    h("button", {
      class: "btn primary",
      text: "Review and save",
      onclick: openReview,
    }),
  );
}

function updateSavebar() {
  document
    .getElementById("savebar-slot")
    ?.replaceChildren(savebarContent() ?? "");
}

function resetPending() {
  state.pending = {
    settings: { set: {}, unset: new Set() },
    secrets: { set: {}, unset: new Set() },
  };
  state.replacing.clear();
  if (state.config)
    state.config.entries = state.config.entries.filter((e) => !e.isNew);
}

function changeFor(file) {
  const p = state.pending[file];
  return { set: { ...p.set }, unset: [...p.unset] };
}

function dialog(title, body, foot) {
  const el = h(
    "dialog",
    { "aria-label": title },
    h(
      "div",
      { class: "dialog-body" },
      h("h1", { text: title, style: "margin-top:0" }),
      body,
    ),
    h("div", { class: "dialog-foot" }, foot),
  );
  el.addEventListener("close", () => el.remove());
  document.body.append(el);
  el.showModal();
  return el;
}

async function openReview() {
  const files = ["settings", "secrets"].filter(
    (f) =>
      Object.keys(state.pending[f].set).length || state.pending[f].unset.size,
  );
  if (!state.overview) await loadOverview();
  let plans;
  try {
    plans = await Promise.all(
      files.map(async (file) => [
        file,
        await api("/api/config/plan", {
          method: "POST",
          body: { file, ...changeFor(file) },
        }),
      ]),
    );
  } catch (error) {
    toast(error.message, "err");
    return;
  }
  const errors = plans.flatMap(([, p]) => p.errors);
  const restartNames = state.overview?.restartOnApply ?? [];
  const restart = h("input", {
    type: "checkbox",
    id: "restart-after",
    checked: restartNames.length > 0,
  });
  const save = h("button", {
    class: "btn primary",
    text: "Save",
    disabled: errors.length > 0,
  });
  const cancel = h("button", { class: "btn ghost", text: "Cancel" });

  const body = plans.map(([file, p]) => [
    h("h2", { text: `${file}.env` }),
    p.diff.length
      ? h(
          "table",
          { class: "diff" },
          h(
            "tr",
            {},
            h("th", { text: "Setting" }),
            h("th", { text: "Before" }),
            h("th", { text: "After" }),
          ),
          p.diff.map((d) =>
            h(
              "tr",
              {},
              h("td", { class: "mono" }, d.key),
              h(
                "td",
                { class: "before mono" },
                d.action === "add" ? "—" : (d.before ?? "(hidden)"),
              ),
              h(
                "td",
                { class: "after mono" },
                d.action === "remove"
                  ? "removed"
                  : (d.after ?? "(new hidden value)"),
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, "No effective change."),
    p.errors.map((m) => h("p", { class: "note err" }, m)),
    p.warnings.map((m) => h("p", { class: "note warn" }, m)),
  ]);

  const el = dialog("Review changes", body, [
    restartNames.length
      ? h(
          "label",
          { class: "check grow", for: "restart-after" },
          restart,
          `Restart ${restartNames.join(" and ")} after saving`,
        )
      : h(
          "span",
          { class: "grow faint" },
          "Restart the services yourself for this to take effect.",
        ),
    cancel,
    save,
  ]);
  cancel.onclick = () => el.close();
  save.onclick = async () => {
    save.disabled = true;
    cancel.disabled = true;
    save.textContent = restart.checked ? "Saving and restarting…" : "Saving…";
    try {
      const results = [];
      for (let i = 0; i < plans.length; i++) {
        const [file] = plans[i];
        const last = i === plans.length - 1;
        results.push(
          await api("/api/config/apply", {
            method: "POST",
            body: {
              file,
              baseVersion: state.config.files[file].version,
              ...changeFor(file),
              restart: last && restart.checked,
            },
          }),
        );
        state.pending[file] = { set: {}, unset: new Set() };
      }
      el.close();
      resetPending();
      const restarted = results.flatMap((r) => r.restarted ?? []);
      const failed = restarted.filter((r) => !r.ok);
      const warnings = results.flatMap((r) => r.warnings ?? []);
      if (failed.length)
        toast(
          `Saved, but restart failed: ${failed.map((r) => `${r.name} (${r.error})`).join("; ")}`,
          "err",
        );
      else
        toast(
          restarted.length
            ? `Saved. Restarted ${restarted.map((r) => r.name).join(", ")}.`
            : `Saved.${warnings.length ? " " + warnings[0] : ""}`,
        );
      await Promise.all([loadConfig(), loadOverview()]);
      render();
    } catch (error) {
      save.disabled = false;
      cancel.disabled = false;
      save.textContent = "Save";
      if (error.status === 409) {
        await loadConfig();
        render();
      }
      toast(error.body?.errors?.join(" ") || error.message, "err");
    }
  };
}

function openAddDialog() {
  const c = state.config;
  const select = h(
    "select",
    { class: "select", "aria-label": "Setting" },
    h("option", { value: "", text: "Choose a setting…" }),
    Object.keys(GROUP_LABELS).map((g) => {
      const list = c.available.filter((a) => a.group === g);
      return list.length
        ? h(
            "optgroup",
            { label: GROUP_LABELS[g] },
            list.map((a) =>
              h("option", { value: a.key, text: `${a.label} — ${a.key}` }),
            ),
          )
        : null;
    }),
    h("option", { value: "__custom", text: "Another name…" }),
  );
  const custom = h("input", {
    class: "input mono",
    placeholder: "MY_SETTING",
    hidden: true,
    "aria-label": "Setting name",
  });
  const fileSel = h(
    "select",
    { class: "select", hidden: true, "aria-label": "File" },
    h("option", { value: "settings", text: "settings.env (visible)" }),
    h("option", { value: "secrets", text: "secrets.env (write-only)" }),
  );
  const error = h("p", { class: "note err" });
  select.onchange = () => {
    custom.hidden = fileSel.hidden = select.value !== "__custom";
    if (!custom.hidden) custom.focus();
  };
  const add = h("button", { class: "btn primary", text: "Add" });
  const cancel = h("button", { class: "btn ghost", text: "Cancel" });
  const el = dialog(
    "Add setting",
    [
      h(
        "div",
        {
          class: "control",
          style: "display:flex;flex-direction:column;gap:10px",
        },
        select,
        custom,
        fileSel,
        error,
      ),
    ],
    [cancel, add],
  );
  cancel.onclick = () => el.close();
  add.onclick = () => {
    let entry;
    if (select.value === "__custom") {
      const key = custom.value.trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
        return (error.textContent =
          "Use capital letters, digits and underscores.");
      if (c.entries.some((e) => e.key === key))
        return (error.textContent = "That setting already exists.");
      const secret =
        fileSel.value === "secrets" ||
        /(SECRET|PASSWORD|TOKEN|API_?KEY|_KEY$|CREDENTIAL|PRIVATE)/.test(key);
      entry = {
        key,
        label: key,
        group: secret ? "credentials" : "other",
        help: "Not in the catalogue.",
        file: secret ? "secrets" : "settings",
        kind: "text",
        visibility: secret ? "secret" : "visible",
      };
    } else {
      const spec = c.available.find((a) => a.key === select.value);
      if (!spec) return (error.textContent = "Choose a setting.");
      entry = { ...spec };
    }
    entry.isNew = true;
    entry.value = "";
    c.entries.push(entry);
    state.pending[entry.file].set[entry.key] = "";
    state.filter = "";
    el.close();
    render();
    document
      .querySelector(`[data-id="${CSS.escape(entryId(entry))}"]`)
      ?.scrollIntoView({ block: "center" });
    document
      .querySelector(
        `[data-id="${CSS.escape(entryId(entry))}"] input, [data-id="${CSS.escape(entryId(entry))}"] textarea, [data-id="${CSS.escape(entryId(entry))}"] select`,
      )
      ?.focus();
  };
}

async function openHistory(file) {
  let history;
  try {
    history = (await api(`/api/history?file=${file}`)).history;
  } catch (error) {
    return toast(error.message, "err");
  }
  const restartNames = state.overview?.restartOnApply ?? [];
  const close = h("button", { class: "btn ghost", text: "Close" });
  const el = dialog(
    `${file}.env history`,
    history.length
      ? h(
          "table",
          { class: "diff" },
          h(
            "tr",
            {},
            h("th", { text: "When" }),
            h("th", { text: "What" }),
            h("th", { text: "From" }),
            h("th", {}),
          ),
          history.map((entry) =>
            h(
              "tr",
              {},
              h("td", { title: entry.at }, new Date(entry.at).toLocaleString()),
              h(
                "td",
                {},
                entry.action === "restore"
                  ? "Restored an earlier version"
                  : "Changed",
                h(
                  "div",
                  { class: "faint mono" },
                  [
                    ...(entry.set ?? []),
                    ...(entry.unset ?? []).map((k) => `−${k}`),
                  ].join(", ") || "—",
                ),
              ),
              h("td", { class: "faint mono" }, entry.actor?.ip ?? ""),
              h(
                "td",
                {},
                entry.restorable
                  ? h("button", {
                      class: "btn small",
                      text: "Restore before this",
                      onclick: async (ev) => {
                        const restart =
                          restartNames.length > 0 &&
                          confirm(
                            `Restore ${file}.env to how it was before this change?\n\nOK restores and restarts ${restartNames.join(" and ")}. Cancel to stop here.`,
                          );
                        if (
                          !restart &&
                          !(
                            restartNames.length === 0 &&
                            confirm(
                              `Restore ${file}.env to how it was before this change?`,
                            )
                          )
                        )
                          return;
                        ev.target.disabled = true;
                        try {
                          await loadConfig();
                          await api("/api/history/restore", {
                            method: "POST",
                            body: {
                              file,
                              id: entry.historyId,
                              baseVersion: state.config.files[file].version,
                              restart,
                            },
                          });
                          el.close();
                          toast("Restored.");
                          await Promise.all([loadConfig(), loadOverview()]);
                          render();
                        } catch (error) {
                          ev.target.disabled = false;
                          toast(error.message, "err");
                        }
                      },
                    })
                  : null,
              ),
            ),
          ),
        )
      : h(
          "p",
          { class: "muted" },
          "No changes have been made through this dashboard yet.",
        ),
    [close],
  );
  close.onclick = () => el.close();
}

// ---------------------------------------------------------------------- logs

function renderLogs() {
  const logs = state.logs;
  return h(
    "section",
    {},
    h("h1", { text: "Logs" }),
    h("p", { class: "lede" }, "The end of each service log, newest first."),
    !logs
      ? h("p", { class: "muted" }, "Loading…")
      : logs.length === 0
        ? h("p", { class: "empty" }, "No log files found.")
        : null,
    logs?.length
      ? h(
          "div",
          { class: "toolbar" },
          h(
            "select",
            {
              class: "select search",
              "aria-label": "Log file",
              onchange: async (ev) => {
                state.logName = ev.target.value || null;
                state.logTail = null;
                render();
                if (state.logName)
                  await loadTail().catch((e) => toast(e.message, "err"));
                render();
              },
            },
            h("option", { value: "", text: "Choose a log…" }),
            logs.map((l) =>
              h("option", {
                value: l.name,
                selected: l.name === state.logName,
                text: `${l.name} · ${bytes(l.size)} · ${ago(l.modified)}`,
              }),
            ),
          ),
          state.logName
            ? h("button", {
                class: "btn small",
                text: "Refresh",
                onclick: async () => {
                  await loadTail().catch((e) => toast(e.message, "err"));
                  render();
                  scrollLog();
                },
              })
            : null,
          state.logName
            ? h(
                "label",
                { class: "check" },
                h("input", {
                  type: "checkbox",
                  checked: state.logFollow,
                  onchange: (ev) => {
                    state.logFollow = ev.target.checked;
                  },
                }),
                "Follow",
              )
            : null,
        )
      : null,
    state.logTail
      ? [
          state.logTail.truncated
            ? h(
                "p",
                { class: "faint" },
                `Showing the last part of ${bytes(state.logTail.size)}.`,
              )
            : null,
          h("pre", { class: "log-view" }, state.logTail.text || "(empty)"),
        ]
      : null,
  );
}

function scrollLog() {
  const view = document.querySelector(".log-view");
  if (view) view.scrollTop = view.scrollHeight;
}

// ------------------------------------------------------------------ activity

function renderActivity() {
  const list = state.activity;
  const describe = (a) => {
    if (a.action === "change")
      return `Changed ${a.file}.env: ${[...(a.set ?? []), ...(a.unset ?? []).map((k) => `removed ${k}`)].join(", ")}`;
    if (a.action === "restore")
      return `Restored ${a.file}.env (${(a.set ?? []).join(", ") || "no differences"})`;
    if (a.action?.startsWith("service-"))
      return `${a.action.slice(8)} ${a.service}${a.reason ? ` (${a.reason})` : ""}`;
    if (a.action === "login") return "Signed in";
    if (a.action === "login-failed") return "Failed sign-in";
    return a.action;
  };
  return h(
    "section",
    {},
    h("h1", { text: "Activity" }),
    h(
      "p",
      { class: "lede" },
      "Everything done through this dashboard. Values are never recorded, only which settings changed.",
    ),
    !list
      ? h("p", { class: "muted" }, "Loading…")
      : list.length === 0
        ? h("p", { class: "empty" }, "Nothing yet.")
        : null,
    list?.length
      ? h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "rows" },
            list.map((a) =>
              h(
                "div",
                { class: "row" },
                h("span", {
                  class: `dot ${a.action === "login-failed" ? "warn" : a.action?.startsWith("service-stop") ? "crit" : "ok"}`,
                }),
                h(
                  "div",
                  { class: "grow" },
                  h("div", { class: "title" }, describe(a)),
                  h(
                    "div",
                    { class: "sub" },
                    `${new Date(a.at).toLocaleString()} · ${a.actor?.ip ?? ""}`,
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

// --------------------------------------------------------------------- start

setInterval(async () => {
  if (document.hidden || !state.session?.authenticated) return;
  if (state.tab === "overview" && state.busy.size === 0) {
    await loadOverview();
    if (state.tab === "overview" && !document.querySelector("dialog[open]"))
      render();
  }
  if (state.tab === "logs" && state.logFollow && state.logName) {
    await loadTail().catch(() => {});
    if (state.tab === "logs") {
      render();
      scrollLog();
    }
  }
}, 10_000);

window.addEventListener("beforeunload", (event) => {
  if (pendingCount() > 0) event.preventDefault();
});

(async () => {
  await loadSession();
  await loadTab();
  render();
})();
