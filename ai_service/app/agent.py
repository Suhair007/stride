from __future__ import annotations

import re
from collections import Counter
from datetime import date
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PersonSnapshot(StrictModel):
    id: str
    name: str


class TaskSnapshot(StrictModel):
    id: str
    title: str = Field(min_length=1, max_length=160)
    description: str = ""
    priority: Literal["LOW", "MEDIUM", "HIGH", "URGENT"] = "MEDIUM"
    position: int = 0
    version: int = 1
    dueDate: str | None = None
    assignee: PersonSnapshot | None = None


class ColumnSnapshot(StrictModel):
    id: str
    name: str = Field(min_length=1, max_length=40)
    position: int = 0
    tasks: list[TaskSnapshot] = Field(default_factory=list, max_length=250)


class BoardSnapshot(StrictModel):
    id: str
    name: str = Field(min_length=1, max_length=80)
    columns: list[ColumnSnapshot] = Field(default_factory=list, max_length=30)


class ActivitySnapshot(StrictModel):
    action: str
    detail: str
    createdAt: str
    userName: str = "A teammate"


class AgentRequest(StrictModel):
    query: str = Field(min_length=1, max_length=600)
    board: BoardSnapshot
    activities: list[ActivitySnapshot] = Field(default_factory=list, max_length=100)
    as_of: date = Field(default_factory=date.today)


class ProposedAction(StrictModel):
    tool: Literal["create_task", "move_task", "set_priority"]
    confirmation_required: Literal[True] = True
    title: str | None = None
    task_id: str | None = None
    task_title: str | None = None
    column_id: str | None = None
    column_name: str | None = None
    position: int | None = None
    priority: Literal["LOW", "MEDIUM", "HIGH", "URGENT"] | None = None


class ToolRun(StrictModel):
    name: str
    result: dict[str, Any]


class AgentResponse(StrictModel):
    summary: str
    metrics: dict[str, int | float]
    insights: list[str]
    tools_executed: list[ToolRun]
    proposed_action: ProposedAction | None = None
    clarification: str | None = None


def _flatten(board: BoardSnapshot) -> list[tuple[ColumnSnapshot, TaskSnapshot]]:
    return [(column, task) for column in board.columns for task in column.tasks]


def _is_done(column: ColumnSnapshot) -> bool:
    return column.name.strip().casefold() in {"done", "complete", "completed"}


def _is_overdue(task: TaskSnapshot, column: ColumnSnapshot, as_of: date) -> bool:
    if not task.dueDate or _is_done(column):
        return False
    try:
        return date.fromisoformat(task.dueDate[:10]) < as_of
    except ValueError:
        return False


def summarize_board(request: AgentRequest) -> dict[str, Any]:
    pairs = _flatten(request.board)
    done_count = sum(len(column.tasks) for column in request.board.columns if _is_done(column))
    overdue = [
        task.title
        for column, task in pairs
        if _is_overdue(task, column, request.as_of)
    ]
    unassigned = sum(task.assignee is None for _, task in pairs)
    active_columns = sum(bool(column.tasks) for column in request.board.columns if not _is_done(column))
    return {
        "board_name": request.board.name,
        "task_count": len(pairs),
        "column_count": len(request.board.columns),
        "completed_count": done_count,
        "completion_percent": round(done_count / len(pairs) * 100) if pairs else 0,
        "overdue_count": len(overdue),
        "overdue_tasks": overdue[:5],
        "unassigned_count": unassigned,
        "active_columns": active_columns,
    }


def find_risks(request: AgentRequest) -> dict[str, Any]:
    pairs = _flatten(request.board)
    overdue = [
        task.title
        for column, task in pairs
        if _is_overdue(task, column, request.as_of)
    ]
    urgent = [
        task.title
        for column, task in pairs
        if task.priority == "URGENT" and not _is_done(column)
    ]
    unassigned_active = [
        task.title
        for column, task in pairs
        if task.assignee is None and not _is_done(column)
    ]
    workload = [
        {"column": column.name, "task_count": len(column.tasks)}
        for column in request.board.columns
        if not _is_done(column) and len(column.tasks) >= 4
    ]
    return {
        "overdue_tasks": overdue[:8],
        "urgent_open_tasks": urgent[:8],
        "unassigned_open_tasks": unassigned_active[:8],
        "busy_columns": workload[:5],
    }


def summarize_activity(request: AgentRequest) -> dict[str, Any]:
    activity = request.activities[:20]
    contributors = Counter(item.userName for item in activity)
    return {
        "events_reviewed": len(activity),
        "contributors": [
            {"name": name, "events": count}
            for name, count in contributors.most_common(5)
        ],
        "latest_updates": [item.detail for item in activity[:3]],
    }


TOOLS: dict[str, Callable[[AgentRequest], dict[str, Any]]] = {
    "summarize_board": summarize_board,
    "find_risks": find_risks,
    "summarize_activity": summarize_activity,
}


def _find_task(
    request: AgentRequest, query: str
) -> tuple[ColumnSnapshot, TaskSnapshot] | None:
    normalized_query = query.casefold()
    matches = [
        (column, task)
        for column, task in _flatten(request.board)
        if task.title.casefold() in normalized_query
    ]
    return max(matches, key=lambda pair: len(pair[1].title)) if matches else None


def _find_destination(
    request: AgentRequest, query: str
) -> ColumnSnapshot | None:
    matches = [
        column
        for column in request.board.columns
        if re.search(
            rf"\b(?:to|into|in)\s+{re.escape(column.name)}\b",
            query,
            flags=re.IGNORECASE,
        )
    ]
    return max(matches, key=lambda column: len(column.name)) if matches else None


def _plan_action(request: AgentRequest) -> tuple[ProposedAction | None, str | None]:
    query = request.query.strip()
    normalized = query.casefold()

    priority_match = re.search(
        r"\b(?:priority\s+(?:of\s+)?|priority\s+to\s+)(.+?)\s+"
        r"(?:to\s+)?(urgent|high|normal|medium|low)\s*(?:priority)?\s*$",
        query,
        flags=re.IGNORECASE,
    )
    if priority_match:
        task_match = _find_task(request, priority_match.group(1))
        if not task_match:
            return None, "I couldn't match that task to a card on this board. Include its exact task title."
        priority = {
            "urgent": "URGENT",
            "high": "HIGH",
            "normal": "MEDIUM",
            "medium": "MEDIUM",
            "low": "LOW",
        }[priority_match.group(2).casefold()]
        column, task = task_match
        return ProposedAction(
            tool="set_priority",
            task_id=task.id,
            task_title=task.title,
            column_id=column.id,
            column_name=column.name,
            priority=priority,
        ), None

    move_verb = re.search(r"\b(?:move|put|shift)\b", normalized)
    destination = _find_destination(request, query)
    if move_verb and destination:
        task_match = _find_task(request, query)
        if not task_match:
            return None, "I couldn't match that task to a card on this board. Include its exact task title."
        source, task = task_match
        if source.id == destination.id:
            return None, f'"{task.title}" is already in {destination.name}.'
        return ProposedAction(
            tool="move_task",
            task_id=task.id,
            task_title=task.title,
            column_id=destination.id,
            column_name=destination.name,
            position=len(destination.tasks),
        ), None
    if move_verb:
        return None, "Tell me the exact task title and destination column, for example: “Move Draft launch email to In progress”."

    create_match = re.match(
        r"^\s*(?:please\s+)?(?:create|add|make)\s+(?:a\s+)?(?:task|card)\b\s*"
        r"(?:(?:called|named)\s+|[:\-]\s*)?(.*?)\s*$",
        query,
        flags=re.IGNORECASE,
    )
    if create_match:
        title = create_match.group(1).strip(" .")
        priority = "MEDIUM"
        priority_suffix = re.search(
            r"\s+with\s+(urgent|high|normal|medium|low)\s+priority\s*$",
            title,
            flags=re.IGNORECASE,
        )
        if priority_suffix:
            priority = {
                "urgent": "URGENT",
                "high": "HIGH",
                "normal": "MEDIUM",
                "medium": "MEDIUM",
                "low": "LOW",
            }[priority_suffix.group(1).casefold()]
            title = title[: priority_suffix.start()].strip()

        destination = _find_destination(request, title)
        if destination:
            suffix = re.search(
                rf"\s+(?:to|into|in)\s+{re.escape(destination.name)}\s*$",
                title,
                flags=re.IGNORECASE,
            )
            if suffix:
                title = title[: suffix.start()].strip()
        else:
            destination = next(
                (
                    column
                    for column in request.board.columns
                    if column.name.casefold() == "to do"
                ),
                request.board.columns[0] if request.board.columns else None,
            )
        if not title:
            return None, "Add a short task title, for example: “Create task: Write release notes”."
        if not destination:
            return None, "This board has no columns yet, so I can't suggest where to put the task."
        return ProposedAction(
            tool="create_task",
            title=title[:160],
            column_id=destination.id,
            column_name=destination.name,
            priority=priority,
        ), None

    if any(word in normalized for word in ("focus", "next", "recommend", "priorit")):
        return None, None
    if not query:
        return None, "Tell me what you would like to analyze or ask me to do."
    return None, None


def run_agent(request: AgentRequest) -> AgentResponse:
    summary = TOOLS["summarize_board"](request)
    risks = TOOLS["find_risks"](request)
    activity = TOOLS["summarize_activity"](request)
    tools_executed = [
        ToolRun(name="summarize_board", result=summary),
        ToolRun(name="find_risks", result=risks),
        ToolRun(name="summarize_activity", result=activity),
    ]

    task_count = summary["task_count"]
    completed = summary["completed_count"]
    insights: list[str] = []
    if risks["overdue_tasks"]:
        insights.append(
            f'{len(risks["overdue_tasks"])} overdue task(s): '
            + ", ".join(risks["overdue_tasks"][:3])
            + "."
        )
    if risks["urgent_open_tasks"]:
        insights.append(
            f'Give urgent work a look: {", ".join(risks["urgent_open_tasks"][:3])}.'
        )
    if risks["unassigned_open_tasks"]:
        insights.append(
            f'{len(risks["unassigned_open_tasks"])} open task(s) have no assignee.'
        )
    if risks["busy_columns"]:
        busiest = max(risks["busy_columns"], key=lambda item: item["task_count"])
        insights.append(
            f'{busiest["column"]} has {busiest["task_count"]} tasks; '
            "consider whether anything can move forward."
        )
    if not insights:
        insights.append("No overdue, unassigned, or urgent work stands out right now.")
    if activity["events_reviewed"]:
        latest = activity["latest_updates"][0]
        insights.append(f"Latest team update: {latest}")
    else:
        insights.append("No activity has been logged yet for this branch.")

    action, clarification = _plan_action(request)
    if task_count:
        summary_text = (
            f'{request.board.name} has {task_count} task(s) across '
            f'{summary["column_count"]} column(s). {completed} are complete '
            f'({summary["completion_percent"]}%).'
        )
    else:
        summary_text = (
            f'{request.board.name} is ready for its first task across '
            f'{summary["column_count"]} column(s).'
        )

    return AgentResponse(
        summary=summary_text,
        metrics={
            "total_tasks": task_count,
            "completed": completed,
            "completion_percent": summary["completion_percent"],
            "overdue": summary["overdue_count"],
            "unassigned": summary["unassigned_count"],
        },
        insights=insights[:6],
        tools_executed=tools_executed,
        proposed_action=action,
        clarification=clarification,
    )
