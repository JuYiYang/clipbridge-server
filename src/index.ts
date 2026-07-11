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

const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-clipbridge-device-id",
  };
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
