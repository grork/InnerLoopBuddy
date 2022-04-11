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

/**
 * Helper to allow 'sleeping' in a test
 * */
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

async function testSiteIsAvailable(): Promise<boolean> {
    let testData = { readyForTest: false };
    const DELAY_INCREMENT = 100;

    for (let i = 0; i < 5000; i += DELAY_INCREMENT) {
        try {
            testData = <any>await (await fetch("http://localhost:3000/test.json")).json();
        } catch {
            await delay(DELAY_INCREMENT); // Wait for the service to actually startup
        }
    }
    
    return testData.readyForTest;
}


suite("Workspace under-test configuration validation", () => {
    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const serveTask = await findTask(SERVE_TASK_CRITERIA);

        assert.ok(!!serveTask, "Serve task not found");
        assert.strictEqual(serveTask.definition.type, "npm");
        assert.strictEqual(serveTask.definition.script, "serve");
    });

    test("Serve Task starts sample site", async () => {
        const serveTask = await findTask(SERVE_TASK_CRITERIA);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());

        runningTask.terminate();
    }).timeout(20 * 1000);
});