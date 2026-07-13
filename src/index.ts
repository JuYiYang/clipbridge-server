type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

interface Env {
  DB: D1Database;
  CLIPBRIDGE_TOKEN?: string;
  CLIPBRIDGE_MAX_BODY_BYTES?: string;
}

interface ClipboardContent {
  type: string;
  value: string;
}

interface ClipboardItem {
  id: string;
  title: string;
  application?: string | null;
  firstCopiedAt: string;
  lastCopiedAt: string;
  numberOfCopies: number;
  pin?: string | null;
  contents: ClipboardContent[];
  sourceDeviceID: string;
}

interface PushRequest {
  deviceID?: string;
  items?: ClipboardItem[];
}

interface ClipboardItemRow {
  id: string;
  title: string;
  application: string | null;
  first_copied_at: string;
  last_copied_at: string;
  number_of_copies: number;
  pin: string | null;
  contents_json: string;
  source_device_id: string;
  updated_at: number;
}

interface DeviceSummaryRow {
  source_device_id: string;
  item_count: number;
  last_updated_at: number;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_ADMIN_LIMIT = 100;
const MAX_ADMIN_LIMIT = 500;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/items")) {
    return adminItems(request, url, env);
  }

  if (url.pathname === "/v1/clipboard/items") {
    const auth = await authorize(request, env);
    if (!auth.ok) {
      return json({ error: "unauthorized" }, 401);
    }

    if (request.method === "POST") {
      return pushItems(request, env);
    }
    if (request.method === "GET") {
      return pullItems(url, env);
    }
  }

  return json({ error: "not_found" }, 404);
}

async function pushItems(request: Request, env: Env): Promise<Response> {
  const maxBodyBytes = parsePositiveInt(env.CLIPBRIDGE_MAX_BODY_BYTES) ?? MAX_BODY_BYTES;
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    return json({ error: "body_too_large" }, 413);
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    return json({ error: "body_too_large" }, 413);
  }

  const payload = parseJson<PushRequest>(body);
  if (!payload) {
    return json({ error: "invalid_json" }, 400);
  }

  const deviceID = typeof payload.deviceID === "string" ? payload.deviceID.trim() : "";
  if (!deviceID) {
    return json({ error: "device_id_required" }, 400);
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    return json({ accepted: 0, stored: 0, nextSince: cursorNow() });
  }

  let stored = 0;
  let nextSince = cursorNow();

  for (const rawItem of items) {
    const item = normalizeItem(deviceID, rawItem);
    if (!isValidItem(item)) {
      return json({ error: "invalid_item" }, 400);
    }

    const existing = await loadItem(env.DB, item.id);
    const merged = existing ? mergeItems(existing, item) : item;
    nextSince = cursorNow();
    await upsertItem(env.DB, merged, nextSince);
    stored += 1;
  }

  return json({ accepted: items.length, stored, nextSince }, 202);
}

async function pullItems(url: URL, env: Env): Promise<Response> {
  const sinceValue = url.searchParams.get("since") ?? "0";
  const since = Number(sinceValue);
  if (!Number.isFinite(since) || since < 0) {
    return json({ error: "invalid_since" }, 400);
  }

  const result = await env.DB.prepare(
    `SELECT id, title, application, first_copied_at, last_copied_at,
            number_of_copies, pin, contents_json, source_device_id, updated_at
       FROM clipboard_items
      WHERE updated_at > ?
      ORDER BY updated_at ASC, last_copied_at ASC`,
  )
    .bind(since)
    .all<ClipboardItemRow>();

  const rows = result.results ?? [];
  const items = rows.map(rowToItem);
  const nextSince = rows.length > 0 ? rows[rows.length - 1].updated_at : undefined;

  return json({ items, nextSince });
}

async function adminItems(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/" || url.pathname === "/admin") {
    return redirect("/admin/items");
  }

  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) {
    return unauthorizedAdmin();
  }

  const limit = clampAdminLimit(url.searchParams.get("limit"));
  const device = url.searchParams.get("device")?.trim() ?? "";

  const deviceSummary = await loadDeviceSummary(env.DB);
  const rows = await loadAdminRows(env.DB, limit, device);

  return html(renderAdminItemsPage(rows, deviceSummary, { device, limit }));
}

async function loadItem(db: D1Database, id: string): Promise<ClipboardItem | null> {
  const row = await db.prepare(
    `SELECT id, title, application, first_copied_at, last_copied_at,
            number_of_copies, pin, contents_json, source_device_id, updated_at
       FROM clipboard_items
      WHERE id = ?`,
  )
    .bind(id)
    .first<ClipboardItemRow>();

  return row ? rowToItem(row) : null;
}

async function loadAdminRows(db: D1Database, limit: number, device: string): Promise<ClipboardItemRow[]> {
  if (device) {
    const result = await db.prepare(
      `SELECT id, title, application, first_copied_at, last_copied_at,
              number_of_copies, pin, contents_json, source_device_id, updated_at
         FROM clipboard_items
        WHERE source_device_id = ?
        ORDER BY updated_at DESC, last_copied_at DESC
        LIMIT ?`,
    )
      .bind(device, limit)
      .all<ClipboardItemRow>();
    return result.results ?? [];
  }

  const result = await db.prepare(
    `SELECT id, title, application, first_copied_at, last_copied_at,
            number_of_copies, pin, contents_json, source_device_id, updated_at
       FROM clipboard_items
      ORDER BY updated_at DESC, last_copied_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<ClipboardItemRow>();
  return result.results ?? [];
}

async function loadDeviceSummary(db: D1Database): Promise<DeviceSummaryRow[]> {
  const result = await db.prepare(
    `SELECT source_device_id, COUNT(*) AS item_count, MAX(updated_at) AS last_updated_at
       FROM clipboard_items
      GROUP BY source_device_id
      ORDER BY last_updated_at DESC`,
  ).all<DeviceSummaryRow>();

  return result.results ?? [];
}

async function upsertItem(db: D1Database, item: ClipboardItem, updatedAt: number): Promise<void> {
  await db.prepare(
    `INSERT INTO clipboard_items (
       id, title, application, first_copied_at, last_copied_at,
       number_of_copies, pin, contents_json, source_device_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       application = excluded.application,
       first_copied_at = excluded.first_copied_at,
       last_copied_at = excluded.last_copied_at,
       number_of_copies = excluded.number_of_copies,
       pin = excluded.pin,
       contents_json = excluded.contents_json,
       source_device_id = excluded.source_device_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      item.id,
      item.title,
      item.application ?? null,
      item.firstCopiedAt,
      item.lastCopiedAt,
      item.numberOfCopies,
      item.pin ?? null,
      JSON.stringify(item.contents),
      item.sourceDeviceID,
      updatedAt,
    )
    .run();
}

function normalizeItem(deviceID: string, raw: ClipboardItem): ClipboardItem {
  const now = new Date().toISOString();
  const firstCopiedAt = validDate(raw.firstCopiedAt) ? raw.firstCopiedAt : now;
  const lastCopiedAt = validDate(raw.lastCopiedAt) ? raw.lastCopiedAt : firstCopiedAt;

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" ? raw.title : "",
    application: typeof raw.application === "string" ? raw.application : null,
    firstCopiedAt,
    lastCopiedAt,
    numberOfCopies: positiveInteger(raw.numberOfCopies) ? raw.numberOfCopies : 1,
    pin: typeof raw.pin === "string" ? raw.pin : null,
    contents: Array.isArray(raw.contents) ? raw.contents : [],
    sourceDeviceID: typeof raw.sourceDeviceID === "string" && raw.sourceDeviceID ? raw.sourceDeviceID : deviceID,
  };
}

function isValidItem(item: ClipboardItem): boolean {
  if (!item.id || !item.sourceDeviceID || item.contents.length === 0) {
    return false;
  }

  return item.contents.every(
    (content) =>
      content &&
      typeof content.type === "string" &&
      content.type.length > 0 &&
      typeof content.value === "string",
  );
}

function mergeItems(existing: ClipboardItem, incoming: ClipboardItem): ClipboardItem {
  return {
    ...incoming,
    title: incoming.title || existing.title,
    application: incoming.application ?? existing.application ?? null,
    firstCopiedAt: earlierDate(existing.firstCopiedAt, incoming.firstCopiedAt),
    lastCopiedAt: laterDate(existing.lastCopiedAt, incoming.lastCopiedAt),
    numberOfCopies: Math.max(existing.numberOfCopies, incoming.numberOfCopies),
    pin: incoming.pin ?? existing.pin ?? null,
  };
}

function rowToItem(row: ClipboardItemRow): ClipboardItem {
  return {
    id: row.id,
    title: row.title,
    application: row.application,
    firstCopiedAt: row.first_copied_at,
    lastCopiedAt: row.last_copied_at,
    numberOfCopies: row.number_of_copies,
    pin: row.pin,
    contents: parseJson<ClipboardContent[]>(row.contents_json) ?? [],
    sourceDeviceID: row.source_device_id,
  };
}

async function authorize(request: Request, env: Env): Promise<{ ok: boolean }> {
  const token = env.CLIPBRIDGE_TOKEN;
  if (!token) {
    return { ok: true };
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return { ok: false };
  }

  const provided = header.slice("Bearer ".length).trim();
  return { ok: await timingSafeEqual(provided, token) };
}

async function authorizeAdmin(request: Request, env: Env): Promise<{ ok: boolean }> {
  const token = env.CLIPBRIDGE_TOKEN;
  if (!token) {
    return { ok: true };
  }

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const provided = header.slice("Bearer ".length).trim();
    return { ok: await timingSafeEqual(provided, token) };
  }

  if (header.startsWith("Basic ")) {
    const credentials = decodeBasicCredentials(header.slice("Basic ".length).trim());
    if (!credentials) {
      return { ok: false };
    }
    return { ok: await timingSafeEqual(credentials.password, token) };
  }

  return { ok: false };
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < leftBytes.length && i < rightBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }
  return diff === 0;
}

function json(value: JsonValue | Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function unauthorizedAdmin(): Response {
  return new Response(renderAdminUnauthorizedPage(), {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="ClipBridge Admin", charset="UTF-8"',
    },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-clipbridge-device-id",
  };
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    .header { display: flex; gap: 24px; justify-content: space-between; align-items: end; padding: 28px 32px 18px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
    .eyebrow { margin: 0 0 4px; color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; }
    h1 { margin: 0; font-size: 30px; }
    h2 { margin: 0 0 8px; font-size: 17px; overflow-wrap: anywhere; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
    .filters label { display: grid; gap: 4px; font-size: 12px; color: color-mix(in srgb, CanvasText 58%, transparent); }
    select, input, button { min-height: 32px; border-radius: 7px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: Canvas; color: CanvasText; padding: 0 10px; }
    button { font-weight: 600; cursor: pointer; }
    .stats, .devices { display: flex; gap: 12px; padding: 16px 32px 0; flex-wrap: wrap; }
    .stats div, .device { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: 12px 14px; text-decoration: none; color: inherit; background: color-mix(in srgb, CanvasText 3%, transparent); }
    .stats strong { display: block; font-size: 22px; }
    .stats span, .device small, .muted, .meta, .times, .id, label { color: color-mix(in srgb, CanvasText 56%, transparent); }
    .device { display: grid; gap: 4px; min-width: 220px; }
    .device span { overflow-wrap: anywhere; }
    .items { display: grid; gap: 14px; padding: 18px 32px 32px; }
    .item { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: 16px; background: color-mix(in srgb, CanvasText 2%, transparent); }
    .item-main { display: flex; gap: 16px; justify-content: space-between; }
    .meta, .times { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .times { justify-content: end; text-align: right; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 650; }
    .content { margin-top: 12px; display: grid; gap: 6px; }
    .content-type { font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
    pre { margin: 0; max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 7px; padding: 10px; background: color-mix(in srgb, CanvasText 7%, transparent); }
    .id { margin: 12px 0 0; font-size: 12px; overflow-wrap: anywhere; }
    .empty { margin: 32px; padding: 32px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; }
    @media (max-width: 760px) { .header, .item-main { display: grid; } .times { justify-content: start; text-align: left; } }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderAdminUnauthorizedPage(): string {
  return renderPage("ClipBridge Admin", `
    <section class="empty">
      <h1>ClipBridge Admin</h1>
      <p>请输入访问凭证。用户名可填写 <code>clipbridge</code>，密码填写服务端的 <code>CLIPBRIDGE_TOKEN</code>。</p>
    </section>
  `);
}

function renderAdminItemsPage(
  rows: ClipboardItemRow[],
  devices: DeviceSummaryRow[],
  options: { device: string; limit: number },
): string {
  const activeDevice = options.device;
  const totalItems = devices.reduce((sum, device) => sum + Number(device.item_count), 0);
  const deviceOptions = [
    `<option value=""${activeDevice ? "" : " selected"}>All devices</option>`,
    ...devices.map((device) => {
      const value = escapeHtml(device.source_device_id);
      const selected = device.source_device_id === activeDevice ? " selected" : "";
      return `<option value="${value}"${selected}>${value} (${device.item_count})</option>`;
    }),
  ].join("");

  return renderPage("ClipBridge Admin", `
    <header class="header">
      <div>
        <p class="eyebrow">ClipBridge Server</p>
        <h1>同步记录</h1>
      </div>
      <form class="filters" method="get" action="/admin/items">
        <label>
          <span>设备</span>
          <select name="device">${deviceOptions}</select>
        </label>
        <label>
          <span>数量</span>
          <input type="number" name="limit" min="1" max="${MAX_ADMIN_LIMIT}" value="${options.limit}">
        </label>
        <button type="submit">刷新</button>
      </form>
    </header>

    <section class="stats">
      <div><strong>${totalItems}</strong><span>总记录</span></div>
      <div><strong>${devices.length}</strong><span>设备数</span></div>
      <div><strong>${rows.length}</strong><span>当前显示</span></div>
    </section>

    <section class="devices">
      ${devices.map(renderDeviceSummary).join("") || `<p class="muted">暂无设备记录</p>`}
    </section>

    <main class="items">
      ${rows.map(renderAdminRow).join("") || `<section class="empty"><h2>暂无同步记录</h2><p>客户端成功上传后，这里会显示记录。</p></section>`}
    </main>
  `);
}

function renderDeviceSummary(device: DeviceSummaryRow): string {
  return `
    <a class="device" href="/admin/items?device=${encodeURIComponent(device.source_device_id)}">
      <span>${escapeHtml(device.source_device_id)}</span>
      <strong>${device.item_count}</strong>
      <small>${formatCursor(device.last_updated_at)}</small>
    </a>
  `;
}

function renderAdminRow(row: ClipboardItemRow): string {
  const contents = parseJson<ClipboardContent[]>(row.contents_json) ?? [];
  return `
    <article class="item">
      <div class="item-main">
        <div>
          <h2>${escapeHtml(row.title || "(Untitled)")}</h2>
          <p class="meta">
            <span>设备 ${escapeHtml(row.source_device_id)}</span>
            <span>应用 ${escapeHtml(row.application ?? "-")}</span>
            <span>复制 ${row.number_of_copies}</span>
          </p>
        </div>
        <div class="times">
          <span>更新 ${formatCursor(row.updated_at)}</span>
          <span>最近复制 ${escapeHtml(row.last_copied_at)}</span>
        </div>
      </div>
      <details>
        <summary>内容和值 (${contents.length})</summary>
        ${contents.map(renderContent).join("")}
      </details>
      <p class="id">${escapeHtml(row.id)}</p>
    </article>
  `;
}

function renderContent(content: ClipboardContent): string {
  const decoded = decodeClipboardValue(content.value);
  return `
    <section class="content">
      <div class="content-type">${escapeHtml(content.type)}</div>
      <label>文本预览</label>
      <pre>${escapeHtml(decoded.preview)}</pre>
      <label>原始值 Base64</label>
      <pre>${escapeHtml(shorten(content.value, 4000))}</pre>
    </section>
  `;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function clampAdminLimit(value: string | null): number {
  const parsed = value ? Number(value) : DEFAULT_ADMIN_LIMIT;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ADMIN_LIMIT;
  }
  return Math.min(MAX_ADMIN_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function decodeBasicCredentials(value: string): { username: string; password: string } | null {
  try {
    const decoded = atob(value);
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return null;
    }
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function decodeClipboardValue(value: string): { preview: string } {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (isReadableText(text)) {
      return { preview: shorten(text, 4000) };
    }
  } catch {
    // Fall through to a base64-only preview.
  }

  return { preview: "(binary or non-UTF-8 value)" };
}

function isReadableText(value: string): boolean {
  if (!value) {
    return true;
  }

  let readable = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32) {
      readable += 1;
    }
  }
  return readable / value.length > 0.9;
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function formatCursor(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return new Date(value * 1000).toISOString();
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cursorNow(): number {
  return Date.now() / 1000;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function earlierDate(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterDate(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
