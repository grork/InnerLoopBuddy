import * as assert from "assert";
import * as vscode from "vscode";

type Maybe<T> = T | null;


suite("Extension Test Suite", () => {
    vscode.window.showInformationMessage("Start all tests.");

    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const foundTasks = await vscode.tasks.fetchTasks({ type: "npm" });
        let serveTask: Maybe<vscode.Task> = null;

        for (const task of foundTasks) {
            if (!task.definition || task.definition.type !== "npm" || task.definition["script"] !== "serve") {
                continue;
            }

            serveTask = task;
        }

        assert.ok(!!serveTask, "Serve task not found")
    });
});