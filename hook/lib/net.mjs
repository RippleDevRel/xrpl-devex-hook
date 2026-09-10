// The only network primitive used by the client scripts: one JSON POST with a
// hard timeout. Never throws; returns { ok, status, body, error }.

export async function postJson(url, body, { headers = {}, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { ok: res.ok, status: res.status, body: parsed, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? `timeout after ${timeoutMs} ms` : String((err && err.message) || err);
    return { ok: false, status: 0, body: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { ok: res.ok, status: res.status, body: parsed, text, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? `timeout after ${timeoutMs} ms` : String((err && err.message) || err);
    return { ok: false, status: 0, body: null, text: "", error: msg };
  } finally {
    clearTimeout(timer);
  }
}
