import * as assert from "assert";
import * as vscode from "vscode";
import fetch from "node-fetch";

import { findTask } from "../../extension";

const SERVE_TASK_TYPE = "npm";
const SERVE_TASK_SCRIPT = "serve";
const SERVE_TASK_CRITERIA = {
    "definition": {
        "type": SERVE_TASK_TYPE,
        "script": SERVE_TASK_SCRIPT
    }
};

// Helper to allow 'sleeping' in a test
function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }


suite("Extension Test Suite", () => {
    vscode.window.showInformationMessage("Start all tests.");

    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const serveTask = await findTask(SERVE_TASK_CRITERIA);

        assert.ok(!!serveTask, "Serve task not found");
        assert.strictEqual(serveTask.definition.type, "npm");
        assert.strictEqual(serveTask.definition.script, "serve");
    });

    test("Execute Serve Task & Terminate", async () => {
        const serveTask = await findTask(SERVE_TASK_CRITERIA);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        let testData = { readyForTest: false };

        for (let i = 0; i < 5000; i += 100) {
            try {
                testData = <any>await (await fetch("http://localhost:3000/test.json")).json();
            } catch {
                await delay(100); // Wait for the service to actually startup
            }
        }
        
        assert.ok(testData.readyForTest);
        runningTask.terminate();
    }).timeout(20 * 1000);
});