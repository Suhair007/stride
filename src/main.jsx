import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Activity, ArrowRight, ArrowUp, Bell, Building2, CalendarDays, Check, Eye, EyeOff,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Command, GitBranch,
  LayoutGrid, ListFilter, LogOut, MessageCircle, MoreHorizontal, Plus, Redo2, Search, Settings2,
  Sparkles, Trash2, Undo2, Users, X, Zap,
} from "lucide-react";
import {
  DndContext, DragOverlay, PointerSensor, closestCorners, pointerWithin,
  useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { io } from "socket.io-client";
import "./styles.css";
import AuthVisual from "./AuthVisual";
import "./auth-visual.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const avatarPalette = ["#8979d4", "#d78871", "#55a28a", "#d5a248", "#7799ce"];
const priorityLabels = { LOW: "Low", MEDIUM: "Normal", HIGH: "High", URGENT: "Urgent" };
const COLLAPSE_QUERY = "(max-width: 800px)";
// Rename the product in one place: the logo, auth screens and copy all read from here.
const APP_NAME = "Stride";
const APP_MARK = APP_NAME.slice(0, 1).toLowerCase();
// Storage keys keep their original names so people who are already signed in stay signed in.
const CACHE_KEY = "orbit-cache-v1";

// The last session snapshot. It lets the board paint instantly while fresh data loads behind it.
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.user && Array.isArray(parsed.organizations) && parsed.tenantId ? parsed : null;
  } catch {
    return null;
  }
}

const priorityDot = (level) => <span className={`priority-dot priority-${level}`} />;
const taskPriorityOptions = [
  { value: "LOW", label: "Low", leading: priorityDot("low") },
  { value: "MEDIUM", label: "Normal", leading: priorityDot("medium") },
  { value: "HIGH", label: "High", leading: priorityDot("high") },
  { value: "URGENT", label: "Urgent", leading: priorityDot("urgent") },
];
const priorityFilterOptions = [{ value: "ALL", label: "All priorities" }, ...taskPriorityOptions];
const dialogIcons = { branch: GitBranch, organization: Building2, column: LayoutGrid, trash: Trash2, help: CircleHelp };
// Identifies this browser tab, so the server can tell us "you made this change" and we skip a pointless reload.
const CLIENT_ID = (globalThis.crypto?.randomUUID?.() ?? `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

// Pure helper: returns a copy of the board with one card relocated, plus where it came from.
function relocateTask(board, taskId, destinationId, index) {
  const next = structuredClone(board);
  const source = next.columns.find((column) => column.tasks.some((task) => task.id === taskId));
  const destination = next.columns.find((column) => column.id === destinationId);
  if (!source || !destination) return null;
  const fromPosition = source.tasks.findIndex((task) => task.id === taskId);
  const [moving] = source.tasks.splice(fromPosition, 1);
  const toPosition = Math.max(0, Math.min(index, destination.tasks.length));
  moving.columnId = destination.id;
  destination.tasks.splice(toPosition, 0, moving);
  source.tasks.forEach((task, i) => { task.position = i; });
  destination.tasks.forEach((task, i) => { task.position = i; });
  return { next, fromColumn: source.id, fromPosition, toColumn: destination.id, toPosition };
}

async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${API_URL}/api${path}`, {
    ...options,
    headers: {
      "X-Client-Id": CLIENT_ID,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function initials(name = "") {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function friendlyDate(value) {
  if (!value) return null;
  const date = new Date(value);
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((target - day) / 86400000);
  if (days === 0) return { label: "Today", tone: "today" };
  if (days === 1) return { label: "Tomorrow", tone: "soon" };
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "overdue" };
  return { label: date.toLocaleDateString("en", { month: "short", day: "numeric" }), tone: "" };
}

// Prefer whatever the pointer is actually over; fall back to the nearest corners.
function collisionStrategy(args) {
  const pointer = pointerWithin(args);
  return pointer.length ? pointer : closestCorners(args);
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("orbit-token"));
  const [cached] = useState(() => (localStorage.getItem("orbit-token") ? readCache() : null));
  const [user, setUser] = useState(cached?.user ?? null);
  const [organizations, setOrganizations] = useState(cached?.organizations ?? []);
  const [organizationId, setOrganizationId] = useState(cached?.organizationId ?? localStorage.getItem("orbit-org"));
  const [tenantId, setTenantId] = useState(cached?.tenantId ?? localStorage.getItem("orbit-tenant"));
  const [board, setBoard] = useState(cached?.snapshot?.board ?? null);
  const [members, setMembers] = useState(cached?.snapshot?.members ?? []);
  const [presence, setPresence] = useState([]);
  const [activities, setActivities] = useState(cached?.snapshot?.activities ?? []);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const [activeTask, setActiveTask] = useState(null);
  const [overlayWidth, setOverlayWidth] = useState(null);
  const [detailTask, setDetailTask] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantQuery, setAssistantQuery] = useState("");
  const [assistantResponse, setAssistantResponse] = useState(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [assistantActionResult, setAssistantActionResult] = useState("");
  const [showNewTask, setShowNewTask] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(COLLAPSE_QUERY).matches);
  const [authMode, setAuthMode] = useState("login");
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  const socketRef = useRef(null);
  const refreshTimer = useRef(null);
  const noticeTimer = useRef(null);
  // Always-current board so queued async work never reads a stale closure.
  const boardRef = useRef(cached?.snapshot?.board ?? null);
  const moveQueue = useRef(Promise.resolve());
  const pendingMoves = useRef(0);
  const reloadAfterMoves = useRef(false);
  const loadSeq = useRef(0);
  const loadBoardRef = useRef(() => {});
  const dragging = useRef(false);
  const dragOrigin = useRef(null);
  const recentlyMoved = useRef(false);
  // Which branch's data is already on screen, so we never fetch it twice.
  const loadedTenant = useRef(cached?.snapshot?.board ? cached.tenantId : null);
  const tenantIdRef = useRef(tenantId);
  const joinRef = useRef(() => {});
  tenantIdRef.current = tenantId;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const selectedOrganization = organizations.find((item) => item.id === organizationId) || organizations[0];
  const tenants = selectedOrganization?.tenants || [];
  const selectedTenant = tenants.find((item) => item.id === tenantId) || tenants[0];
  const allTasks = useMemo(() => board?.columns?.flatMap((column) => column.tasks) || [], [board]);
  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return new Set(allTasks.filter((task) =>
      (!query || `${task.title} ${task.description} ${task.assignee?.name || ""}`.toLowerCase().includes(query))
      && (priorityFilter === "ALL" || task.priority === priorityFilter),
    ).map((task) => task.id));
  }, [allTasks, search, priorityFilter]);

  // Single place that updates the board: keeps the ref and React state in lock-step.
  const applyBoard = useCallback((updater) => {
    const next = typeof updater === "function" ? updater(boardRef.current) : updater;
    boardRef.current = next;
    setBoard(next);
  }, []);

  const replaceTask = useCallback((task) => applyBoard((current) => current && ({
    ...current,
    columns: current.columns.map((column) => ({
      ...column, tasks: column.tasks.map((item) => (item.id === task.id ? task : item)),
    })),
  })), [applyBoard]);

  const findLiveTask = (taskId) => boardRef.current?.columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);

  const notify = useCallback((message) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem("orbit-token");
    localStorage.removeItem("orbit-org");
    localStorage.removeItem("orbit-tenant");
    localStorage.removeItem(CACHE_KEY);
    loadedTenant.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    boardRef.current = null;
    setToken(null);
    setUser(null);
    setOrganizations([]);
    setBoard(null);
    setTenantId(null);
    setOrganizationId(null);
    setMenu(null);
    setShowAssistant(false);
    setAssistantResponse(null);
    setAssistantQuery("");
    setAssistantError("");
    setAssistantActionResult("");
  }, []);

  // Collapse the sidebar automatically on narrow screens.
  useEffect(() => {
    const media = window.matchMedia(COLLAPSE_QUERY);
    const onChange = (event) => setCollapsed(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Close menus on outside click.
  useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => { if (!event.target.closest?.("[data-menu]")) setMenu(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  // Keyboard: Ctrl/Cmd+K or "/" focuses the task search.
  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector(".board-search")?.focus();
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector(".board-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setMembers(snapshot.members || []);
    setActivities(snapshot.activities || []);
    // Never overwrite a card that is being dragged or saved; reload once that settles.
    if (pendingMoves.current > 0 || dragging.current) {
      reloadAfterMoves.current = true;
      return;
    }
    applyBoard(snapshot.board || null);
    setDetailTask((current) => (current && snapshot.board
      ? snapshot.board.columns.flatMap((column) => column.tasks).find((task) => task.id === current.id) || null
      : current));
  }, [applyBoard]);

  // A single round trip replaces what used to be five requests in a chain.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const query = new URLSearchParams({
      tenantId: tenantIdRef.current || localStorage.getItem("orbit-tenant") || "",
      organizationId: localStorage.getItem("orbit-org") || "",
    });
    request(`/bootstrap?${query}`, { token }).then((data) => {
      if (cancelled) return;
      setUser(data.user);
      setOrganizations(data.organizations);
      setOrganizationId(data.organizationId);
      setTenantId(data.tenantId);
      loadedTenant.current = data.tenantId;
      setError("");
      applySnapshot(data.snapshot);
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err.message);
      if (err.status === 401) signOut();
    });
    return () => { cancelled = true; };
  }, [token, applySnapshot, signOut]);

  const loadBoard = useCallback(async (activeTenant = tenantId, activeToken = token) => {
    if (!activeTenant || !activeToken) return;
    // Never overwrite optimistic state while moves are still being saved; reload once they finish.
    if (pendingMoves.current > 0 || dragging.current) {
      reloadAfterMoves.current = true;
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { board: nextBoard } = await request(`/tenants/${activeTenant}/board`, { token: activeToken });
      // Ignore out-of-order responses and anything that arrived while a move started.
      if (seq !== loadSeq.current) return;
      if (pendingMoves.current > 0 || dragging.current) {
        reloadAfterMoves.current = true;
        return;
      }
      applyBoard(nextBoard);
      setDetailTask((current) => (current
        ? nextBoard.columns.flatMap((column) => column.tasks).find((task) => task.id === current.id) || null
        : current));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err.message);
      if (err.status === 401) signOut();
    } finally {
      setLoading(false);
    }
  }, [tenantId, token, signOut, applyBoard]);

  loadBoardRef.current = loadBoard;

  // Used when switching branches: board, people and activity in one request.
  const loadSnapshot = useCallback(async (activeTenant) => {
    if (!activeTenant || !token) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const snapshot = await request(`/tenants/${activeTenant}/snapshot`, { token });
      if (seq !== loadSeq.current) return;
      applySnapshot(snapshot);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err.message);
      if (err.status === 401) signOut();
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [token, applySnapshot, signOut]);

  useEffect(() => {
    if (!selectedOrganization || !tenants.length) return;
    if (!tenants.some((item) => item.id === tenantId)) {
      setTenantId(tenants[0].id);
      return;
    }
    localStorage.setItem("orbit-org", selectedOrganization.id);
    localStorage.setItem("orbit-tenant", tenantId);
    if (loadedTenant.current === tenantId) return; // already on screen (bootstrap or cache)
    loadedTenant.current = tenantId;
    setUndoStack([]);
    setRedoStack([]);
    setActivities([]);
    loadSnapshot(tenantId);
  }, [selectedOrganization, tenantId, tenants, loadSnapshot]);

  // Keep a local copy of the board so the next visit paints instantly.
  useEffect(() => {
    if (!token || !user || !board || !tenantId) return undefined;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          user, organizations, organizationId, tenantId, snapshot: { board, members, activities },
        }));
      } catch { /* storage full or blocked: caching is only an optimisation */ }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [token, user, organizations, organizationId, tenantId, board, members, activities]);

  // Open the realtime connection as soon as there is a token, in parallel with the first data
  // request, and join the active branch the moment the socket is up.
  useEffect(() => {
    if (!token) return undefined;
    const socket = io(API_URL || window.location.origin, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionDelay: 300,
      reconnectionDelayMax: 2500,
      timeout: 8000,
    });
    socketRef.current = socket;
    const join = () => {
      const target = tenantIdRef.current;
      if (!target) return;
      socket.emit("tenant:join", target, (result) => {
        if (result?.error && tenantIdRef.current === target) setError(result.error);
      });
    };
    joinRef.current = join;
    socket.on("connect", () => {
      setError((current) => (current.startsWith("Live updates") ? "" : current));
      join();
    });
    socket.on("presence:update", setPresence);
    socket.on("board:changed", (event) => {
      // Changes made by this very tab are already on screen.
      if (event?.origin === CLIENT_ID) return;
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => loadBoardRef.current(tenantIdRef.current), 150);
    });
    socket.on("activity:created", (activity) => setActivities((current) => (
      current.some((item) => item.id === activity.id) ? current : [activity, ...current].slice(0, 50)
    )));
    socket.on("connect_error", () => setError("Live updates are reconnecting. Your changes will still save."));
    return () => {
      window.clearTimeout(refreshTimer.current);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    if (tenantId && socketRef.current?.connected) joinRef.current();
  }, [tenantId]);

  const onAuthenticated = ({ token: nextToken, user: nextUser }) => {
    loadedTenant.current = null;
    localStorage.setItem("orbit-token", nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setError("");
  };

  const updateTenant = (value) => {
    if (value === tenantIdRef.current) return;
    setTenantId(value);
    applyBoard(null);
    setDetailTask(null);
    setPresence([]);
    setShowAssistant(false);
    setAssistantResponse(null);
    setAssistantQuery("");
    setAssistantError("");
    setAssistantActionResult("");
  };

  /* ---------- Moving cards ---------- */

  // Applies the server's bookkeeping (new version etc.) without touching where the card currently sits,
  // so a later optimistic move of the same card is never undone by an earlier response.
  const mergeSavedTask = (saved) => applyBoard((current) => current && ({
    ...current,
    columns: current.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((item) => (item.id === saved.id
        ? { ...item, version: saved.version, updatedAt: saved.updatedAt, assignee: saved.assignee }
        : item)),
    })),
  }));

  const flushReload = () => {
    if (reloadAfterMoves.current && pendingMoves.current === 0 && !dragging.current) {
      reloadAfterMoves.current = false;
      loadBoardRef.current();
    }
  };

  // Saves a move that is already visible on screen. Saves run one at a time, in order,
  // so each one is sent with the version the previous one produced.
  const enqueueMoveSave = ({ taskId, columnId, position, fromColumn, fromPosition, rollback, record }) => {
    pendingMoves.current += 1;
    setBusy(true);
    const run = moveQueue.current.then(async () => {
      const live = findLiveTask(taskId);
      if (!live) return false;
      try {
        const { task: saved } = await request(`/tenants/${tenantId}/tasks/${taskId}/move`, {
          token, method: "PATCH",
          body: JSON.stringify({ columnId, position, version: live.version }),
        });
        mergeSavedTask(saved);
        if (record) {
          setUndoStack((stack) => [...stack.slice(-19), {
            taskId, fromColumn, fromPosition, toColumn: columnId, toPosition: position,
          }]);
          setRedoStack([]);
        }
        return true;
      } catch (err) {
        reloadAfterMoves.current = true;
        // Snap back right away when nothing else is queued; otherwise the refresh below settles it.
        if (pendingMoves.current === 1 && rollback) applyBoard(rollback);
        notify(err.status === 409 ? "That card changed elsewhere. Refreshing the board." : err.message);
        return false;
      }
    }).catch(() => false);
    moveQueue.current = run.then(() => {
      pendingMoves.current -= 1;
      if (pendingMoves.current === 0) {
        setBusy(false);
        flushReload();
      }
    });
    return run;
  };

  // Programmatic move (undo, redo, assistant): shows the result immediately, then saves in the background.
  const performMove = (taskId, destinationId, index, { record = true } = {}) => {
    const current = boardRef.current;
    if (!current) return Promise.resolve(false);
    const result = relocateTask(current, taskId, destinationId, index);
    if (!result) return Promise.resolve(false);
    const { next, fromColumn, fromPosition, toColumn, toPosition } = result;
    if (fromColumn === toColumn && fromPosition === toPosition) return Promise.resolve(false);
    applyBoard(next);
    return enqueueMoveSave({ taskId, columnId: toColumn, position: toPosition, fromColumn, fromPosition, rollback: current, record });
  };

  const handleDragStart = ({ active }) => {
    const current = boardRef.current;
    const column = current?.columns.find((item) => item.tasks.some((task) => task.id === active.id));
    if (!current || !column) return;
    dragging.current = true;
    dragOrigin.current = {
      board: current,
      columnId: column.id,
      position: column.tasks.findIndex((task) => task.id === active.id),
    };
    setActiveTask(column.tasks.find((task) => task.id === active.id) || null);
    setOverlayWidth(active.rect.current.initial?.width || null);
  };

  // While dragging over another column, move the card there right away so the
  // destination column opens a gap for it, exactly where it will land.
  const handleDragOver = ({ active, over }) => {
    const current = boardRef.current;
    if (!over || !current || recentlyMoved.current) return;
    const from = current.columns.find((column) => column.tasks.some((task) => task.id === active.id));
    const overColumn = current.columns.find((column) => column.id === over.id);
    const to = overColumn || current.columns.find((column) => column.tasks.some((task) => task.id === over.id));
    if (!from || !to || from.id === to.id) return;
    let index = to.tasks.length;
    if (!overColumn) {
      const overIndex = to.tasks.findIndex((task) => task.id === over.id);
      const dragged = active.rect.current.translated;
      const below = dragged && over.rect
        && dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2;
      index = overIndex + (below ? 1 : 0);
    }
    const result = relocateTask(current, active.id, to.id, index);
    if (!result) return;
    applyBoard(result.next);
    recentlyMoved.current = true;
    requestAnimationFrame(() => { recentlyMoved.current = false; });
  };

  const endDrag = () => {
    dragging.current = false;
    dragOrigin.current = null;
    recentlyMoved.current = false;
    setActiveTask(null);
    flushReload();
  };

  const handleDragCancel = () => {
    const origin = dragOrigin.current;
    if (origin) applyBoard(origin.board);
    endDrag();
  };

  const handleDragEnd = ({ active, over }) => {
    const origin = dragOrigin.current;
    const current = boardRef.current;
    // Dropped outside the board: put the card back where it started.
    if (!origin || !current || !over) {
      if (origin) applyBoard(origin.board);
      endDrag();
      return;
    }
    const column = current.columns.find((item) => item.tasks.some((task) => task.id === active.id));
    if (!column) { endDrag(); return; }

    let index = column.tasks.findIndex((task) => task.id === active.id);
    if (over.id !== active.id) {
      const overIndex = column.tasks.findIndex((task) => task.id === over.id);
      if (overIndex >= 0) index = overIndex;
      else if (over.id === column.id) index = column.tasks.length - 1;
    }

    if (column.id === origin.columnId && index === origin.position) {
      applyBoard(origin.board);
      endDrag();
      return;
    }

    // Show the final order immediately; the save happens in the background.
    const result = relocateTask(current, active.id, column.id, index);
    if (result) applyBoard(result.next);
    const toPosition = result ? result.toPosition : index;
    dragging.current = false;
    enqueueMoveSave({
      taskId: active.id,
      columnId: column.id,
      position: toPosition,
      fromColumn: origin.columnId,
      fromPosition: origin.position,
      rollback: origin.board,
      record: true,
    });
    endDrag();
  };

  const undo = async () => {
    const action = undoStack.at(-1);
    if (!action) return;
    const ok = await performMove(action.taskId, action.fromColumn, action.fromPosition, { record: false });
    if (!ok) {
      if (!findLiveTask(action.taskId)) setUndoStack((stack) => stack.slice(0, -1));
      return;
    }
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, action]);
    notify("Move undone");
  };

  const redo = async () => {
    const action = redoStack.at(-1);
    if (!action) return;
    const ok = await performMove(action.taskId, action.toColumn, action.toPosition, { record: false });
    if (!ok) {
      if (!findLiveTask(action.taskId)) setRedoStack((stack) => stack.slice(0, -1));
      return;
    }
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, action]);
    notify("Move redone");
  };

  /* ---------- Creating / editing / deleting ---------- */

  const saveTask = async (values, task = null) => {
    setBusy(true);
    // Let any move that is still saving finish first, so the edit carries the latest version.
    await moveQueue.current;
    try {
      if (!task) {
        const columnId = values.columnId || boardRef.current.columns[0].id;
        const { task: created } = await request(`/tenants/${tenantId}/tasks`, {
          token, method: "POST",
          body: JSON.stringify({ ...values, columnId }),
        });
        applyBoard((current) => current && ({
          ...current,
          columns: current.columns.map((column) => (column.id === columnId
            ? { ...column, tasks: [...column.tasks, created] } : column)),
        }));
        notify("Task created");
        setShowNewTask(false);
        return true;
      }
      // Use the live copy so a card that was just moved is edited with its newest version.
      const live = findLiveTask(task.id) || task;
      replaceTask({ ...live, ...values });
      try {
        const { task: saved } = await request(`/tenants/${tenantId}/tasks/${task.id}`, {
          token, method: "PATCH", headers: { "If-Match": String(live.version) },
          body: JSON.stringify(values),
        });
        replaceTask(saved);
        setDetailTask(saved);
        notify("Changes saved");
        return true;
      } catch (err) {
        replaceTask(live);
        throw err;
      }
    } catch (err) {
      notify(err.message);
      if (err.status === 409) loadBoardRef.current();
      return false;
    } finally {
      setBusy(pendingMoves.current > 0);
    }
  };

  const deleteTask = (task) => setDialog({
    kind: "confirm", tone: "danger", icon: "trash",
    title: "Delete this task?",
    description: `“${task.title}” will be removed for everyone on this branch. This can't be undone.`,
    confirmLabel: "Delete task",
    onConfirm: async () => {
      await request(`/tenants/${tenantId}/tasks/${task.id}`, { token, method: "DELETE" });
      applyBoard((current) => current && ({
        ...current,
        columns: current.columns.map((column) => ({
          ...column, tasks: column.tasks.filter((item) => item.id !== task.id),
        })),
      }));
      setUndoStack((stack) => stack.filter((item) => item.taskId !== task.id));
      setRedoStack((stack) => stack.filter((item) => item.taskId !== task.id));
      setDetailTask(null);
      notify("Task deleted");
    },
  });

  const createBranch = async (name) => {
    const data = await request(`/organizations/${selectedOrganization.id}/tenants`, { token, method: "POST", body: JSON.stringify({ name }) });
    setOrganizations(data.organizations || (await request("/me/workspaces", { token })).organizations);
    updateTenant(data.tenant.id);
    notify(`${data.tenant.name} is ready`);
  };

  const createOrganization = async (name) => {
    const data = await request("/organizations", { token, method: "POST", body: JSON.stringify({ name }) });
    const list = data.organizations || (await request("/me/workspaces", { token })).organizations;
    setOrganizations(list);
    setOrganizationId(data.organization.id);
    updateTenant(list.find((item) => item.id === data.organization.id)?.tenants[0]?.id || null);
    notify(`${data.organization.name} is ready`);
  };

  const createColumn = async (name) => {
    const current = boardRef.current;
    const { column } = await request(`/tenants/${tenantId}/boards/${current.id}/columns`, {
      token, method: "POST", body: JSON.stringify({ name, color: "#b3a5e8" }),
    });
    if (column?.id) applyBoard((state) => state && ({ ...state, columns: [...state.columns, { ...column, tasks: [] }] }));
    else await loadBoard();
    notify("Column added");
  };

  const branchDialog = () => setDialog({
    kind: "prompt", icon: "branch", eyebrow: "A NEW BRANCH", title: "Name your new branch",
    description: "Each branch gets its own private board, so a team or location can work without noise.",
    label: "Branch name", placeholder: "e.g. Mumbai", min: 2, max: 60, confirmLabel: "Create branch", onSubmit: createBranch,
  });
  const organizationDialog = () => setDialog({
    kind: "prompt", icon: "organization", eyebrow: "A NEW ORGANIZATION", title: "Name your new organization",
    description: "It starts with a Main branch and a fresh board. You can add more branches later.",
    label: "Organization name", placeholder: "e.g. Stride Studio", min: 2, max: 60, confirmLabel: "Create organization", onSubmit: createOrganization,
  });
  const columnDialog = () => setDialog({
    kind: "prompt", icon: "column", eyebrow: "A NEW COLUMN", title: "Name your new column",
    description: "Columns are the stages a task moves through on this board.",
    label: "Column name", placeholder: "e.g. In review", min: 1, max: 40, confirmLabel: "Add column", onSubmit: createColumn,
  });

  /* ---------- Assistant ---------- */

  const runAssistant = async (query = assistantQuery) => {
    if (!query.trim() || !tenantId) return;
    setAssistantBusy(true);
    setAssistantError("");
    setAssistantActionResult("");
    setAssistantQuery(query);
    try {
      const response = await request(`/tenants/${tenantId}/assistant/run`, {
        token,
        method: "POST",
        body: JSON.stringify({ query: query.trim() }),
      });
      setAssistantResponse(response);
    } catch (err) {
      setAssistantError(err.message);
    } finally {
      setAssistantBusy(false);
    }
  };

  const approveAssistantAction = async () => {
    const action = assistantResponse?.proposed_action;
    if (!action || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantError("");
    try {
      let completed = false;
      if (action.tool === "create_task") {
        completed = await saveTask({
          title: action.title,
          description: "",
          priority: action.priority || "MEDIUM",
          dueDate: null,
          assigneeId: null,
          columnId: action.column_id,
        });
      } else {
        const task = findLiveTask(action.task_id);
        if (!task) {
          setAssistantError("That task is no longer on this board. Run the assistant again to refresh its suggestion.");
          return;
        }
        if (action.tool === "move_task") {
          completed = await performMove(task.id, action.column_id, action.position ?? 0);
        } else if (action.tool === "set_priority") {
          completed = await saveTask({ priority: action.priority }, task);
        }
      }
      if (completed) {
        setAssistantActionResult("Done — your change was saved to this branch.");
      } else {
        setAssistantError("The action wasn't completed. Please refresh the suggestion and try again.");
      }
    } finally {
      setAssistantBusy(false);
    }
  };

  if (!token) return <AuthScreen onAuthenticated={onAuthenticated} mode={authMode} setMode={setAuthMode} />;
  if (!user || !organizations.length) return <div className="boot-screen"><div className="brand-mark">{APP_MARK}</div><div className="loading-dot" /><span>Getting your workspace ready</span></div>;

  const taskCount = allTasks.length;
  const doneCount = board?.columns.find((column) => column.name.toLowerCase() === "done")?.tasks.length || 0;
  const progress = taskCount ? Math.round((doneCount / taskCount) * 100) : 0;

  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">{APP_MARK}</div>
          <span className="brand-name">{APP_NAME.toLowerCase()}<span className="brand-period">.</span></span>
          <button className="icon-btn sidebar-collapse" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
        <Select
          className="workspace-select"
          triggerClassName="workspace-picker"
          ariaLabel="Organization"
          title={selectedOrganization?.name}
          menuMinWidth={248}
          value={selectedOrganization?.id || ""}
          options={organizations.map((org) => ({
            value: org.id,
            label: org.name,
            leading: <span className="workspace-symbol small">{org.name.slice(0, 1).toUpperCase()}</span>,
          }))}
          onChange={(value) => {
            if (value === selectedOrganization?.id) return;
            const org = organizations.find((item) => item.id === value);
            setOrganizationId(value);
            updateTenant(org?.tenants[0]?.id || "");
          }}
          renderTrigger={() => (
            <>
              <div className="workspace-symbol">{(selectedOrganization?.name || "O").slice(0, 1).toUpperCase()}</div>
              <div className="workspace-copy"><span className="overline">WORKSPACE</span><strong>{selectedOrganization?.name}</strong></div>
              <ChevronDown size={16} className="muted-icon" />
            </>
          )}
        />
        <div className="side-label">YOUR SPACE</div>
        <nav className="side-nav">
          <button className="nav-item active" title="Boards"><LayoutGrid size={18} /><span>Boards</span><span className="nav-count">1</span></button>
          <button className="nav-item" title="Activity" onClick={() => setShowActivity(true)}><Activity size={18} /><span>Activity</span><span className="nav-count">{activities.length}</span></button>
          <button className="nav-item" title="People" onClick={() => notify("Your team is all caught up ✨")}><Users size={18} /><span>People</span></button>
        </nav>
        <div className="branch-head"><span className="side-label">BRANCHES</span><span className="branch-count">{tenants.length}</span></div>
        <div className="branch-list">
          {tenants.map((tenant, index) => (
            <button key={tenant.id} title={tenant.name} className={`branch-item ${tenantId === tenant.id ? "selected" : ""}`} onClick={() => updateTenant(tenant.id)}>
              <span className={`branch-dot branch-dot-${index % 4}`} />
              <span className="branch-name">{tenant.name}</span>
              {tenantId === tenant.id && <span className="branch-live" />}
            </button>
          ))}
          {selectedOrganization?.role === "ORG_ADMIN" && (
            <button className="branch-add" onClick={branchDialog}><Plus size={15} /> Add branch</button>
          )}
          <button className="branch-add" onClick={organizationDialog}><Plus size={15} /> New organization</button>
        </div>
        <div className="sidebar-spacer" />
        <div className="upgrade-card"><span className="upgrade-icon"><Sparkles size={16} /></span><strong>A little more room?</strong><span>Invite your team and make more things happen together.</span><button onClick={() => notify("Your workspace is ready for the whole team.")}>Explore workspace <ArrowRight size={14} /></button><div className="upgrade-orb orb-one" /><div className="upgrade-orb orb-two" /></div>
        <div className="profile-wrap" data-menu>
          <button className="profile-button" onClick={() => setMenu(menu === "side" ? null : "side")} title={user.name}>
            <Avatar person={user} size="medium" /><span className="profile-copy"><strong>{user.name}</strong><span>{roleLabel(selectedOrganization?.role)}</span></span><MoreHorizontal size={18} className="muted-icon" />
          </button>
          {menu === "side" && <div className="profile-popover"><strong>{user.email}</strong><button onClick={signOut}><LogOut size={15} /> Sign out</button></div>}
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>{selectedOrganization?.name}</span><ChevronRight size={14} /><span>{selectedTenant?.name}</span><ChevronRight size={14} /><strong>Boards</strong></div>
          <div className="top-actions">
            <button className="command-search" onClick={() => document.querySelector(".board-search")?.focus()}><Search size={16} /><span>Search anything...</span><kbd><Command size={11} /> K</kbd></button>
            <button className="icon-btn notification-btn" aria-label="Notifications" onClick={() => setShowActivity(true)}><Bell size={18} /><span /></button>
            <div className="top-divider" />
            <div className="top-user-wrap" data-menu>
              <button className="top-user" onClick={() => setMenu(menu === "top" ? null : "top")} aria-label="Account menu"><Avatar person={user} size="small" /><ChevronDown size={14} /></button>
              {menu === "top" && <div className="profile-popover top-popover"><strong>{user.email}</strong><button onClick={signOut}><LogOut size={15} /> Sign out</button></div>}
            </div>
          </div>
        </header>

        <section className="board-content">
          <div className="board-heading">
            <div className="board-title-wrap">
              <div className="board-eyebrow"><span className="eyebrow-dot" /> TEAM WORKSPACE <span className="eyebrow-divider">/</span> {selectedTenant?.name?.toUpperCase()}</div>
              <h1>{board?.name || "Your board"}<button className="title-more icon-btn" aria-label="Board settings" onClick={() => notify("Board settings are coming soon.")}><MoreHorizontal size={20} /></button></h1>
              <p className="board-subtitle">A little progress, every day. <span>Make it count.</span></p>
            </div>
            <div className="board-heading-actions">
              <div className="presence-stack">
                {(presence.length ? presence : [user]).slice(0, 4).map((person, index) => <Avatar key={person.id || index} person={person} size="small" className="presence-avatar" />)}
                <span className="presence-count">{presence.length || 1} here</span>
              </div>
              <button className="outline-button invite-button" onClick={() => {
                const share = window.location.origin;
                const copied = navigator.clipboard?.writeText(share);
                if (copied) copied.then(() => notify("Workspace link copied to clipboard")).catch(() => notify("Couldn't access the clipboard. Copy the workspace link from your address bar."));
                else notify("Copy the workspace link from your address bar.");
              }}><Plus size={16} /> Invite</button>
              <button className="primary-button" onClick={() => setShowNewTask(true)}><Plus size={17} /> New task</button>
            </div>
          </div>

          <div className="board-summary">
            <div className="summary-item"><span className="summary-icon lavender"><LayoutGrid size={17} /></span><span><strong>{taskCount}</strong><small>tasks on board</small></span></div>
            <span className="summary-divider" />
            <div className="summary-item"><span className="summary-icon mint"><Check size={17} /></span><span><strong>{doneCount} <small className="summary-inline">of {taskCount}</small></strong><small>tasks completed</small></span></div>
            <span className="summary-divider" />
            <div className="summary-progress"><div className="summary-progress-copy"><span>Overall progress</span><strong>{progress}%</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>
            <div className="summary-date"><CalendarDays size={16} /> {busy ? "Saving…" : "Updated just now"}</div>
          </div>

          <div className="board-toolbar">
            <div className="view-tabs"><button className="view-tab active"><LayoutGrid size={16} /> Board</button><button className="view-tab" onClick={() => notify("List view is coming soon.")}><ListFilter size={16} /> List</button></div>
            <div className="toolbar-actions">
              <button className="tool-button history-button" title="Undo move" disabled={!undoStack.length || busy} onClick={undo}><Undo2 size={16} /> <span>Undo</span></button>
              <button className="tool-button history-button" title="Redo move" disabled={!redoStack.length || busy} onClick={redo}><Redo2 size={16} /> <span>Redo</span></button>
              <span className="toolbar-divider" />
              <button className={`tool-button assistant-toggle ${showAssistant ? "selected" : ""}`} onClick={() => setShowAssistant(true)} title="Ask the board guide"><Sparkles size={17} /><span>Ask AI</span></button>
              <label className="filter-search"><Search size={15} /><input className="board-search" placeholder="Search tasks" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>/</kbd></label>
              <Select className="priority-filter" ariaLabel="Filter by priority" value={priorityFilter} options={priorityFilterOptions} onChange={setPriorityFilter} align="right" menuMinWidth={170} />
              <button className={`tool-button icon-only activity-toggle ${showActivity ? "selected" : ""}`} onClick={() => setShowActivity(!showActivity)} title="Activity"><Activity size={17} /></button>
              <button className="tool-button icon-only" title="Board settings" onClick={() => notify("Board settings are coming soon.")}><Settings2 size={17} /></button>
            </div>
          </div>

          {error && <div className="inline-alert"><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}
          {loading && !board ? <div className="board-loading"><div className="loading-dot" /> Loading your board...</div> : null}
          {!loading && !board && !error ? <div className="board-loading">No board found for this branch yet.</div> : null}

          {board && (
            <DndContext sensors={sensors} collisionDetection={collisionStrategy} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
              <div className="kanban-board">
                {board.columns.map((column) => {
                  const visibleTasks = column.tasks.filter((task) => filteredTasks.has(task.id));
                  return <KanbanColumn key={column.id} column={column} tasks={visibleTasks} filtered={Boolean(search) || priorityFilter !== "ALL"} onOpen={setDetailTask} onAddInColumn={() => setShowNewTask(column.id)} />;
                })}
                <button className="add-column-button" onClick={columnDialog}><Plus size={16} /> Add column</button>
              </div>
              <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.25, 1, 0.5, 1)" }}>{activeTask ? <TaskCard task={activeTask} overlay width={overlayWidth} /> : null}</DragOverlay>
            </DndContext>
          )}
          <footer className="board-footer"><span><span className="footer-live-dot" /> Changes are saved automatically</span><span>Made for teams that make things happen <Sparkles size={13} /></span></footer>
        </section>
      </main>

      {detailTask && <TaskDetails task={detailTask} members={members} activities={activities.filter((item) => item.taskId === detailTask.id)} onClose={() => setDetailTask(null)} onSave={saveTask} onDelete={deleteTask} busy={busy} notify={notify} />}
      {showNewTask && board && <TaskEditor task={null} members={members} columns={board.columns} initialColumn={typeof showNewTask === "string" ? showNewTask : board.columns[0]?.id} onClose={() => setShowNewTask(false)} onSave={saveTask} busy={busy} />}
      {showActivity && <ActivityDrawer activities={activities} onClose={() => setShowActivity(false)} />}
      {showAssistant && <AssistantDrawer
        query={assistantQuery}
        response={assistantResponse}
        busy={assistantBusy}
        error={assistantError}
        actionResult={assistantActionResult}
        onQueryChange={setAssistantQuery}
        onRun={runAssistant}
        onApprove={approveAssistantAction}
        onClose={() => setShowAssistant(false)}
      />}
      {dialog && <DialogHost dialog={dialog} onClose={() => setDialog(null)} />}
      {notice && <div className="toast"><span className="toast-check"><Check size={13} /></span>{notice}</div>}
    </div>
  );
}

function roleLabel(role) {
  return ({ ORG_ADMIN: "Organization admin", TENANT_ADMIN: "Branch admin", MEMBER: "Team member" })[role] || "Team member";
}

function Avatar({ person, size = "small", className = "" }) {
  if (!person) return <span className={`avatar avatar-${size} ${className}`}>?</span>;
  return <span className={`avatar avatar-${size} ${className}`} style={{ backgroundColor: person.avatarColor || avatarPalette[(person.name?.length || 0) % avatarPalette.length] }} title={person.name}>{initials(person.name)}</span>;
}

function AuthScreen({ onAuthenticated, mode, setMode }) {
  const [form, setForm] = useState({ name: "", organization: "", branch: "", email: "alex@julley.demo", password: "JulleyDemo!" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [help, setHelp] = useState(false);
  const register = mode === "register";
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const checkCaps = (event) => setCapsOn(Boolean(event.getModifierState?.("CapsLock")));
  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const { token, user } = await request(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify(register ? form : { email: form.email, password: form.password }),
      });
      onAuthenticated({ token, user });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };
  const [headlineTop, headlineBottom] = (register ? "Start something\ngood." : "Welcome back,\nlet's make it happen.").split("\n");
  return (
    <div className="auth-page">
      <AuthVisual appName={APP_NAME} appMark={APP_MARK} />
      <div className="auth-form-side">
        <div className="auth-form-wrap" key={mode}>
          <div className="auth-welcome-pill"><span /> YOUR TEAM'S NEW FAVORITE PLACE</div>
          <h1>{headlineTop}<br /><span className="auth-h1-accent">{headlineBottom}</span></h1>
          <p className="auth-intro">{register ? `Set up your team's corner of ${APP_NAME}. You can invite everyone else in a moment.` : "A little progress goes a long way. Pick up where your team left off."}</p>
          {!register && <div className="demo-banner"><span className="demo-sparkle"><Sparkles size={15} /></span><span><strong>Just looking around?</strong><small>You're already set up with our demo workspace.</small></span><button type="button" onClick={() => setForm((current) => ({ ...current, email: "alex@julley.demo", password: "JulleyDemo!" }))}>Use demo <ArrowRight size={13} /></button></div>}
        <form className="auth-form" onSubmit={submit}>
          {register && <label>Your name<input autoComplete="name" required minLength={2} maxLength={60} placeholder="What should we call you?" value={form.name} onChange={update("name")} /></label>}
          <label>Email address<input type="email" autoComplete="email" required placeholder="you@company.com" value={form.email} onChange={update("email")} /></label>
          <label>Password
            <span className="auth-password">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete={register ? "new-password" : "current-password"}
                required minLength={8}
                placeholder={register ? "At least 8 characters" : "Enter your password"}
                value={form.password}
                onChange={update("password")}
                onKeyDown={checkCaps}
                onKeyUp={checkCaps}
                onBlur={() => setCapsOn(false)}
              />
              <button type="button" className="auth-eye" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            {capsOn && <small className="auth-caps">Caps Lock is on</small>}
          </label>
          {register && <><label>Organization<input required minLength={2} maxLength={60} placeholder="The company or team" value={form.organization} onChange={update("organization")} /></label><label>First branch<input required minLength={2} maxLength={60} placeholder="Your first team or location" value={form.branch} onChange={update("branch")} /></label></>}
          {error && <div className="auth-error" key={error} role="alert">{error}</div>}
          <button className={`auth-submit ${submitting ? "is-loading" : ""}`} disabled={submitting}>
            {submitting
              ? <><span className="auth-spinner" /> One moment...</>
              : <>{register ? "Create your workspace" : "Step into your workspace"}<ArrowRight size={16} /></>}
          </button>
        </form>
          <p className="auth-switch">{register ? "Already found your way here?" : `New to ${APP_NAME}?`} <button type="button" onClick={() => { setMode(register ? "login" : "register"); setError(""); }}> {register ? "Sign in instead" : "Create your space"}</button></p>
          <div className="auth-trust"><span><Check size={12} /> Private by design</span><span>·</span><span>Your team's data stays yours</span></div>
        </div>
        <div className="auth-bottom"><button type="button" onClick={() => setHelp(true)}><CircleHelp size={15} /> A little help?</button><span>© {new Date().getFullYear()} {APP_NAME} workspace</span></div>
      </div>
      {help && <DialogHost onClose={() => setHelp(false)} dialog={{
        kind: "confirm", hideCancel: true, icon: "help", title: "How your space is kept private",
        description: `${APP_NAME} keeps each organization's workspace separate, and each branch's board is private to its members.`,
        confirmLabel: "Got it",
      }} />}
    </div>
  );
}

function KanbanColumn({ column, tasks, filtered, onOpen, onAddInColumn }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <section className={`kanban-column ${isOver ? "column-over" : ""}`}>
      <div className="column-heading"><div className="column-title"><span className="column-color" style={{ background: column.color }} /><h2>{column.name}</h2><span className="column-count">{filtered ? tasks.length : column.tasks.length}</span></div><button className="icon-btn column-menu" aria-label={`${column.name} options`}><MoreHorizontal size={18} /></button></div>
      <div className="column-rule" style={{ "--column-color": column.color }} />
      <div ref={setNodeRef} className="column-dropzone">
        <div className="task-list">
          <SortableContextWrapper items={tasks.map((task) => task.id)}>
            {tasks.map((task) => <DraggableTask key={task.id} task={task} onOpen={onOpen} />)}
          </SortableContextWrapper>
          {!tasks.length && <div className="column-empty">{filtered ? "Nothing matches your search" : "Nothing here just yet"}<span>{filtered ? "Try another search." : "A fresh start is a good start."}</span></div>}
        </div>
        <button className="add-task-inline" onClick={() => onAddInColumn(column.id)}><Plus size={15} /> Add a task</button>
      </div>
    </section>
  );
}

function SortableContextWrapper({ items, children }) {
  return <SortableContext items={items} strategy={verticalListSortingStrategy}>{children}</SortableContext>;
}

function DraggableTask({ task, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, transition: { duration: 180, easing: "cubic-bezier(0.25, 1, 0.5, 1)" } });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return <div ref={setNodeRef} style={style} className={`task-drag-wrap ${isDragging ? "is-dragging" : ""}`} {...attributes} {...listeners}><TaskCard task={task} onOpen={onOpen} /></div>;
}

function TaskCard({ task, onOpen, overlay = false, width = null }) {
  const due = friendlyDate(task.dueDate);
  const priority = task.priority || "MEDIUM";
  return (
    <article className={`task-card ${overlay ? "task-overlay" : ""}`} style={overlay && width ? { width } : undefined} onClick={(event) => { if (!overlay && !event.target.closest(".task-quick-action")) onOpen?.(task); }}>
      <div className="task-card-top"><span className={`priority-dot priority-${priority.toLowerCase()}`} /><span className={`priority-text priority-label-${priority.toLowerCase()}`}>{priorityLabels[priority] || "Normal"}</span><button className="task-quick-action" aria-label="Open task" onClick={(event) => { event.stopPropagation(); onOpen?.(task); }}><ArrowUp size={13} /></button></div>
      <h3>{task.title}</h3>
      {task.description && <p className="task-description">{task.description}</p>}
      <div className="task-card-bottom"><div className="task-card-meta">{due && <span className={`task-due ${due.tone}`}><CalendarDays size={13} /> {due.label}</span>}</div><div className="task-card-people">{task.assignee ? <Avatar person={task.assignee} size="tiny" /> : <span className="unassigned" title="Unassigned"><Users size={13} /></span>}<MessageCircle size={14} className="comment-icon" /></div></div>
    </article>
  );
}

function TaskEditor({ task, members, columns, initialColumn, onClose, onSave, busy }) {
  const [form, setForm] = useState({
    title: task?.title || "", description: task?.description || "", priority: task?.priority || "MEDIUM",
    assigneeId: task?.assigneeId || task?.assignee?.id || "", dueDate: task?.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : "",
    columnId: initialColumn || columns?.[0]?.id || "",
  });
  const [error, setError] = useState("");
  const change = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setField = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const { columnId, ...rest } = form;
    const values = {
      ...rest,
      ...(task ? {} : { columnId }),
      assigneeId: form.assigneeId || null,
      dueDate: form.dueDate ? new Date(`${form.dueDate}T12:00:00.000Z`).toISOString() : null,
    };
    if (!(await onSave(values, task))) setError("Your changes couldn't be saved. Check your connection and try again.");
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="task-editor" onSubmit={submit}>
        <div className="editor-top"><span className="editor-eyebrow">{task ? "TASK DETAILS" : "A NEW LITTLE THING"}</span><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <h2>{task ? "Make a change." : "What are we working on?"}</h2>
        <label className="editor-label">Task name<input autoFocus required maxLength={160} placeholder="A clear, kind little title" value={form.title} onChange={change("title")} /></label>
        <label className="editor-label">A few more details<textarea maxLength={4000} rows={4} placeholder="What does done look like?" value={form.description} onChange={change("description")} /></label>
        <div className="editor-two-col">
          <div className="editor-label"><span>Priority</span><Select ariaLabel="Priority" value={form.priority} options={taskPriorityOptions} onChange={setField("priority")} /></div>
          <label className="editor-label">Due date<input type="date" value={form.dueDate} onChange={change("dueDate")} /></label>
        </div>
        <div className="editor-two-col">
          <div className="editor-label"><span>Teammate</span><Select ariaLabel="Teammate" value={form.assigneeId} onChange={setField("assigneeId")} options={[{ value: "", label: "Unassigned", leading: <span className="unassigned small"><Users size={12} /></span> }, ...members.map((member) => ({ value: member.user.id, label: member.user.name, leading: <Avatar person={member.user} size="tiny" /> }))]} /></div>
          {!task && <div className="editor-label"><span>Add to</span><Select ariaLabel="Add to column" value={form.columnId} onChange={setField("columnId")} options={columns.map((column) => ({ value: column.id, label: column.name, leading: <span className="column-color" style={{ background: column.color }} /> }))} /></div>}
        </div>
        {error && <div className="auth-error">{error}</div>}
        <div className="editor-actions"><button type="button" className="outline-button" onClick={onClose}>Maybe later</button><button className="primary-button" disabled={busy}>{busy ? "Saving..." : task ? "Save changes" : "Create task"} <ArrowRight size={15} /></button></div>
      </form>
    </div>
  );
}

function TaskDetails({ task, members, activities, onClose, onSave, onDelete, busy, notify }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <TaskEditor task={task} members={members} columns={[]} onClose={() => setEditing(false)} onSave={async (values, current) => {
    const result = await onSave(values, current);
    if (result) setEditing(false);
    return result;
  }} busy={busy} />;
  const due = friendlyDate(task.dueDate);
  return (
    <div className="detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="detail-panel"><div className="detail-top"><div className="detail-breadcrumb"><span>BOARD</span><ChevronRight size={13} /><span>TASK DETAILS</span></div><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="detail-content"><div className="detail-tags"><span className={`priority-tag priority-label-${task.priority.toLowerCase()}`}><span className={`priority-dot priority-${task.priority.toLowerCase()}`} />{priorityLabels[task.priority]}</span><span className="task-id">#{task.id.slice(-5).toUpperCase()}</span></div><h1>{task.title}</h1><div className="detail-actions"><button className="outline-button" onClick={() => setEditing(true)}><Settings2 size={14} /> Edit task</button><button className="detail-delete" onClick={() => onDelete(task)}><X size={14} /> Delete</button></div>
          <div className="detail-section"><h3>THE DETAILS</h3><p className="detail-description">{task.description || "No details added yet. A little more context can go a long way."}</p></div>
          <div className="detail-properties"><div className="detail-property"><span>Assigned to</span><div>{task.assignee ? <><Avatar person={task.assignee} size="tiny" /> {task.assignee.name}</> : <span className="property-empty">Nobody just yet</span>}</div></div><div className="detail-property"><span>Due date</span><div>{due ? <><CalendarDays size={14} /> <span className={due.tone}>{due.label}</span></> : <span className="property-empty">No date set</span>}</div></div><div className="detail-property"><span>Priority</span><div><span className={`priority-dot priority-${task.priority.toLowerCase()}`} />{priorityLabels[task.priority]}</div></div><div className="detail-property"><span>Last updated</span><div><Clock3 size={14} />{new Date(task.updatedAt).toLocaleDateString("en", { month: "short", day: "numeric" })}</div></div></div>
          <div className="detail-section activity-section"><h3>THE LATEST</h3>{activities.length ? activities.slice(0, 6).map((activity) => <div className="detail-activity" key={activity.id}><Avatar person={activity.user} size="tiny" /><p><strong>{activity.user.name}</strong> {activity.detail}<span>{timeAgo(activity.createdAt)}</span></p></div>) : <div className="detail-activity-empty"><span className="activity-empty-icon"><Activity size={16} /></span><span>Little things will show up here as your team works.</span></div>}</div>
        </div><div className="detail-footer"><span>Made together, one task at a time <Sparkles size={13} /></span><button className="icon-btn" aria-label="Task version" onClick={() => notify(`Current version: ${task.version}`)}><MoreHorizontal size={18} /></button></div>
      </aside>
    </div>
  );
}

function ActivityDrawer({ activities, onClose }) {
  return <div className="detail-backdrop activity-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="activity-drawer"><div className="detail-top"><div><span className="editor-eyebrow">YOUR BRANCH</span><h2>Little things, lately.</h2></div><button className="icon-btn" onClick={onClose}><X size={18} /></button></div><p className="activity-drawer-intro">A quiet record of all the good work your team has been doing.</p>{activities.length ? <div className="activity-feed">{activities.map((item) => <div className="feed-item" key={item.id}><Avatar person={item.user} size="small" /><div className="feed-copy"><p><strong>{item.user.name}</strong> {item.detail}</p><span>{timeAgo(item.createdAt)}</span></div><span className="feed-type"><Activity size={13} /></span></div>)}</div> : <div className="activity-empty"><span className="activity-empty-icon"><Activity size={19} /></span><strong>All quiet for now</strong><span>Your team's updates will show up here.</span></div>}<div className="activity-drawer-footer">Only people in this branch can see this activity.</div></aside></div>;
}

function AssistantDrawer({ query, response, busy, error, actionResult, onQueryChange, onRun, onApprove, onClose }) {
  const action = response?.proposed_action;
  const actionDescription = action?.tool === "create_task"
    ? `Create "${action.title}" in ${action.column_name} with ${priorityLabels[action.priority] || "Normal"} priority`
    : action?.tool === "move_task"
      ? `Move "${action.task_title}" to ${action.column_name}`
      : action?.tool === "set_priority"
        ? `Set "${action.task_title}" to ${priorityLabels[action.priority]} priority`
        : "";

  return (
    <div className="detail-backdrop assistant-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="assistant-drawer">
        <div className="assistant-heading">
          <div className="assistant-brand-icon"><Sparkles size={17} /></div>
          <div><span className="editor-eyebrow">YOUR PRIVATE BOARD GUIDE</span><h2>Let’s make a little progress.</h2></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close assistant"><X size={18} /></button>
        </div>
        <p className="assistant-intro">I can summarize this branch, spot work that needs attention, or prepare a task change for you to approve.</p>
        <div className="assistant-prompts">
          <span>TRY ASKING</span>
          <button onClick={() => onRun("What should we focus on?")} disabled={busy}>What should we focus on?</button>
          <button onClick={() => onRun("Summarize this board")} disabled={busy}>Summarize this board</button>
          <button onClick={() => onRun("What needs attention?")} disabled={busy}>What needs attention?</button>
        </div>
        <div className="assistant-conversation">
          {!response && !busy && <div className="assistant-empty"><span className="activity-empty-icon"><Sparkles size={18} /></span><strong>A fresh look at your board.</strong><span>Ask about progress or describe one task action. I’ll show the plan before changing anything.</span></div>}
          {busy && <div className="assistant-thinking"><span className="loading-dot" /> Looking at this branch’s board and activity…</div>}
          {response && !busy && (
            <div className="assistant-result">
              <span className="assistant-response-label">BOARD SNAPSHOT</span>
              <p className="assistant-summary">{response.summary}</p>
              <div className="assistant-metrics">
                <span><strong>{response.metrics.total_tasks}</strong> tasks</span>
                <span><strong>{response.metrics.completion_percent}%</strong> complete</span>
                <span><strong>{response.metrics.overdue}</strong> overdue</span>
                <span><strong>{response.metrics.unassigned}</strong> unassigned</span>
              </div>
              <span className="assistant-response-label">A FEW THINGS TO NOTICE</span>
              <ul className="assistant-insights">{response.insights.map((insight, index) => <li key={`${index}-${insight}`}>{insight}</li>)}</ul>
              {response.clarification && <div className="assistant-clarification">{response.clarification}</div>}
              {action && <div className="assistant-action">
                <span className="assistant-response-label"><Zap size={12} /> READY FOR YOUR APPROVAL</span>
                <p>{actionDescription}</p>
                {actionResult
                  ? <div className="assistant-action-done"><Check size={14} /> {actionResult}</div>
                  : <button className="primary-button" disabled={busy} onClick={onApprove}>Approve &amp; run <ArrowRight size={14} /></button>}
              </div>}
              <details className="assistant-tool-trace">
                <summary>Analysis tools used ({response.tools_executed.length})</summary>
                <div>{response.tools_executed.map((tool) => <span key={tool.name}><Check size={12} /> {tool.name.replaceAll("_", " ")}</span>)}</div>
              </details>
              <p className="assistant-privacy"><Check size={12} /> Analyzed by the private Python service; no external AI provider is used.</p>
            </div>
          )}
          {error && <div className="auth-error assistant-error">{error}</div>}
        </div>
        <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); onRun(query); }}>
          <textarea
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={'Try “Move Review the launch plan to Done”'}
            maxLength={600}
            rows={2}
            aria-label="Ask the board guide"
            disabled={busy}
          />
          <div className="assistant-composer-footer"><span>Task changes are previewed first.</span><button className="primary-button" disabled={busy || !query.trim()}>{busy ? "Thinking…" : "Ask"} <ArrowRight size={14} /></button></div>
        </form>
      </aside>
    </div>
  );
}

/* A fully styled dropdown. The menu is rendered in a portal so modals and scrolling panels never clip it. */
function Select({ value, onChange, options, ariaLabel, className = "", triggerClassName = "", renderTrigger, menuMinWidth = 0, title, disabled = false, align = "left" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const place = () => {
    const element = triggerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = Math.max(rect.width, menuMinWidth);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const wanted = Math.min(options.length * 40 + 14, 320);
    const flip = below < Math.min(wanted, 200) && above > below;
    const maxHeight = Math.max(120, Math.min(wanted, flip ? above : below));
    let left = align === "right" ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPos({ left, width, maxHeight, ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
  };

  const openMenu = () => {
    if (disabled) return;
    place();
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const choose = (option) => {
    onChange(option.value);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onScroll = (event) => { if (!menuRef.current?.contains(event.target)) setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Keep the highlighted option visible when navigating with the keyboard.
  useEffect(() => {
    const menu = menuRef.current;
    const item = menu?.querySelector('[data-active="true"]');
    if (!menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop - 6;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight + 6;
  }, [open, active, pos]);

  const onKeyDown = (event) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(options.length - 1, index + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (options[active]) choose(options[active]); }
    else if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className={`select ${open ? "is-open" : ""} ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        className={renderTrigger ? triggerClassName : `select-trigger ${triggerClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        {renderTrigger ? renderTrigger(selected, open) : (
          <>
            <span className="select-value">{selected?.leading}<span className="select-label">{selected?.label ?? "Select"}</span></span>
            <ChevronDown size={15} className="select-chevron" />
          </>
        )}
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="select-menu" role="listbox" aria-label={ariaLabel} style={pos} onMouseDown={(event) => event.preventDefault()}>
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              data-active={index === active}
              className={`select-option ${index === active ? "is-active" : ""} ${option.value === value ? "is-selected" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              {option.leading}
              <span className="select-option-label">{option.label}</span>
              {option.value === value && <Check size={15} className="select-check" />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* One themed dialog for every ask-or-confirm moment: a text prompt, a confirmation, or a notice. */
function DialogHost({ dialog, onClose }) {
  const [value, setValue] = useState(dialog.initial || "");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const isPrompt = dialog.kind === "prompt";
  const danger = dialog.tone === "danger";
  const Icon = dialogIcons[dialog.icon] || Sparkles;

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, onClose]);

  const submit = async (event) => {
    event.preventDefault();
    if (working) return;
    setError("");
    let input = "";
    if (isPrompt) {
      input = value.trim();
      const min = dialog.min ?? 1;
      if (input.length < min) {
        setError(`${dialog.label} needs at least ${min} character${min === 1 ? "" : "s"}.`);
        return;
      }
    }
    setWorking(true);
    try {
      if (isPrompt) await dialog.onSubmit(input);
      else await dialog.onConfirm?.();
      onClose();
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
      <form className="dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-head">
          <span className={`dialog-icon ${danger ? "danger" : ""}`}><Icon size={20} /></span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={working}><X size={18} /></button>
        </div>
        {dialog.eyebrow && <span className="editor-eyebrow">{dialog.eyebrow}</span>}
        <h2 id="dialog-title">{dialog.title}</h2>
        {dialog.description && <p className="dialog-copy">{dialog.description}</p>}
        {isPrompt && (
          <label className="editor-label">{dialog.label}
            <input autoFocus maxLength={dialog.max ?? 60} placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        )}
        {error && <div className="auth-error">{error}</div>}
        <div className="editor-actions">
          {!dialog.hideCancel && <button type="button" className="outline-button" autoFocus={danger} onClick={onClose} disabled={working}>{dialog.cancelLabel || "Maybe later"}</button>}
          <button className={`primary-button ${danger ? "danger" : ""}`} autoFocus={!isPrompt && !danger} disabled={working}>
            {working ? "One moment…" : dialog.confirmLabel || "Confirm"} {!working && <ArrowRight size={15} />}
          </button>
        </div>
      </form>
    </div>
  );
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

createRoot(document.getElementById("root")).render(<App />);