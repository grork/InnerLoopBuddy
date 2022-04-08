import * as assert from "assert";
import * as vscode from "vscode";
import fetch from "node-fetch";

type Maybe<T> = T | null;

const SERVE_TASK_TYPE = "npm";
const SERVE_TASK_SCRIPT = "serve";

// Helper to allow 'sleeping' in a test
function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }


suite("Extension Test Suite", () => {
    vscode.window.showInformationMessage("Start all tests.");

    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const foundTasks = await vscode.tasks.fetchTasks({ type: "npm" });
        let serveTask: Maybe<vscode.Task> = null;

        for (const task of foundTasks) {
            if (!task.definition || task.definition.type !== SERVE_TASK_TYPE || task.definition["script"] !== SERVE_TASK_SCRIPT) {
                continue;
            }

            serveTask = task;
        }

        assert.ok(!!serveTask, "Serve task not found")
    });

    test("Execute Serve Task & Terminate", async () => {
        const foundTasks = await vscode.tasks.fetchTasks({ type: "npm" });
        let serveTask: Maybe<vscode.Task> = null;

        for (const task of foundTasks) {
            if (!task.definition || task.definition.type !== SERVE_TASK_TYPE || task.definition["script"] !== SERVE_TASK_SCRIPT) {
                continue;
            }

            serveTask = task;
        }

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        await delay(5000); // Wait for the service to actually startup
        const testData: { readyForTest: boolean } = <any>await (await fetch("http://localhost:3000/test.json")).json();
        
        assert.ok(testData.readyForTest);
        runningTask.terminate();
    }).timeout(20 * 1000);
});