from datetime import date
import unittest

from app.agent import (
    ActivitySnapshot,
    AgentRequest,
    BoardSnapshot,
    ColumnSnapshot,
    PersonSnapshot,
    TaskSnapshot,
    run_agent,
)


def sample_board() -> BoardSnapshot:
    return BoardSnapshot(
        id="board-1",
        name="Launch board",
        columns=[
            ColumnSnapshot(
                id="todo",
                name="To do",
                tasks=[
                    TaskSnapshot(
                        id="task-1",
                        title="Write launch email",
                        priority="URGENT",
                        dueDate="2026-10-30T12:00:00Z",
                    ),
                    TaskSnapshot(
                        id="task-2",
                        title="Review landing page",
                        priority="HIGH",
                        assignee=PersonSnapshot(id="person-1", name="Alex"),
                    ),
                ],
            ),
            ColumnSnapshot(id="progress", name="In progress"),
            ColumnSnapshot(
                id="done",
                name="Done",
                tasks=[
                    TaskSnapshot(
                        id="task-3",
                        title="Agree on launch date",
                        dueDate="2026-10-01T12:00:00Z",
                    )
                ],
            ),
        ],
    )


class AgentTests(unittest.TestCase):
    def request(self, query: str) -> AgentRequest:
        return AgentRequest(
            query=query,
            board=sample_board(),
            as_of=date(2026, 11, 2),
            activities=[
                ActivitySnapshot(
                    action="task.updated",
                    detail='updated priority on "Review landing page"',
                    createdAt="2026-11-02T10:00:00Z",
                    userName="Alex",
                )
            ],
        )

    def test_runs_analytics_tools_and_ignores_completed_overdue_tasks(self) -> None:
        result = run_agent(self.request("What should we focus on?"))

        self.assertEqual(result.metrics["total_tasks"], 3)
        self.assertEqual(result.metrics["completed"], 1)
        self.assertEqual(result.metrics["overdue"], 1)
        self.assertEqual(
            [tool.name for tool in result.tools_executed],
            ["summarize_board", "find_risks", "summarize_activity"],
        )
        self.assertIn("Write launch email", result.tools_executed[1].result["overdue_tasks"])
        self.assertNotIn("Agree on launch date", result.tools_executed[1].result["overdue_tasks"])

    def test_proposes_create_action_in_named_column_and_priority(self) -> None:
        result = run_agent(
            self.request("Create task: Write release notes in To do with high priority")
        )

        self.assertIsNotNone(result.proposed_action)
        self.assertEqual(result.proposed_action.tool, "create_task")
        self.assertEqual(result.proposed_action.title, "Write release notes")
        self.assertEqual(result.proposed_action.column_id, "todo")
        self.assertEqual(result.proposed_action.priority, "HIGH")
        self.assertTrue(result.proposed_action.confirmation_required)

    def test_proposes_move_for_exact_board_task(self) -> None:
        result = run_agent(
            self.request("Move Write launch email to In progress")
        )

        self.assertEqual(result.proposed_action.tool, "move_task")
        self.assertEqual(result.proposed_action.task_id, "task-1")
        self.assertEqual(result.proposed_action.column_id, "progress")

    def test_proposes_priority_change_for_exact_board_task(self) -> None:
        result = run_agent(
            self.request("Set priority of Write launch email to high")
        )

        self.assertEqual(result.proposed_action.tool, "set_priority")
        self.assertEqual(result.proposed_action.task_id, "task-1")
        self.assertEqual(result.proposed_action.priority, "HIGH")

    def test_asks_for_clarification_when_task_is_ambiguous(self) -> None:
        result = run_agent(self.request("Move a task to Done"))

        self.assertIsNone(result.proposed_action)
        self.assertIn("exact task title", result.clarification)

    def test_rejects_unexpected_fields_in_request(self) -> None:
        with self.assertRaises(ValueError):
            AgentRequest.model_validate(
                {
                    "query": "summarize",
                    "board": sample_board().model_dump(),
                    "tenant_id": "untrusted",
                }
            )


if __name__ == "__main__":
    unittest.main()
