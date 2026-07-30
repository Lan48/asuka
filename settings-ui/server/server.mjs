import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFeatureMap,
  buildTemplate,
  getStatus,
  listWorkspaceDocs,
  prepareConfigForWrite,
  readConfig,
  readRedactedConfig,
  saveConfigPayload,
  saveWorkspaceDoc,
} from "./config-store.mjs";

const HOST = process.env.SETTINGS_UI_HOST || "127.0.0.1";
const PORT = Number(process.env.SETTINGS_UI_API_PORT || 18766);
const WEB_PORT = Number(process.env.SETTINGS_UI_WEB_PORT || 5175);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.resolve(MODULE_DIR, "..");
const DIST_DIR = path.join(SETTINGS_DIR, "dist");
const SERVE_STATIC = process.argv.includes("--static");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  const allowedOrigin = HOST === "0.0.0.0"
    ? `http://127.0.0.1:${WEB_PORT}`
    : `http://${HOST}:${WEB_PORT}`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(DIST_DIR, requested);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const resolved = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(resolved)) {
    res.writeHead(404);
    res.end("settings-ui dist not found; run npm run build first");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(resolved) });
  fs.createReadStream(resolved).pipe(res);
}

async function handleApi(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET" && url.pathname === "/api/config") {
    const redacted = readRedactedConfig();
    const original = readConfig();
    return sendJson(res, 200, {
      ...redacted,
      status: getStatus(original, redacted.meta.configPath),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/config/validate") {
    const body = await readBody(req);
    return sendJson(res, 200, prepareConfigForWrite(body));
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readBody(req);
    const saved = saveConfigPayload(body);
    return sendJson(res, saved.saved ? 200 : 422, saved);
  }
  if (req.method === "GET" && url.pathname === "/api/template") {
    return sendJson(res, 200, { template: buildTemplate(readConfig()) });
  }
  if (req.method === "GET" && url.pathname === "/api/feature-map") {
    return sendJson(res, 200, { features: buildFeatureMap(readConfig()) });
  }
  if (req.method === "GET" && url.pathname === "/api/workspace-docs") {
    return sendJson(res, 200, { docs: listWorkspaceDocs() });
  }
  if (req.method === "POST" && url.pathname === "/api/workspace-docs") {
    const body = await readBody(req);
    return sendJson(res, 200, saveWorkspaceDoc(body.name, body.content));
  }
  return sendJson(res, 404, { error: "not-found" });
}

const server = http.createServer(async (req, res) => {
  try {
    if ((req.url || "").startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    if (SERVE_STATIC) return serveStatic(req, res);
    sendJson(res, 404, { error: "api-only", hint: "run npm run dev to start Vite UI" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[settings-ui] API listening on http://${HOST}:${PORT}`);
  if (SERVE_STATIC) console.log(`[settings-ui] UI serving from ${DIST_DIR}`);
});
