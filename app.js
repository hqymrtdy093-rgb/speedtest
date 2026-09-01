// Paste your deployed Worker URL here.
const API_BASE = "https://speed-test.hqymrtdy093.workers.dev";

const $ = (id) => document.getElementById(id);
const state = { selectedServer: "AUTO", edge: null, running: false, phase: "idle", maxGaugeMbps: 250 };

function fmt(n, d = 1) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }
function api(path) { return `${API_BASE.replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}cb=${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function regionLabel(code) {
  const names = { AUTO: "Automatic", DE: "Germany", US: "United States", NL: "Netherlands", FR: "France", GB: "United Kingdom", TR: "Türkiye", AE: "United Arab Emirates" };
  return names[code] || code;
}
function regionFlag(code) {
  return ({ AUTO: "◎", DE: "🇩🇪", US: "🇺🇸", NL: "🇳🇱", FR: "🇫🇷", GB: "🇬🇧", TR: "🇹🇷", AE: "🇦🇪" })[code] || "◉";
}
function setProgress(percent, text) {
  const p = Math.max(0, Math.min(100, percent));
  $("meterBar").style.width = `${p}%`;
  $("meterProgress").textContent = text || `${Math.round(p)}%`;
}
function setGauge(mbps) {
  const speed = Math.max(0, Number(mbps) || 0);
  const ratio = Math.min(1, speed / state.maxGaugeMbps);
  const arc = $("gaugeArc");
  const needle = $("gaugeNeedle");
  arc.style.strokeDasharray = `${ratio * 100} 100`;
  const angle = -90 + ratio * 180;
  const rad = angle * Math.PI / 180;
  const x2 = 210 + Math.cos(rad) * 120;
  const y2 = 204 + Math.sin(rad) * 120;
  needle.setAttribute("x2", x2.toFixed(2));
  needle.setAttribute("y2", y2.toFixed(2));
  $("liveSpeed").textContent = fmt(speed, speed < 10 ? 2 : 1);
}
function renderServer() {
  const code = state.selectedServer;
  $("serverFlag").textContent = regionFlag(code);
  if (code === "AUTO") {
    const e = state.edge || {};
    $("serverName").textContent = e.colo ? `Automatic · ${e.colo}` : "Automatic";
    $("serverMeta").textContent = [e.city, e.countryName].filter(Boolean).join(", ") || "Nearest Cloudflare Edge";
    $("modeText").textContent = "Automatic";
    $("serverInfoValue").textContent = e.colo ? `Cloudflare Edge ${e.colo}` : "Cloudflare Edge";
    $("serverInfoNote").textContent = [e.city, e.countryName, e.asOrganization ? `AS${e.asn || ""} ${e.asOrganization}` : ""].filter(Boolean).join(" · ") || "Actual Cloudflare Edge";
  } else {
    $("serverName").textContent = regionLabel(code);
    $("serverMeta").textContent = "Selected preference · same Worker endpoint";
    $("modeText").textContent = regionLabel(code);
    $("serverInfoValue").textContent = `Cloudflare Edge ${state.edge?.colo || "—"}`;
    $("serverInfoNote").textContent = `Manual preference: ${regionLabel(code)} · actual Edge is shown above`;
  }
  document.querySelectorAll(".server-option").forEach((el) => el.classList.toggle("selected", el.dataset.server === code));
}
async function requestJson(path, options = {}) {
  const r = await fetch(api(path), { cache: "no-store", ...options });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}
async function getEdge() {
  const info = await requestJson("/edge");
  state.edge = info;
  renderServer();
  $("clientValue").textContent = [info.city, info.countryName].filter(Boolean).join(", ") || "Unknown";
  $("status").textContent = info.colo ? `Edge ${info.colo}` : "Ready";
}
async function measurePing(samples = 8) {
  const vals = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await requestJson("/ping");
    vals.push(performance.now() - t);
    setProgress((i + 1) / samples * 12, `Ping ${i + 1}/${samples}`);
  }
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const jitter = vals.reduce((a, v) => a + Math.abs(v - avg), 0) / vals.length;
  return { avg, jitter };
}
async function measureDownload(seconds = 8) {
  const started = performance.now();
  const deadline = started + seconds * 1000;
  let bytes = 0, lastPaint = started;
  while (performance.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, deadline - performance.now()));
    try {
      const r = await fetch(api("/download?mb=64"), { cache: "no-store", signal: controller.signal });
      if (!r.ok || !r.body) throw new Error(`Download HTTP ${r.status}`);
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        const now = performance.now();
        if (now - lastPaint >= 80) {
          const elapsed = Math.max(0.001, (now - started) / 1000);
          const mbps = bytes * 8 / elapsed / 1e6;
          setGauge(mbps); setProgress(12 + Math.min(43, elapsed / seconds * 43), `Download ${Math.round(elapsed)}s`);
          lastPaint = now;
        }
        if (now >= deadline) { await reader.cancel().catch(() => {}); break; }
      }
    } catch (e) { if (e.name !== "AbortError") throw e; }
    finally { clearTimeout(timer); }
  }
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  return bytes * 8 / elapsed / 1e6;
}
function makeUploadPayload(size = 1024 * 1024) {
  const bytes = new Uint8Array(size);
  if (crypto?.getRandomValues) {
    for (let offset = 0; offset < size; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)));
    }
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return bytes;
}
async function uploadOnce(payload, signal) {
  // text/plain is a CORS-safelisted content type, avoiding an OPTIONS preflight on GitHub Pages.
  const r = await fetch(api("/upload"), {
    method: "POST", body: payload, signal, cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=UTF-8" }
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch (_) {}
    throw new Error(`Upload HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
  }
  const result = await r.json();
  return Number(result.receivedBytes) || payload.byteLength;
}
async function measureUpload(seconds = 8) {
  const started = performance.now();
  const deadline = started + seconds * 1000;
  let bytes = 0;
  let failures = 0;
  while (performance.now() < deadline) {
    const tasks = Array.from({ length: 2 }, async () => {
      const payload = makeUploadPayload(1024 * 1024);
      const remaining = Math.max(1200, deadline - performance.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        return await uploadOnce(payload, controller.signal);
      } catch (e) {
        failures++;
        console.warn("Upload request failed", e);
        return 0;
      } finally { clearTimeout(timer); }
    });
    const batch = await Promise.all(tasks);
    bytes += batch.reduce((a, b) => a + b, 0);
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - started) / 1000);
    const mbps = bytes * 8 / elapsed / 1e6;
    setGauge(mbps);
    setProgress(55 + Math.min(43, elapsed / seconds * 43), `Upload ${Math.round(elapsed)}s`);
    if (failures >= 4 && bytes === 0) throw new Error("Upload requests are being blocked. Check Worker CORS/URL and HTTPS.");
  }
  const elapsed = Math.max(0.001, (performance.now() - started) / 1000);
  if (bytes === 0) throw new Error("No upload data reached the Worker.");
  return bytes * 8 / elapsed / 1e6;
}
function toggleMenu(force) {
  const menu = $("serverMenu"), button = $("serverButton");
  const open = typeof force === "boolean" ? force : !menu.classList.contains("open");
  menu.classList.toggle("open", open); button.setAttribute("aria-expanded", String(open));
}
function chooseServer(code) { state.selectedServer = code; renderServer(); toggleMenu(false); }
async function runTest() {
  if (state.running) return;
  state.running = true; $("start").disabled = true; setGauge(0); setProgress(0, "Starting");
  ["download", "upload", "ping", "jitter"].forEach(id => $(id).textContent = "—");
  try {
    $("phase").textContent = "Measuring latency…";
    const p = await measurePing();
    $("ping").textContent = fmt(p.avg, 0); $("jitter").textContent = fmt(p.jitter, 1);
    $("phase").textContent = "Measuring download…";
    const down = await measureDownload(); $("download").textContent = fmt(down, 2);
    setProgress(55, "Download complete");
    $("phase").textContent = "Measuring upload…";
    const up = await measureUpload(); $("upload").textContent = fmt(up, 2);
    setGauge(up); setProgress(100, "Complete"); $("phase").textContent = "Test complete";
  } catch (e) {
    console.error(e); $("phase").textContent = `Test failed: ${e.message || e}`;
  } finally { state.running = false; $("start").disabled = false; }
}
$("serverButton").addEventListener("click", () => toggleMenu());
document.querySelectorAll(".server-option").forEach((el) => el.addEventListener("click", () => chooseServer(el.dataset.server)));
document.addEventListener("click", (e) => { if (!e.target.closest(".server-select-wrap")) toggleMenu(false); });
$("start").addEventListener("click", runTest);

(function drawTicks() {
  const g = $("gaugeTicks");
  for (let i = 0; i <= 10; i++) {
    const a = (-90 + i * 18) * Math.PI / 180;
    const r1 = 137, r2 = i % 2 === 0 ? 147 : 142;
    const x1 = 210 + Math.cos(a) * r1, y1 = 204 + Math.sin(a) * r1;
    const x2 = 210 + Math.cos(a) * r2, y2 = 204 + Math.sin(a) * r2;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1); line.setAttribute("x2", x2); line.setAttribute("y2", y2); line.setAttribute("class", "tick"); g.appendChild(line);
  }
})();
setGauge(0);
(async function init() {
  if (API_BASE.includes("YOUR-WORKER")) { $("status").textContent = "Worker URL not configured"; $("phase").textContent = "Set API_BASE in app.js"; $("start").disabled = true; return; }
  try { await getEdge(); } catch (e) { $("status").textContent = "Worker offline"; $("phase").textContent = e.message || "Could not connect to Worker"; $("start").disabled = true; }
})();
