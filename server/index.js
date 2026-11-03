import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isSerializationConflict, withSerializationRetry } from "./transaction.js";

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET;
const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const agentServiceUrl = (process.env.AI_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const agentServiceToken = process.env.AI_SERVICE_TOKEN;

if (!jwtSecret) throw new Error("JWT_SECRET must be set in the environment.");
if (process.env.NODE_ENV === "production" && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters in production.");
}

const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, methods: ["GET", "POST"] },
});

app.disable("x-powered-by");
// maxAge lets browsers cache the CORS preflight instead of repeating it before every request.
app.use(cors({ origin: allowedOrigin, maxAge: 7200 }));
// Optional: `npm i compression` shrinks every JSON response. The server runs fine without it.
try {
  const { default: compression } = await import("compression");
  app.use(compression());
} catch { /* not installed */ }
httpServer.keepAliveTimeout = 65000;
app.use(express.json({ limit: "1mb" }));

// Remember which browser tab made each request, so realtime events can say who caused them.
const requestContext = new AsyncLocalStorage();
app.use((req, _res, next) => {
  const clientId = String(req.headers["x-client-id"] || "").slice(0, 80) || null;
  requestContext.run({ clientId }, next);
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const userFields = { id: true, name: true, email: true, avatarColor: true };
const defaultColumns = [
  { name: "Backlog", color: "#b3a5e8", position: 0 },
  { name: "To do", color: "#e5ad6b", position: 1 },
  { name: "In progress", color: "#7294e6", position: 2 },
  { name: "Done", color: "#6bbd9a", position: 3 },
];

function signToken(user) {
  return jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: "7d" });
}

function publicUser(user) {
  const { id, name, email, avatarColor } = user;
  return { id, name, email, avatarColor };
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    req.userId = jwt.verify(token, jwtSecret).sub;
    return next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
}

const requireAuth = [authenticate];

// Membership checks run on every tenant request and every socket join. Positive results are
// cached briefly so a burst of requests costs one query instead of one each.
const membershipCache = new Map();
const MEMBERSHIP_TTL_MS = 30_000;

async function findTenantMembership(userId, tenantId) {
  const key = `${userId}:${tenantId}`;
  const hit = membershipCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await prisma.membership.findFirst({
    where: {
      userId,
      OR: [
        { tenantId },
        { tenantId: null, role: "ORG_ADMIN", organization: { tenants: { some: { id: tenantId } } } },
      ],
    },
    select: { role: true, tenantId: true, organizationId: true },
  });
  if (value) {
    if (membershipCache.size > 5000) membershipCache.clear();
    membershipCache.set(key, { value, expires: Date.now() + MEMBERSHIP_TTL_MS });
  }
  return value;
}

const requireTenant = asyncRoute(async (req, res, next) => {
  const membership = await findTenantMembership(req.userId, req.params.tenantId);
  if (!membership) return res.status(404).json({ error: "Workspace not found." });
  req.membership = membership;
  return next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.membership.role)) {
      return res.status(403).json({ error: "You don't have permission to make that change." });
    }
    return next();
  };
}

async function logActivity(tx, { tenantId, userId, taskId, action, detail }) {
  return tx.activityLog.create({
    data: { tenantId, userId, taskId, action, detail },
    include: { user: { select: userFields } },
  });
}

function publish(tenantId, event, payload) {
  const origin = requestContext.getStore()?.clientId;
  const body = event === "board:changed" && origin ? { ...payload, origin } : payload;
  io.to(`tenant:${tenantId}`).emit(event, body);
}

function validate(schema, body, res) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Please check your input." });
    return null;
  }
  return parsed.data;
}

const authSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase().trim()),
  password: z.string().min(8).max(128),
});
const registerSchema = authSchema.extend({
  name: z.string().trim().min(2).max(60),
  organization: z.string().trim().min(2).max(60),
  branch: z.string().trim().min(2).max(60),
});
const taskSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
});
const taskPatchSchema = taskSchema.partial();
const reorderSchema = z.object({
  columnId: z.string().min(1),
  position: z.number().int().min(0),
  version: z.number().int().positive(),
});
const columnSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});
const agentQuerySchema = z.object({
  query: z.string().trim().min(1).max(600),
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const input = validate(authSchema, req.body, res);
  if (!input) return;
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    return res.status(401).json({ error: "That email and password don't match." });
  }
  return res.json({ token: signToken(user), user: publicUser(user) });
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const input = validate(registerSchema, req.body, res);
  if (!input) return;
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) return res.status(409).json({ error: "An account with that email already exists." });

  const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const passwordHash = await bcrypt.hash(input.password, 12);
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: input.organization, slug: `${slugify(input.organization)}-${Date.now().toString(36)}` },
    });
    const tenant = await tx.tenant.create({
      data: { organizationId: org.id, name: input.branch, slug: `${slugify(input.branch)}-${Date.now().toString(36)}` },
    });
    const user = await tx.user.create({ data: { name: input.name, email: input.email, passwordHash } });
    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, scopeKey: "ORG", role: "ORG_ADMIN" },
    });
    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, tenantId: tenant.id, scopeKey: tenant.id, role: "TENANT_ADMIN" },
    });
    const board = await tx.board.create({ data: { tenantId: tenant.id, name: "Team tasks" } });
    await tx.column.createMany({
      data: defaultColumns.map((column) => ({ ...column, tenantId: tenant.id, boardId: board.id })),
    });
    return user;
  });
  return res.status(201).json({ token: signToken(result), user: publicUser(result) });
}));

app.get("/api/me", requireAuth, asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: userFields });
  if (!user) return res.status(401).json({ error: "Account not found." });
  return res.json({ user });
}));

async function listWorkspaces(userId) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      organization: { include: { tenants: { orderBy: { name: "asc" } } } },
      tenant: true,
    },
  });
  const organizations = new Map();
  for (const membership of memberships) {
    const org = membership.organization;
    if (!organizations.has(org.id)) {
      organizations.set(org.id, {
        id: org.id, name: org.name, role: membership.role,
        tenants: membership.role === "ORG_ADMIN"
          ? org.tenants.map((tenant) => ({ id: tenant.id, name: tenant.name }))
          : [],
      });
    }
    const organization = organizations.get(org.id);
    if (membership.role === "ORG_ADMIN") {
      organization.role = "ORG_ADMIN";
      organization.tenants = org.tenants.map((tenant) => ({ id: tenant.id, name: tenant.name }));
    } else if (membership.tenant && !organization.tenants.some((tenant) => tenant.id === membership.tenant.id)) {
      organization.tenants.push({ id: membership.tenant.id, name: membership.tenant.name });
    }
  }
  return [...organizations.values()];
}

async function loadBoardFor(tenantId) {
  return prisma.board.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    include: {
      columns: {
        orderBy: { position: "asc" },
        include: {
          tasks: {
            orderBy: { position: "asc" },
            include: { assignee: { select: userFields } },
          },
        },
      },
    },
  });
}

async function loadActivities(tenantId) {
  return prisma.activityLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { user: { select: userFields } },
  });
}

async function loadMembers(tenantId, organizationId) {
  const memberships = await prisma.membership.findMany({
    where: {
      OR: [
        { tenantId },
        { tenantId: null, role: "ORG_ADMIN", organizationId },
      ],
    },
    select: { role: true, user: { select: userFields } },
    orderBy: { user: { name: "asc" } },
  });
  const unique = new Map(memberships.map(({ user, role }) => [user.id, { user, role }]));
  return [...unique.values()];
}

// Board, people and activity for one branch, fetched in parallel.
async function loadSnapshot(tenantId, organizationId) {
  const [board, activities, members] = await Promise.all([
    loadBoardFor(tenantId),
    loadActivities(tenantId),
    loadMembers(tenantId, organizationId),
  ]);
  return { board, activities, members };
}

app.get("/api/me/workspaces", requireAuth, asyncRoute(async (req, res) => {
  return res.json({ organizations: await listWorkspaces(req.userId) });
}));

// Everything the app needs for its first screen, in a single round trip.
app.get("/api/bootstrap", requireAuth, asyncRoute(async (req, res) => {
  const wantedTenant = String(req.query.tenantId || "");
  const wantedOrganization = String(req.query.organizationId || "");
  const [user, organizations] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId }, select: userFields }),
    listWorkspaces(req.userId),
  ]);
  if (!user) return res.status(401).json({ error: "Account not found." });
  let organization = organizations.find((org) => org.tenants.some((tenant) => tenant.id === wantedTenant));
  let tenant = organization?.tenants.find((item) => item.id === wantedTenant);
  if (!tenant) {
    organization = organizations.find((org) => org.id === wantedOrganization && org.tenants.length)
      || organizations.find((org) => org.tenants.length)
      || organizations[0]
      || null;
    tenant = organization?.tenants[0] || null;
  }
  const snapshot = tenant ? await loadSnapshot(tenant.id, organization.id) : null;
  return res.json({
    user,
    organizations,
    organizationId: organization?.id || null,
    tenantId: tenant?.id || null,
    snapshot,
  });
}));

app.get("/api/tenants/:tenantId/snapshot", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  return res.json(await loadSnapshot(req.params.tenantId, req.membership.organizationId));
}));

app.get("/api/organizations", requireAuth, asyncRoute(async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId },
    include: { organization: true },
  });
  const organizations = new Map();
  for (const { organization, role } of memberships) {
    const current = organizations.get(organization.id);
    if (!current || role === "ORG_ADMIN" || (role === "TENANT_ADMIN" && current.role === "MEMBER")) {
      organizations.set(organization.id, { ...organization, role });
    }
  }
  return res.json({ organizations: [...organizations.values()] });
}));

app.post("/api/organizations", requireAuth, asyncRoute(async (req, res) => {
  const name = z.string().trim().min(2).max(60).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: "Organization name must be between 2 and 60 characters." });
  const slug = `${name.data.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const organization = await prisma.$transaction(async (tx) => {
    const created = await tx.organization.create({ data: { name: name.data, slug } });
    await tx.membership.create({ data: { userId: req.userId, organizationId: created.id, scopeKey: "ORG", role: "ORG_ADMIN" } });
    const tenant = await tx.tenant.create({
      data: { organizationId: created.id, name: "Main branch", slug: `main-${Date.now().toString(36)}` },
    });
    await tx.membership.create({
      data: { userId: req.userId, organizationId: created.id, tenantId: tenant.id, scopeKey: tenant.id, role: "TENANT_ADMIN" },
    });
    const board = await tx.board.create({ data: { tenantId: tenant.id, name: "Team tasks" } });
    await tx.column.createMany({ data: defaultColumns.map((column) => ({ ...column, tenantId: tenant.id, boardId: board.id })) });
    return created;
  });
  return res.status(201).json({ organization, organizations: await listWorkspaces(req.userId) });
}));

app.get("/api/organizations/:organizationId", requireAuth, asyncRoute(async (req, res) => {
  const organization = await prisma.organization.findFirst({
    where: { id: req.params.organizationId, memberships: { some: { userId: req.userId } } },
  });
  if (!organization) return res.status(404).json({ error: "Organization not found." });
  return res.json({ organization });
}));

app.patch("/api/organizations/:organizationId", requireAuth, asyncRoute(async (req, res) => {
  const name = z.string().trim().min(2).max(60).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: "Organization name must be between 2 and 60 characters." });
  const membership = await prisma.membership.findFirst({
    where: { userId: req.userId, organizationId: req.params.organizationId, tenantId: null, role: "ORG_ADMIN" },
  });
  if (!membership) return res.status(403).json({ error: "Only an organization admin can rename it." });
  const organization = await prisma.organization.update({
    where: { id: membership.organizationId },
    data: { name: name.data },
  });
  return res.json({ organization });
}));

app.delete("/api/organizations/:organizationId", requireAuth, asyncRoute(async (req, res) => {
  const membership = await prisma.membership.findFirst({
    where: { userId: req.userId, organizationId: req.params.organizationId, tenantId: null, role: "ORG_ADMIN" },
  });
  if (!membership) return res.status(403).json({ error: "Only an organization admin can remove it." });
  const tenants = await prisma.tenant.findMany({ where: { organizationId: membership.organizationId }, select: { id: true } });
  await prisma.organization.delete({ where: { id: membership.organizationId } });
  membershipCache.clear();
  for (const tenant of tenants) io.in(`tenant:${tenant.id}`).disconnectSockets(true);
  return res.status(204).end();
}));

app.get("/api/organizations/:organizationId/tenants", requireAuth, asyncRoute(async (req, res) => {
  const admin = await prisma.membership.findFirst({
    where: { userId: req.userId, organizationId: req.params.organizationId, tenantId: null, role: "ORG_ADMIN" },
  });
  const memberships = admin ? null : await prisma.membership.findMany({
    where: { userId: req.userId, organizationId: req.params.organizationId, tenantId: { not: null } },
    include: { tenant: true },
  });
  if (!admin && !memberships?.length) return res.status(404).json({ error: "Organization not found." });
  const tenants = admin
    ? await prisma.tenant.findMany({ where: { organizationId: req.params.organizationId }, orderBy: { name: "asc" } })
    : memberships.map(({ tenant }) => tenant);
  return res.json({ tenants });
}));

app.post("/api/organizations/:organizationId/tenants", requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Branch name must be between 2 and 60 characters." });
  const admin = await prisma.membership.findFirst({
    where: { userId: req.userId, organizationId: req.params.organizationId, tenantId: null, role: "ORG_ADMIN" },
  });
  if (!admin) return res.status(403).json({ error: "Only an organization admin can add a branch." });
  const slug = `${input.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const tenant = await prisma.$transaction(async (tx) => {
    const created = await tx.tenant.create({ data: { organizationId: admin.organizationId, name: input.data.name, slug } });
    await tx.membership.create({
      data: { userId: req.userId, organizationId: admin.organizationId, tenantId: created.id, scopeKey: created.id, role: "TENANT_ADMIN" },
    });
    const board = await tx.board.create({ data: { tenantId: created.id, name: "Team tasks" } });
    await tx.column.createMany({ data: defaultColumns.map((column) => ({ ...column, tenantId: created.id, boardId: board.id })) });
    return created;
  });
  return res.status(201).json({ tenant, organizations: await listWorkspaces(req.userId) });
}));

app.get("/api/tenants/:tenantId", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Workspace not found." });
  return res.json({ tenant });
}));

app.patch("/api/tenants/:tenantId", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const name = z.string().trim().min(2).max(60).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: "Branch name must be between 2 and 60 characters." });
  const tenant = await prisma.tenant.update({ where: { id: req.params.tenantId }, data: { name: name.data } });
  publish(req.params.tenantId, "board:changed", { type: "tenant.updated" });
  return res.json({ tenant });
}));

app.delete("/api/tenants/:tenantId", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const membership = await prisma.membership.findFirst({
    where: {
      userId: req.userId,
      tenantId: null,
      organizationId: req.membership.organizationId,
      role: "ORG_ADMIN",
    },
  });
  if (!membership) return res.status(403).json({ error: "Only an organization admin can remove a branch." });
  await prisma.tenant.delete({ where: { id: req.params.tenantId } });
  membershipCache.clear();
  io.in(`tenant:${req.params.tenantId}`).disconnectSockets(true);
  return res.status(204).end();
}));

app.get("/api/tenants/:tenantId/board", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const board = await loadBoardFor(req.params.tenantId);
  if (!board) return res.status(404).json({ error: "This workspace doesn't have a board yet." });
  return res.json({ board });
}));

app.post("/api/tenants/:tenantId/boards", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const name = z.string().trim().min(1).max(80).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: "Board name must be between 1 and 80 characters." });
  const board = await prisma.$transaction(async (tx) => {
    const created = await tx.board.create({ data: { tenantId: req.params.tenantId, name: name.data } });
    await tx.column.createMany({ data: defaultColumns.map((column) => ({ ...column, tenantId: req.params.tenantId, boardId: created.id })) });
    return tx.board.findUnique({ where: { id: created.id }, include: { columns: { orderBy: { position: "asc" } } } });
  });
  publish(req.params.tenantId, "board:changed", { type: "board.created" });
  return res.status(201).json({ board });
}));

app.patch("/api/tenants/:tenantId/boards/:boardId", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const name = z.string().trim().min(1).max(80).safeParse(req.body?.name);
  if (!name.success) return res.status(400).json({ error: "Board name must be between 1 and 80 characters." });
  const result = await prisma.board.updateMany({ where: { id: req.params.boardId, tenantId: req.params.tenantId }, data: { name: name.data } });
  if (!result.count) return res.status(404).json({ error: "Board not found." });
  publish(req.params.tenantId, "board:changed", { type: "board.updated" });
  return res.json({ board: await prisma.board.findUnique({ where: { id: req.params.boardId } }) });
}));

app.delete("/api/tenants/:tenantId/boards/:boardId", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const result = await prisma.board.deleteMany({ where: { id: req.params.boardId, tenantId: req.params.tenantId } });
  if (!result.count) return res.status(404).json({ error: "Board not found." });
  publish(req.params.tenantId, "board:changed", { type: "board.deleted" });
  return res.status(204).end();
}));

app.post("/api/tenants/:tenantId/boards/:boardId/columns", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const input = validate(columnSchema, req.body, res);
  if (!input) return;
  const board = await prisma.board.findFirst({ where: { id: req.params.boardId, tenantId: req.params.tenantId } });
  if (!board) return res.status(404).json({ error: "Board not found." });
  const position = await prisma.column.count({ where: { boardId: board.id, tenantId: req.params.tenantId } });
  const column = await prisma.column.create({
    data: { ...input, boardId: board.id, tenantId: req.params.tenantId, position },
  });
  publish(req.params.tenantId, "board:changed", { type: "column.created" });
  return res.status(201).json({ column });
}));

app.patch("/api/tenants/:tenantId/columns/:columnId", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const input = validate(columnSchema.partial(), req.body, res);
  if (!input) return;
  const result = await prisma.column.updateMany({
    where: { id: req.params.columnId, tenantId: req.params.tenantId },
    data: input,
  });
  if (!result.count) return res.status(404).json({ error: "Column not found." });
  publish(req.params.tenantId, "board:changed", { type: "column.updated" });
  return res.json({ column: await prisma.column.findUnique({ where: { id: req.params.columnId } }) });
}));

app.delete("/api/tenants/:tenantId/columns/:columnId", requireAuth, requireTenant, requireRole("ORG_ADMIN", "TENANT_ADMIN"), asyncRoute(async (req, res) => {
  const column = await prisma.column.findFirst({
    where: { id: req.params.columnId, tenantId: req.params.tenantId },
    include: { _count: { select: { tasks: true } } },
  });
  if (!column) return res.status(404).json({ error: "Column not found." });
  if (column._count.tasks) return res.status(409).json({ error: "Move or delete this column's tasks before removing it." });
  await prisma.column.delete({ where: { id: column.id } });
  publish(req.params.tenantId, "board:changed", { type: "column.deleted" });
  return res.status(204).end();
}));

app.post("/api/tenants/:tenantId/tasks", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const input = validate(taskSchema, req.body, res);
  if (!input) return;
  const columnId = typeof req.body?.columnId === "string" ? req.body.columnId : "";
  const column = await prisma.column.findFirst({
    where: { id: columnId, tenantId: req.params.tenantId },
  });
  if (!column) return res.status(404).json({ error: "Column not found in this workspace." });
  if (input.assigneeId) {
    const member = await prisma.membership.findFirst({ where: { tenantId: req.params.tenantId, userId: input.assigneeId } });
    if (!member) return res.status(400).json({ error: "Choose a teammate from this workspace." });
  }
  const result = await prisma.$transaction(async (tx) => {
    const position = await tx.task.count({ where: { tenantId: req.params.tenantId, columnId: column.id } });
    const task = await tx.task.create({
      data: {
        tenantId: req.params.tenantId, boardId: column.boardId, columnId: column.id,
        title: input.title, description: input.description ?? "", priority: input.priority ?? "MEDIUM",
        dueDate: input.dueDate ? new Date(input.dueDate) : null, assigneeId: input.assigneeId ?? null, position,
      },
      include: { assignee: { select: userFields } },
    });
    const activity = await logActivity(tx, {
      tenantId: req.params.tenantId, userId: req.userId, taskId: task.id, action: "task.created",
      detail: `created "${task.title}"`,
    });
    return { task, activity };
  });
  publish(req.params.tenantId, "board:changed", { type: "task.created", taskId: result.task.id });
  publish(req.params.tenantId, "activity:created", result.activity);
  return res.status(201).json({ task: result.task });
}));

app.patch("/api/tenants/:tenantId/tasks/:taskId", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const input = validate(taskPatchSchema, req.body, res);
  if (!input) return;
  const version = z.number().int().positive().safeParse(Number(req.headers["if-match"] ?? req.body?.version));
  if (!version.success) return res.status(428).json({ error: "This update needs the task version. Refresh and try again." });
  const existing = await prisma.task.findFirst({
    where: { id: req.params.taskId, tenantId: req.params.tenantId },
    include: { assignee: { select: userFields } },
  });
  if (!existing) return res.status(404).json({ error: "Task not found." });
  if (input.assigneeId) {
    const member = await prisma.membership.findFirst({ where: { tenantId: req.params.tenantId, userId: input.assigneeId } });
    if (!member) return res.status(400).json({ error: "Choose a teammate from this workspace." });
  }
  const data = { ...input };
  if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;

  // Compare like with like so unchanged dates/values are not reported as edits.
  const changed = Object.keys(input).filter((key) => {
    if (key === "dueDate") {
      const before = existing.dueDate ? existing.dueDate.getTime() : null;
      const after = data.dueDate ? data.dueDate.getTime() : null;
      return before !== after;
    }
    return (existing[key] ?? null) !== (input[key] ?? null);
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const update = await tx.task.updateMany({
        where: { id: existing.id, tenantId: req.params.tenantId, version: version.data },
        data: { ...data, version: { increment: 1 } },
      });
      if (!update.count) return null;
      const task = await tx.task.findUnique({
        where: { id: existing.id },
        include: { assignee: { select: userFields } },
      });
      const activity = changed.length ? await logActivity(tx, {
        tenantId: req.params.tenantId, userId: req.userId, taskId: task.id, action: "task.updated",
        detail: `updated ${changed.join(", ")} on "${task.title}"`,
      }) : null;
      return { task, activity };
    });
    if (!result) return res.status(409).json({ error: "This task changed elsewhere. Your board is refreshing with the latest version." });
    publish(req.params.tenantId, "board:changed", { type: "task.updated", taskId: result.task.id });
    if (result.activity) publish(req.params.tenantId, "activity:created", result.activity);
    return res.json({ task: result.task });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return res.status(409).json({ error: "Another update happened at the same time. Please try again." });
    }
    throw error;
  }
}));

/*
 * Move / reorder a task.
 *
 * Conflict rules:
 *  - Only the task being moved is version-checked and version-bumped. Siblings that merely
 *    shift position keep their version, so reordering a column can no longer make another
 *    user's (or your own) in-flight edit or move on a neighbouring card fail with a 409.
 *  - The requested position is clamped to the destination list, so a drop "at the end" is
 *    always valid.
 *  - Real concurrent writers are still serialized by the Serializable transaction + retry.
 */
app.patch("/api/tenants/:tenantId/tasks/:taskId/move", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const input = validate(reorderSchema, req.body, res);
  if (!input) return;
  const { tenantId, taskId } = req.params;
  try {
    const result = await withSerializationRetry(() => prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, tenantId },
        include: { assignee: { select: userFields } },
      });
      if (!task) return { error: "Task not found.", status: 404 };
      if (task.version !== input.version) {
        return { error: "This task changed elsewhere. Your board is refreshing with the latest version.", status: 409 };
      }
      const destination = await tx.column.findFirst({
        where: { id: input.columnId, boardId: task.boardId, tenantId },
      });
      if (!destination) return { error: "Choose a column on this board.", status: 400 };

      const sameColumn = task.columnId === destination.id;
      const sourceTasks = await tx.task.findMany({
        where: { tenantId, columnId: task.columnId, id: { not: task.id } },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      const target = sameColumn ? sourceTasks : await tx.task.findMany({
        where: { tenantId, columnId: destination.id },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      const insertAt = Math.max(0, Math.min(input.position, target.length));
      target.splice(insertAt, 0, task);

      const reordered = [];
      if (!sameColumn) {
        sourceTasks.forEach((item, index) => {
          if (item.position !== index) reordered.push({ id: item.id, columnId: task.columnId, position: index });
        });
      }
      target.forEach((item, index) => {
        if (item.columnId !== destination.id || item.position !== index) {
          reordered.push({ id: item.id, columnId: destination.id, position: index });
        }
      });

      if (reordered.length) {
        const values = Prisma.join(reordered.map((item) => Prisma.sql`(
          ${item.id}::text,
          ${item.columnId}::text,
          ${item.position}::integer
        )`));
        await tx.$executeRaw(Prisma.sql`
          UPDATE "Task" AS t
          SET "columnId" = changes."columnId",
              position = changes.position,
              version = t.version + CASE WHEN t.id = ${task.id}::text THEN 1 ELSE 0 END,
              "updatedAt" = CASE WHEN t.id = ${task.id}::text THEN CURRENT_TIMESTAMP ELSE t."updatedAt" END
          FROM (VALUES ${values}) AS changes(id, "columnId", position)
          WHERE t.id = changes.id
            AND t."tenantId" = ${tenantId}::text
            AND t."boardId" = ${task.boardId}::text
        `);
      }
      // Nothing actually changed (a stale or duplicate request): answer without writing anything.
      if (!reordered.some((item) => item.id === task.id)) return { task, activity: null };
      // Build the response from what we just wrote instead of re-reading the row.
      const moved = {
        ...task,
        columnId: destination.id,
        position: target.findIndex((item) => item.id === task.id),
        version: task.version + 1,
        updatedAt: new Date(),
      };
      const activity = await logActivity(tx, {
        tenantId, userId: req.userId, taskId: task.id,
        action: "task.moved",
        detail: sameColumn
          ? `reordered "${task.title}" in ${destination.name}`
          : `moved "${task.title}" to ${destination.name}`,
      });
      return { task: moved, activity };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10000,
      timeout: 15000,
    }), { maxRetries: 3 });
    if (result.error) return res.status(result.status).json({ error: result.error });
    // Respond first so the caller is never kept waiting on the broadcast.
    res.json({ task: result.task });
    if (result.activity) {
      publish(tenantId, "board:changed", { type: "task.moved", taskId: result.task.id });
      publish(tenantId, "activity:created", result.activity);
    }
    return undefined;
  } catch (error) {
    if (isSerializationConflict(error)) {
      return res.status(409).json({ error: "The board changed during your move. It's refreshing with the latest version; please try again." });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
      console.error("Task move transaction exceeded its time limit.");
      return res.status(503).json({ error: "The board took too long to save that move. Please try again." });
    }
    throw error;
  }
}));

app.delete("/api/tenants/:tenantId/tasks/:taskId", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const task = await prisma.task.findFirst({ where: { id: req.params.taskId, tenantId: req.params.tenantId } });
  if (!task) return res.status(404).json({ error: "Task not found." });
  const activity = await prisma.$transaction(async (tx) => {
    const created = await logActivity(tx, {
      tenantId: req.params.tenantId, userId: req.userId, action: "task.deleted",
      detail: `deleted "${task.title}"`,
    });
    await tx.task.delete({ where: { id: task.id } });
    return created;
  });
  publish(req.params.tenantId, "board:changed", { type: "task.deleted", taskId: task.id });
  publish(req.params.tenantId, "activity:created", activity);
  return res.status(204).end();
}));

app.get("/api/tenants/:tenantId/activity", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  return res.json({ activities: await loadActivities(req.params.tenantId) });
}));

app.get("/api/tenants/:tenantId/members", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  return res.json({ members: await loadMembers(req.params.tenantId, req.membership.organizationId) });
}));

app.post("/api/tenants/:tenantId/assistant/run", requireAuth, requireTenant, asyncRoute(async (req, res) => {
  const input = validate(agentQuerySchema, req.body, res);
  if (!input) return;
  if (!agentServiceToken) {
    return res.status(503).json({ error: "The assistant isn't configured. Set AI_SERVICE_TOKEN in .env." });
  }
  const board = await prisma.board.findFirst({
    where: { tenantId: req.params.tenantId },
    orderBy: { createdAt: "asc" },
    include: {
      columns: {
        orderBy: { position: "asc" },
        include: {
          tasks: {
            orderBy: { position: "asc" },
            include: { assignee: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!board) return res.status(404).json({ error: "This workspace doesn't have a board yet." });
  const activities = await prisma.activityLog.findMany({
    where: { tenantId: req.params.tenantId },
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { user: { select: { name: true } } },
  });
  const agentInput = {
    query: input.query,
    board: {
      id: board.id,
      name: board.name,
      columns: board.columns.map((column) => ({
        id: column.id,
        name: column.name,
        position: column.position,
        tasks: column.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          position: task.position,
          version: task.version,
          dueDate: task.dueDate?.toISOString() ?? null,
          assignee: task.assignee,
        })),
      })),
    },
    activities: activities.map((activity) => ({
      action: activity.action,
      detail: activity.detail,
      createdAt: activity.createdAt.toISOString(),
      userName: activity.user.name,
    })),
  };
  try {
    const response = await fetch(`${agentServiceUrl}/v1/assistant/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentServiceToken}`,
      },
      body: JSON.stringify(agentInput),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      console.error(`Agent service returned HTTP ${response.status}.`);
      return res.status(502).json({ error: "The assistant couldn't analyze this board right now." });
    }
    return res.json(await response.json());
  } catch (error) {
    console.error("Agent service request failed:", error.message);
    return res.status(503).json({ error: "The assistant is unavailable. Check that the Python service is running." });
  }
}));

const presence = new Map();
const socketUserCache = new Map();

async function getSocketUser(userId) {
  const hit = socketUserCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.user;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userFields });
  if (user) {
    if (socketUserCache.size > 2000) socketUserCache.clear();
    socketUserCache.set(userId, { user, expires: Date.now() + 60_000 });
  }
  return user;
}

// The handshake only verifies the token (no database), so the connection opens immediately.
io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, jwtSecret);
    if (typeof payload.sub !== "string") return next(new Error("Please sign in again."));
    socket.data.userId = payload.sub;
    return next();
  } catch {
    return next(new Error("Please sign in again."));
  }
});

io.on("connection", (socket) => {
  socket.on("tenant:join", async (tenantId, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      if (typeof tenantId !== "string" || tenantId.length > 64) return reply({ error: "Invalid workspace." });
      const [membership, user] = await Promise.all([
        findTenantMembership(socket.data.userId, tenantId),
        getSocketUser(socket.data.userId),
      ]);
      if (!user) return reply({ error: "Account not found." });
      if (!membership) return reply({ error: "You don't have access to this workspace." });
      socket.data.user = user;
      if (socket.data.tenantId === tenantId) return reply({ ok: true });
      if (socket.data.tenantId) await leaveTenant(socket);
      socket.data.tenantId = tenantId;
      await socket.join(`tenant:${tenantId}`);
      if (!presence.has(tenantId)) presence.set(tenantId, new Map());
      const tenantPresence = presence.get(tenantId);
      tenantPresence.set(socket.id, socket.data.user);
      // Presence is per socket; collapse multiple tabs of the same user into one avatar.
      const unique = new Map([...tenantPresence.values()].map((person) => [person.id, person]));
      io.to(`tenant:${tenantId}`).emit("presence:update", [...unique.values()]);
      return reply({ ok: true });
    } catch (error) {
      console.error("tenant:join failed:", error.message);
      return reply({ error: "Couldn't join this workspace. Please try again." });
    }
  });
  socket.on("disconnect", () => { void leaveTenant(socket); });
});

async function leaveTenant(socket) {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return;
  socket.data.tenantId = null;
  await socket.leave(`tenant:${tenantId}`);
  const tenantPresence = presence.get(tenantId);
  tenantPresence?.delete(socket.id);
  if (tenantPresence?.size) {
    const unique = new Map([...tenantPresence.values()].map((user) => [user.id, user]));
    io.to(`tenant:${tenantId}`).emit("presence:update", [...unique.values()]);
  } else {
    presence.delete(tenantId);
    io.to(`tenant:${tenantId}`).emit("presence:update", []);
  }
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return res.status(409).json({ error: "That value is already in use." });
  }
  return res.status(500).json({ error: "Something went wrong. Please try again." });
});

httpServer.listen(port, () => {
  console.log(`Stride API and realtime server listening on http://localhost:${port}`);
  // Open the database connection now so the first real request doesn't pay for it.
  prisma.$connect().catch((error) => console.error("Database warm-up failed:", error.message));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await prisma.$disconnect();
    httpServer.close(() => process.exit(0));
  });
}