    // Set this after deploying the Worker.
const API_BASE = "https://speed-test.hqymrtdy093.workers.dev";

const $ = (id) => document.getElementById(id);
const start = $("start");
const phase = $("phase");
const status = $("status");
let serverInfo = null;

function fmt(n, d = 1) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

async function getEdge() {
  const r = await fetch(`${API_BASE}/edge?x=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error("Edge endpoint failed");
  return r.json();
}

function renderEdge(info) {
  serverInfo = info;
  const place = [info.city, info.countryName].filter(Boolean).join(", ");
  $("serverName").textContent = info.colo ? `Cloudflare Edge · ${info.colo}` : "Cloudflare Edge";
  $("serverMeta").textContent = place || "Automatic edge selection";
  $("edgeValue").textContent = info.colo || "—";
  $("clientValue").textContent = place || "—";
  status.textContent = "Ready";
}

async function measurePing(samples = 7) {
  const vals = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await fetch(`${API_BASE}/ping?i=${i}&t=${Date.now()}`, { cache: "no-store" });
    vals.push(performance.now() - t);
  }
  const avg = vals.reduce((a,b) => a+b, 0) / vals.length;
  const mean = avg;
  const variance = vals.reduce((s,v) => s + (v - mean) ** 2, 0) / vals.length;
  return { avg, jitter: Math.sqrt(variance) };
}

async function measureDownload(seconds = 7) {
  const targetMs = seconds * 1000;
  const controller = new AbortController();
  const started = performance.now();
  let bytes = 0;
  let lastPaint = started;
  const stopTimer = setTimeout(() => controller.abort(), targetMs);

  try {
    while (performance.now() - started < targetMs) {
      const stamp = Date.now();
      let r;
      try {
        r = await fetch(`${API_BASE}/download?mb=50&t=${stamp}`, { cache: "no-store", signal: controller.signal });
      } catch (e) {
        if (e.name === "AbortError") break;
        throw e;
      }
      if (!r.body) break;
      const reader = r.body.getReader();
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          const now = performance.now();
          if (now - lastPaint > 100) {
            const mbps = (bytes * 8) / ((now - started) / 1000) / 1e6;
            paintLive(mbps);
            lastPaint = now;
          }
          if (now - started >= targetMs) break;
        }
      } finally { reader.cancel().catch(()=>{}); }
    }
  } finally { clearTimeout(stopTimer); }

  return (bytes * 8) / ((performance.now() - started) / 1000) / 1e6;
}

function makeUploadPayload(size) {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf);
  return buf;
}

async function measureUpload(seconds = 6) {
  const started = performance.now();
  let bytes = 0;
  while (performance.now() - started < seconds * 1000) {
    const payload = makeUploadPayload(512 * 1024);
    const controller = new AbortController();
    const remaining = Math.max(500, seconds * 1000 - (performance.now() - started));
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      await fetch(`${API_BASE}/upload?t=${Date.now()}`, {
        method: "POST",
        body: payload,
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/octet-stream" },
      });
      bytes += payload.byteLength;
    } catch (e) {
      if (e.name !== "AbortError") throw e;
      break;
    } finally { clearTimeout(timer); }
  }
  return (bytes * 8) / ((performance.now() - started) / 1000) / 1e6;
}

function paintLive(mbps) {
  $("liveSpeed").textContent = `${fmt(mbps, 1)} Mbps`;
  $("meterBar").style.width = `${Math.min(100, Math.log10(Math.max(1, mbps)) / 3 * 100)}%`;
}

async function init() {
  try { renderEdge(await getEdge()); }
  catch (e) {
    status.textContent = "Worker URL not configured";
    phase.textContent = "Edit API_BASE in app.js first";
    start.disabled = true;
  }
}

start.addEventListener("click", async () => {
  start.disabled = true;
  try {
    phase.textContent = "Measuring latency…";
    const p = await measurePing();
    $("ping").textContent = fmt(p.avg, 0);
    $("jitter").textContent = fmt(p.jitter, 1);

    phase.textContent = "Measuring download…";
    const down = await measureDownload(7);
    $("download").textContent = fmt(down, 2);

    phase.textContent = "Measuring upload…";
    const up = await measureUpload(5);
    $("upload").textContent = fmt(up, 2);

    paintLive(down);
    phase.textContent = "Test complete";
  } catch (e) {
    console.error(e);
    phase.textContent = `Test failed: ${e.message || e}`;
  } finally {
    start.disabled = false;
  }
});

init();
