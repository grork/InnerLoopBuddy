import * as assert from "assert";
import * as vscode from "vscode";
import fetch from "node-fetch";

import * as impl from "../../extension";

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

async function testSiteIsUnavailable(): Promise<boolean> {
    let testData = { readyForTest: false };
    const DELAY_INCREMENT = 100;

    for (let i = 0; i < 5000; i += DELAY_INCREMENT) {
        try {
            testData = <any>await (await fetch("http://localhost:3000/test.json")).json();
            await delay(DELAY_INCREMENT);
        } catch {
            return true;
        }
    }
    
    return false;
}


suite("Workspace under-test configuration validation", function () {
    this.timeout(20 * 1000);

    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const serveTask = await impl.findTargetTask(SERVE_TASK_CRITERIA);

        assert.ok(!!serveTask, "Serve task not found");
        assert.strictEqual(serveTask.definition.type, "npm");
        assert.strictEqual(serveTask.definition.script, "serve");
    });

    test("Serve Task starts sample site", async () => {
        const serveTask = await impl.findTargetTask(SERVE_TASK_CRITERIA);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());
    });
});

suite("Task Discovery & Monitoring", function () {
    this.timeout(20 * 1000);

    test("Already executing task can be discovered", async () => {
        assert.ok(!impl.isTargetTaskRunning(SERVE_TASK_CRITERIA),
            "task should not be running");
        
        const serveTask = await impl.findTargetTask(SERVE_TASK_CRITERIA);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());

        assert.ok(impl.isTargetTaskRunning(SERVE_TASK_CRITERIA));

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());
    });

    test("When a task is not started, promise completes when started", async () => {
        const monitor = new impl.TaskMonitor(SERVE_TASK_CRITERIA);
        const serveTask = await impl.findTargetTask(SERVE_TASK_CRITERIA);
        let didObserveTaskStarting = false;
        const taskStartedPromise = monitor.waitForTask().then(() => didObserveTaskStarting = true);

        assert.ok(!impl.isTargetTaskRunning(SERVE_TASK_CRITERIA),
            "task should not be running");

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(SERVE_TASK_CRITERIA));

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());

        await taskStartedPromise;
        assert.ok(didObserveTaskStarting);
    });

    test("Promise is completed on construction if task is already started", async () => {
        const serveTask = await impl.findTargetTask(SERVE_TASK_CRITERIA);

        assert.ok(!impl.isTargetTaskRunning(SERVE_TASK_CRITERIA),
            "task should not be running");

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(SERVE_TASK_CRITERIA));

        const monitor = new impl.TaskMonitor(SERVE_TASK_CRITERIA);
        let didObserveTaskStarting = false;
        await monitor.waitForTask().then(() => didObserveTaskStarting = true);

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());

        assert.ok(didObserveTaskStarting);
    });
});