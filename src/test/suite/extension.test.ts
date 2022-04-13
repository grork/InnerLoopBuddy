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
 * For most tests, we just need to resolve one task, and the scope doesn't matter
 */
function alwaysResolveServeTask(scope: impl.ActualTaskScope): impl.TaskCriteria[] {
    return [SERVE_TASK_CRITERIA];
}

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

async function clearExtensionSettings(): Promise<void> {
    const workspaceFolder = (vscode.workspace.workspaceFolders)![0]; // assume one workspace folder in our sample project
    const configuration = vscode.workspace.getConfiguration(impl.EXTENSION_ID, workspaceFolder);

    await configuration.update(impl.DEFAULT_URL_SETTING_SECTION, undefined);
    await configuration.update(impl.MONITORED_TASKS_SETTING_SECTION, undefined);
    await configuration.update(impl.TASK_BEHAVIOUR_SETTING_SECTION, undefined);
}

async function applyExtensionSettings(explicitSettings: any): Promise<void> {
    const workspaceFolder = (vscode.workspace.workspaceFolders)![0]; // assume one workspace folder in our sample project
    const configuration = vscode.workspace.getConfiguration(impl.EXTENSION_ID, workspaceFolder);

    await configuration.update(impl.DEFAULT_URL_SETTING_SECTION, explicitSettings.defaultUrl);
    await configuration.update(impl.MONITORED_TASKS_SETTING_SECTION, explicitSettings.monitoredTasks);
    await configuration.update(impl.TASK_BEHAVIOUR_SETTING_SECTION, explicitSettings.taskBehavior);
}

suite("Workspace under-test configuration validation", function () {
    this.timeout(20 * 1000);

    this.beforeEach(async () => await clearExtensionSettings());

    test("Sample workspace was opened", () => {
        assert.strictEqual(vscode.workspace.name, "sample-project");
    });

    test("Opened workspace has appropriate serve task", async () => {
        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);

        assert.ok(!!serveTask, "Serve task not found");
        assert.strictEqual(serveTask.definition.type, "npm");
        assert.strictEqual(serveTask.definition.script, "serve");
    });

    test("Serve Task starts sample site", async () => {
        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());
    });
});

suite("Task Discovery & Monitoring", function () {
    this.timeout(20 * 1000);

    this.beforeEach(async () => await clearExtensionSettings());

    test("Already executing task can be discovered", async () => {
        assert.ok(!impl.isTargetTaskRunning(alwaysResolveServeTask),
            "task should not be running");

        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());

        assert.ok(impl.isTargetTaskRunning(alwaysResolveServeTask));
        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());
    });

    test("When a task is not started, promise completes when started", async () => {
        const monitor = new impl.TaskMonitor(alwaysResolveServeTask);
        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);
        let didObserveTaskStarting = false;
        const taskStartedPromise = monitor.waitForTask().then(() => didObserveTaskStarting = true);

        assert.ok(!impl.isTargetTaskRunning(alwaysResolveServeTask),
            "task should not be running");

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(alwaysResolveServeTask));

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());

        await taskStartedPromise;
        assert.ok(didObserveTaskStarting);
        monitor.dispose();
    });

    test("Promise doesn't complete for non-matching task", async () => {
        const monitor = new impl.TaskMonitor(alwaysResolveServeTask);
        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);
        let targetTaskExecutionCount = 0;
        const taskStartedPromise = monitor.waitForTask().then(() => targetTaskExecutionCount += 1);

        assert.ok(!impl.isTargetTaskRunning(alwaysResolveServeTask),
            "task should not be running");
        
        const testShellTask = await impl.findTargetTask([{ "definition": { "type": "shell" }, "name": "testshelltask" }]);
        assert.ok(!!testShellTask, "Test Shell Task not found");

        const executingShellTask = await vscode.tasks.executeTask(testShellTask);
        executingShellTask.terminate();

        // Now run the serve task
        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(alwaysResolveServeTask));

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());

        await taskStartedPromise;
        assert.strictEqual(targetTaskExecutionCount, 1);
        monitor.dispose();
    });

    test("Promise is completed on construction if task is already started", async () => {
        const serveTask = await impl.findTargetTask([SERVE_TASK_CRITERIA]);

        assert.ok(!impl.isTargetTaskRunning(alwaysResolveServeTask),
            "task should not be running");

        const runningTask = await vscode.tasks.executeTask(<vscode.Task>serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(alwaysResolveServeTask));

        const monitor = new impl.TaskMonitor(alwaysResolveServeTask);
        let didObserveTaskStarting = false;
        await monitor.waitForTask().then(() => didObserveTaskStarting = true);

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());

        assert.ok(didObserveTaskStarting);
        monitor.dispose();
    });
});

suite("Command Handling", function () {
    this.timeout(20 * 1000);
    
    this.beforeEach(async () => await clearExtensionSettings());
    this.afterEach(async () => await clearExtensionSettings());

    test("Browser Opens via Command", async () => {
        await applyExtensionSettings({
            defaultUrl: "http://localhost:3000"
        });

        assert.ok(await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID));
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });

    test("Browser doesn't open via Command when no URL set", async () => {
        assert.ok(!await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID));
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });
})