// Paste your deployed Worker URL here.
const API_BASE = "https://speed-test.hqymrtdy093.workers.dev";

const $ = (id) => document.getElementById(id);
const state = { selectedServer: "AUTO", edge: null, running: false };

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }
function api(path) { return `${API_BASE}${path}${path.includes("?") ? "&" : "?"}cb=${Date.now()}-${Math.random()}`; }

async function requestJson(path, options = {}) {
  const r = await fetch(api(path), { cache: "no-store", ...options });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

function regionLabel(code) {
  const names = { DE: "🇩🇪 Germany", US: "🇺🇸 United States", NL: "🇳🇱 Netherlands", FR: "🇫🇷 France", GB: "🇬🇧 United Kingdom", TR: "🇹🇷 Türkiye", AE: "🇦🇪 UAE" };
  return names[code] || code;
}

function renderServer() {
  if (state.selectedServer === "AUTO") {
    const e = state.edge || {};
    $("serverName").textContent = e.colo ? `Automatic · ${e.colo}` : "Automatic";
    $("serverMeta").textContent = [e.city, e.countryName].filter(Boolean).join(", ") || "Cloudflare Edge";
    $("modeText").textContent = "Automatic";
    return;
  }
  $("serverName").textContent = regionLabel(state.selectedServer);
  $("serverMeta").textContent = "Preference selected · actual endpoint remains this Worker";
  $("modeText").textContent = regionLabel(state.selectedServer);
}

async function getEdge() {
  const info = await requestJson("/edge");
  state.edge = info;
  renderServer();
  $("edgeValue").textContent = info.colo || "—";
  $("clientValue").textContent = [info.city, info.countryName].filter(Boolean).join(", ") || "—";
  $("status").textContent = "Ready";
}

async function measurePing(samples = 8) {
  const vals = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await requestJson("/ping");
    vals.push(performance.now() - t);
  }
  const avg = vals.reduce((a,b) => a+b, 0) / vals.length;
  const jitter = vals.reduce((a,v) => a + Math.abs(v - avg), 0) / vals.length;
  return { avg, jitter };
}

async function measureDownload(seconds = 8) {
  const started = performance.now();
  const deadline = started + seconds * 1000;
  let bytes = 0;
  let lastPaint = started;

  while (performance.now() < deadline) {
    const controller = new AbortController();
    const remaining = Math.max(250, deadline - performance.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const r = await fetch(api("/download?mb=250"), { cache: "no-store", signal: controller.signal });
      if (!r.ok || !r.body) throw new Error(`Download HTTP ${r.status}`);
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        const now = performance.now();
        if (now - lastPaint >= 100) {
          paintLive(bytes * 8 / ((now - started) / 1000) / 1e6);
          lastPaint = now;
        }
        if (now >= deadline) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally { clearTimeout(timer); }
  }

  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return bytes * 8 / elapsed / 1e6;
}

function makeUploadPayload(size = 512 * 1024) {
  const buf = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(buf.subarray(offset, Math.min(offset + 65536, size)));
  }
  return buf;
}

async function measureUpload(seconds = 6) {
  const started = performance.now();
  const deadline = started + seconds * 1000;
  let bytes = 0;

  while (performance.now() < deadline) {
    const payload = makeUploadPayload();
    const remaining = Math.max(250, deadline - performance.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const r = await fetch(api("/upload"), {
        method: "POST",
        body: payload,
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!r.ok) throw new Error(`Upload HTTP ${r.status}`);
      const result = await r.json();
      bytes += Number(result.receivedBytes) || payload.byteLength;
      const now = performance.now();
      paintLive(bytes * 8 / ((now - started) / 1000) / 1e6);
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally { clearTimeout(timer); }
  }

  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return bytes * 8 / elapsed / 1e6;
}

function paintLive(mbps) {
  $("liveSpeed").textContent = `${fmt(mbps, 1)} Mbps`;
  $("meterBar").style.width = `${Math.min(100, Math.log10(Math.max(1, mbps)) / 3 * 100)}%`;
}

function openSelector() {
  const options = [
    ["AUTO", "Automatic · nearest Cloudflare Edge"],
    ["DE", "🇩🇪 Germany"], ["US", "🇺🇸 United States"], ["NL", "🇳🇱 Netherlands"],
    ["FR", "🇫🇷 France"], ["GB", "🇬🇧 United Kingdom"], ["TR", "🇹🇷 Türkiye"], ["AE", "🇦🇪 UAE"]
  ];
  const current = state.selectedServer;
  const choice = prompt("Select server preference:\n\n" + options.map(([c,n],i) => `${i+1}. ${n}`).join("\n"), String(options.findIndex(x => x[0] === current) + 1));
  const index = Number(choice) - 1;
  if (index >= 0 && index < options.length) {
    state.selectedServer = options[index][0];
    renderServer();
  }
}

async function runTest() {
  if (state.running) return;
  state.running = true;
  $("start").disabled = true;
  try {
    $("phase").textContent = "Measuring latency…";
    const p = await measurePing();
    $("ping").textContent = fmt(p.avg, 0);
    $("jitter").textContent = fmt(p.jitter, 1);

    $("phase").textContent = "Measuring download…";
    const down = await measureDownload();
    $("download").textContent = fmt(down, 2);

    $("phase").textContent = "Measuring upload…";
    const up = await measureUpload();
    $("upload").textContent = fmt(up, 2);

    paintLive(up);
    $("phase").textContent = "Test complete";
  } catch (e) {
    console.error(e);
    $("phase").textContent = `Test failed: ${e.message || e}`;
  } finally {
    state.running = false;
    $("start").disabled = false;
  }
}

$("modeButton").addEventListener("click", openSelector);
$("start").addEventListener("click", runTest);

(async function init() {
  if (API_BASE.includes("YOUR-WORKER")) {
    $("status").textContent = "Worker URL not configured";
    $("phase").textContent = "Set API_BASE in app.js";
    $("start").disabled = true;
    return;
  }
  try { await getEdge(); }
  catch (e) {
    $("status").textContent = "Worker offline";
    $("phase").textContent = e.message || "Could not connect to Worker";
    $("start").disabled = true;
  }
})();
