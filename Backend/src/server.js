// SPDX-License-Identifier: AGPL-3.0-or-later
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";

import authRoutes from "./routes/auth.js";
import accountsRoutes from "./routes/accounts.js";
import transactionsRoutes from "./routes/transactions.js";
import budgetsRoutes from "./routes/budgets.js";
import goalsRoutes from "./routes/goals.js";
import notesRoutes from "./routes/notes.js";
import categoriesRoutes from "./routes/categories.js";
import notificationsRoutes from "./routes/notifications.js";
import investmentsRoutes from "./routes/investments.js";
import plaidRoutes from "./routes/plaid.js";

const isProd = process.env.NODE_ENV === "production";

// Required-in-production env vars — fail fast if missing
const REQUIRED = ["JWT_SECRET", "ENCRYPTION_KEY", "DB_USER", "DB_PASSWORD", "DB_NAME"];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`FATAL: missing env var ${k}`); process.exit(1); }
}
if (isProd && !process.env.GOOGLE_CLIENT_ID) {
  console.error("FATAL: GOOGLE_CLIENT_ID is required in production");
  process.exit(1);
}
if (isProd && !process.env.ALLOWED_EMAILS) {
  console.warn("WARNING: ALLOWED_EMAILS is empty — anyone with a Google account can sign in!");
}
if (isProd && !process.env.CORS_ORIGIN) {
  console.error("FATAL: CORS_ORIGIN must be set in production");
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: isProd ? "info" : "debug",
    // Redact anything that looks like a secret to prevent leakage into logs.
    // Without this, Plaid SDK errors dump full request headers (including PLAID-SECRET).
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        // Axios/Plaid error shapes — strip request headers & body that may contain secrets
        'err.config.headers["PLAID-SECRET"]',
        'err.config.headers["PLAID-CLIENT-ID"]',
        'err.config.headers.authorization',
        'err.config.data',
        'err.request._header',
        'err.response.config.headers["PLAID-SECRET"]',
        'err.response.config.headers["PLAID-CLIENT-ID"]',
        'err.response.config.headers.authorization',
        'err.response.config.data',
      ],
      censor: "[REDACTED]",
    },
  },
  trustProxy: true,
  bodyLimit: 512 * 1024, // 512KB — tightened from 2MB
  disableRequestLogging: false,
});

// ── Security headers ─────────────────────────────────────────────
await app.register(helmet, {
  // CSP is handled at nginx (frontend) since it owns the document.
  // For API JSON responses, CSP is moot.
  contentSecurityPolicy: false,
  // Plaid Link loads in an iframe — don't break it.
  crossOriginEmbedderPolicy: false,
  // Plaid Link + Google Sign-In open popups that postMessage back to us.
  // "same-origin" (helmet default) blocks those messages. We need
  // "same-origin-allow-popups" so trusted popups can still communicate.
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  // Allow cross-origin embedding of resources (Google/Plaid SDKs)
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // Strict referrer policy
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  // HSTS — assume HTTPS termination at the reverse proxy
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Don't reveal we're using Fastify/node
  hidePoweredBy: true,
  frameguard: { action: "deny" },
});

// ── Rate limiting ────────────────────────────────────────────────
await app.register(rateLimit, {
  global: true,
  max: 200,                          // generous default
  timeWindow: "1 minute",
  hook: "preHandler",
  // Use Fastify's trust-proxy IP detection
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: (req, ctx) => ({
    error: "Too many requests",
    retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
  }),
});

// ── CORS — strict in production ──────────────────────────────────
const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
});

// ── JWT ──────────────────────────────────────────────────────────
await app.register(jwt, {
  secret: process.env.JWT_SECRET,
  sign:   { expiresIn: "30d" },
  verify: { maxAge: "30d" },
});

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: "utf8",
  runFirst: true,
});

app.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

// ── Production error mask — never leak stack traces ──────────────
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err, url: req.url }, "request error");
  const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  // For 4xx, surface the message (it's usually a client error like "Invalid email")
  // For 5xx in production, hide internals.
  if (code >= 500 && isProd) {
    return reply.code(500).send({ error: "Internal server error" });
  }
  reply.code(code).send({ error: err.message || "Error" });
});

app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

await app.register(authRoutes,         { prefix: "/api/auth" });
await app.register(accountsRoutes,     { prefix: "/api/accounts" });
await app.register(transactionsRoutes, { prefix: "/api/transactions" });
await app.register(budgetsRoutes,      { prefix: "/api/budgets" });
await app.register(goalsRoutes,        { prefix: "/api/goals" });
await app.register(notesRoutes,        { prefix: "/api/notes" });
await app.register(categoriesRoutes,   { prefix: "/api/categories" });
await app.register(notificationsRoutes,{ prefix: "/api/notifications" });
await app.register(investmentsRoutes,  { prefix: "/api/investments" });
await app.register(plaidRoutes,        { prefix: "/api/plaid" });

const port = Number(process.env.PORT || 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
