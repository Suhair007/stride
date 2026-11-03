# API and realtime protocol

The web app proxies `/api` and `/socket.io` to the Express server in development. All endpoints except `POST /api/auth/login`, `POST /api/auth/register`, and `GET /api/health` require:

```http
Authorization: Bearer <JWT>
```

The JWT identifies the user only. The server checks organization/tenant membership for every tenant-scoped request; a caller-provided tenant ID is never sufficient authorization.

## Authentication and workspaces

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Sign in with `{ "email", "password" }`; returns `{ "token", "user" }` |
| `POST` | `/api/auth/register` | Create an organization, first branch, admin, default board, and columns; accepts `{ "name", "email", "password", "organization", "branch" }` |
| `GET` | `/api/me` | Current user |
| `GET` | `/api/me/workspaces` | Organizations and only the branches the caller can access |
| `GET` | `/api/organizations` | Caller’s organization memberships |
| `POST` | `/api/organizations` | Create an organization, a `Main branch`, starter board and columns; body `{ "name" }`; caller becomes org admin |
| `GET` | `/api/organizations/:organizationId` | Read an organization the caller belongs to |
| `PATCH` | `/api/organizations/:organizationId` | Rename; org admin only |
| `DELETE` | `/api/organizations/:organizationId` | Delete the organization and its scoped data; org admin only |
| `GET` | `/api/organizations/:organizationId/tenants` | List accessible branches in the organization |
| `POST` | `/api/organizations/:organizationId/tenants` | Add a branch and starter board; org admin only; body `{ "name" }` |
| `GET` | `/api/tenants/:tenantId` | Read a branch the caller belongs to |
| `PATCH` | `/api/tenants/:tenantId` | Rename a branch; org/tenant admin |
| `DELETE` | `/api/tenants/:tenantId` | Delete a branch and its scoped data; org admin only |

## Tenant-scoped board APIs

All paths below start with `/api/tenants/:tenantId`. A missing membership returns `404 Workspace not found`.

| Method | Path | Purpose / permission |
| --- | --- | --- |
| `GET` | `/board` | Read the first board with ordered columns, tasks, and assignees; tenant member |
| `GET` | `/members` | List branch members (and org admins); tenant member |
| `GET` | `/activity` | Read the latest 50 activity entries; tenant member |
| `POST` | `/boards` | Create board with default columns; org/tenant admin |
| `PATCH` | `/boards/:boardId` | Rename a board; org/tenant admin |
| `DELETE` | `/boards/:boardId` | Delete a board; org/tenant admin |
| `POST` | `/boards/:boardId/columns` | Add a column with `{ "name", "color?" }`; org/tenant admin |
| `PATCH` | `/columns/:columnId` | Rename/recolor a column; org/tenant admin |
| `DELETE` | `/columns/:columnId` | Delete an empty column; org/tenant admin |
| `POST` | `/tasks` | Create a task; tenant member |
| `PATCH` | `/tasks/:taskId` | Edit task fields; tenant member; requires `If-Match` with current version |
| `PATCH` | `/tasks/:taskId/move` | Move/reorder a task; tenant member; requires the current `version` in its body |
| `DELETE` | `/tasks/:taskId` | Delete a task; tenant member |

Task creation accepts `title` (required), `columnId` (required), `description`, `priority` (`LOW`, `MEDIUM`, `HIGH`, `URGENT`), `dueDate` (ISO timestamp or `null`), and `assigneeId` (a member of this tenant or `null`). Task patch accepts the same editable fields except `columnId`. Move accepts `{ "columnId": "...", "position": 0, "version": 1 }`; the destination must belong to the same board and tenant.

## Stride Assistant Python service

The browser calls the authenticated Express endpoint; it never receives the internal service token or talks directly to FastAPI:

```http
POST /api/tenants/<tenant-id>/assistant/run
Authorization: Bearer <JWT>
Content-Type: application/json

{ "query": "Move Write launch email to In progress" }
```

Express validates the user's tenant membership, loads only that branch's board/activity, and forwards a bounded snapshot to FastAPI. FastAPI is an internal service and requires `Authorization: Bearer <AI_SERVICE_TOKEN>`. Its health check is `GET http://127.0.0.1:8000/health`.

The Python agent runs three read-only tools (`summarize_board`, `find_risks`, and `summarize_activity`) and may return a structured `proposed_action`. Supported action examples:

- `Create task: Write release notes in To do with high priority`
- `Move Write launch email to In progress`
- `Set priority of Write launch email to high`

Proposals include `confirmation_required: true`. FastAPI does not write to the database. The user must approve a proposal in the UI; then the browser calls the existing authenticated create/move/versioned-edit endpoint, which enforces tenant membership and concurrency rules. The deterministic agent currently uses no external LLM or provider API.

Example edit:

```http
PATCH /api/tenants/<tenant-id>/tasks/<task-id>
Authorization: Bearer <JWT>
If-Match: 3
Content-Type: application/json

{ "title": "Review the onboarding flow", "priority": "HIGH" }
```

Successful edits return `{ "task": { ..., "version": 4 } }`. Stale task versions return `409`. Serializable task moves retry transient PostgreSQL serialization failures (`40001` / Prisma `P2034`) up to two times; if concurrent changes still prevent the move, the API returns `409` and clients should reload the board. Invalid fields return `400`; missing/expired authentication returns `401`; an authenticated user without an administrative role receives `403`.

## Socket.IO

Connect to the same origin with the JWT in the Socket.IO auth payload:

```js
const socket = io(API_ORIGIN, { auth: { token } });
socket.emit("tenant:join", tenantId, (result) => {
  if (result.error) console.error(result.error);
});
```

Joining is authorized by the server, not by a client-selected room name. Joining a different tenant leaves the previous room first. An unauthorized join returns `{ "error": "You don't have access to this workspace." }`.

| Server event | Payload | Meaning |
| --- | --- | --- |
| `presence:update` | `[{ "id", "name", "email", "avatarColor" }]` | Current connected users in the joined tenant |
| `board:changed` | `{ "type", "taskId?" }` | Board data changed; reload the tenant board |
| `activity:created` | Activity object with public user fields | A new tenant activity entry |

The socket server broadcasts only to `tenant:<verified-tenant-id>`. Presence is ephemeral and scoped to one server process; it is not an authoritative user/session list.
