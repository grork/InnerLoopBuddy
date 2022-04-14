import * as assert from "assert";
import * as vscode from "vscode";
import fetch from "node-fetch";

import * as impl from "../../extension";
import { exit } from "process";

const SERVE_TASK_TYPE = "npm";
const SERVE_TASK_SCRIPT = "serve";
const SERVE_TASK_CRITERIA = {
    "definition": {
        "type": SERVE_TASK_TYPE,
        "script": SERVE_TASK_SCRIPT
    }
};

const ECHO_TASK_TYPE = "shell";
const ECHO_TASK_COMMAND = "echo Test && exit 99";
const ECHO_TASK_CRITERIA = {
    "definition": {
        "type": ECHO_TASK_TYPE
    },
    "execution": {
        "commandLine": ECHO_TASK_COMMAND
    }
}

const ALT_ECHO_TASK_CRITERIA = {
    "definition": {
        "type": ECHO_TASK_TYPE
    },
    "execution": {
        "commandLine": "echo Test2 && exit 98"
    }
}

/**
 * For most tests, we just need to resolve one task, and the scope doesn't matter
 */
function getTestTaskResolverForCriteria(taskToReturn: impl.TaskCriteria[]): (scope: impl.ActualTaskScope) => impl.TaskCriteria[] {
    return () => {
        return taskToReturn;
    };
}

function waitForWorkspaceFoldersToReachTargetCount(target: number): Promise<unknown> {
    let completion: (e?: any) => any = () => { };
    const promise = new Promise((c) => completion = c);
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (vscode.workspace.workspaceFolders!.length !== target) {
            return;
        }

        disposable.dispose();
        completion();
    });

    return promise;
}

function waitForTaskProcessToEnd(targetTask: vscode.Task): Promise<number> {
    let completion: (e: number) => any = () => { -1 };
    const promise = new Promise<number>((c) => completion = c);
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task !== targetTask) {
            return;
        }

        disposable.dispose();
        completion(e.exitCode!);
    });

    return promise;
}

/**
 * Searches all tasks defined in this session for a match
 * @param criteria Criteria to find a matching task
 * @returns Promise containing the task if there is a match; undefined otherwise.
 */
export async function findTargetTask(criteria: impl.TaskCriteria[], taskScope?: impl.ActualTaskScope): Promise<vscode.Task | undefined> {
    const foundTasks = await vscode.tasks.fetchTasks();
    return foundTasks.find((task) => {
        const isTargetTask = impl.isTargetTask(task, criteria);
        let isTargetScope = true;
        if (taskScope) {
            isTargetScope = task.scope == taskScope;
        }

        return isTargetTask && isTargetScope;
    });
}

/**
 * Helper to allow 'sleeping' in a test
 * */
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

async function testSiteIsAvailable(fileToRetreive: string = "test.json"): Promise<boolean> {
    let testData = { readyForTest: false };
    const DELAY_INCREMENT = 100;

    for (let i = 0; i < 5000; i += DELAY_INCREMENT) {
        try {
            testData = <any>await (await fetch(`http://localhost:3000/${fileToRetreive}`)).json();
        } catch {
            await delay(DELAY_INCREMENT); // Wait for the service to actually startup
        }
    }

    return testData.readyForTest;
}

async function testSiteIsUnavailable(fileToRetreive: string = "test.json"): Promise<boolean> {
    let testData = { readyForTest: false };
    const DELAY_INCREMENT = 100;

    for (let i = 0; i < 5000; i += DELAY_INCREMENT) {
        try {
            testData = <any>await (await fetch(`http://localhost:3000/${fileToRetreive}`)).json();
            await delay(DELAY_INCREMENT);
        } catch {
            return true;
        }
    }

    return false;
}

async function clearExtensionSettings(): Promise<void> {
    const configurations: vscode.WorkspaceConfiguration[] = vscode.workspace.workspaceFolders!.map((folder) => vscode.workspace.getConfiguration(impl.EXTENSION_ID, folder));

    for (const config of configurations!) {
        for (const target of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder]) {
            await config.update(impl.DEFAULT_URL_SETTING_SECTION, undefined, target);
            await config.update(impl.MONITORED_TASKS_SETTING_SECTION, undefined, target);
            await config.update(impl.TASK_BEHAVIOUR_SETTING_SECTION, undefined, target);
        }
    }
}

interface ExplicitSettings {
    defaultUrl?: string;
    monitoredTasks?: impl.TaskCriteria[];
    taskBehavior?: impl.MonitoringType;
}

async function applyExtensionSettings(explicitSettings: ExplicitSettings, scope?: vscode.ConfigurationScope): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(impl.EXTENSION_ID, scope);

    await configuration.update(impl.DEFAULT_URL_SETTING_SECTION, explicitSettings.defaultUrl);
    await configuration.update(impl.MONITORED_TASKS_SETTING_SECTION, explicitSettings.monitoredTasks);
    await configuration.update(impl.TASK_BEHAVIOUR_SETTING_SECTION, explicitSettings.taskBehavior);
}

suite("Infrastructure: Workspace under-test configuration validation", function () {
    this.beforeEach(async () => await clearExtensionSettings());

    test("Sample workspace was opened", () => {
        assert.ok(vscode.workspace.workspaceFile, "Should have opened an actual workspace file");
        assert.ok(vscode.workspace.workspaceFile.path.endsWith("/sample.code-workspace"), "Wrong workspace opened");
    });

    test("Opened workspace has appropriate echo task", async () => {
        const echoTask = await findTargetTask([ECHO_TASK_CRITERIA]);

        assert.ok(!!echoTask, "Echo task not found");
        assert.strictEqual(echoTask.definition.type, ECHO_TASK_TYPE);
        assert.strictEqual((<vscode.ShellExecution>echoTask.execution).commandLine, ECHO_TASK_COMMAND);
        assert.strictEqual(echoTask.scope, vscode.workspace.workspaceFolders![0]);
    });

    test("Echo Task executes", async () => {
        const echoTask = (await findTargetTask([ECHO_TASK_CRITERIA]))!;
        const processEnded = waitForTaskProcessToEnd(echoTask);

        await vscode.tasks.executeTask(echoTask);
        const exitCode = await processEnded;

        assert.strictEqual(exitCode, 99, "Exit code of process was wrong")
    });
});

suite("TaskMonitor: Task Discovery & Monitoring", function () {
    this.timeout(20 * 1000);

    this.beforeEach(async () => await clearExtensionSettings());

    test("When a task is not started, promise completes when started", async () => {
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        const echoTask = (await findTargetTask([ECHO_TASK_CRITERIA]))!;
        let didObserveTaskStarting = false;

        const taskStartedPromise = monitor.waitForTask().then(() => didObserveTaskStarting = true);
        const processTerminated = waitForTaskProcessToEnd(echoTask);

        assert.ok(!monitor.isTargetTaskRunning(), "task should not be running");

        await vscode.tasks.executeTask(echoTask);

        const exitCode = await processTerminated;
        assert.strictEqual(exitCode, 99, "Wrong exit code");

        await taskStartedPromise;
        assert.ok(didObserveTaskStarting);
        monitor.dispose();
    });

    test("Promise doesn't complete for non-matching task", async () => {
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        const echoTask = (await findTargetTask([ECHO_TASK_CRITERIA]))!;
        let didObserveTaskStarting = false;
        const taskStartedPromise = monitor.waitForTask().then(() => didObserveTaskStarting = true);

        assert.ok(!monitor.isTargetTaskRunning(), "task should not be running");

        // Execute the not-the-target-task
        const npmInstall = await findTargetTask([{ "definition": { "type": "shell" }, "name": "install" }]);
        assert.ok(!!npmInstall, "NPM Install Shell Task not found");

        const notShellTaskComplete = waitForTaskProcessToEnd(npmInstall);
        await vscode.tasks.executeTask(npmInstall);
        await notShellTaskComplete;

        assert.ok(!didObserveTaskStarting, "Task shouldn't have been executed");

        // Now run the echo task
        const echoTaskCompleted = waitForTaskProcessToEnd(echoTask);
        await vscode.tasks.executeTask(echoTask);
        
        // Check it exited appropriately
        const exitCode = await echoTaskCompleted;
        assert.strictEqual(exitCode, 99);
        
        await taskStartedPromise;
        assert.ok(didObserveTaskStarting, "Task should have started");
        monitor.dispose();
    });

    test("Promise is completed on construction if task is already started", async () => {
        const resolver = getTestTaskResolverForCriteria([SERVE_TASK_CRITERIA]);
        const serveTask = (await findTargetTask([SERVE_TASK_CRITERIA]))!;
        assert.ok(!impl.isTargetTaskRunning(resolver), "task should not be running");

        const runningTask = await vscode.tasks.executeTask(serveTask);
        assert.ok(await testSiteIsAvailable());
        assert.ok(impl.isTargetTaskRunning(resolver), "Task should have started");

        const monitor = new impl.TaskMonitor(resolver);
        let didObserveTaskStarting = false;
        await monitor.waitForTask().then(() => didObserveTaskStarting = true);

        runningTask.terminate();

        assert.ok(await testSiteIsUnavailable());
        assert.ok(didObserveTaskStarting);

        monitor.dispose();
    });
});

suite("Multiroot", function () {
    this.timeout(20 * 1000);
    this.beforeAll(() => {
        assert.strictEqual(vscode.workspace.workspaceFolders!.length, 1);
        const folderHasBeenAdded = waitForWorkspaceFoldersToReachTargetCount(2);

        const baseUri = vscode.workspace.workspaceFolders![0].uri;
        const secondProjectUri = vscode.Uri.joinPath(baseUri, "../sample-project2");

        vscode.workspace.updateWorkspaceFolders(1, null, { uri: secondProjectUri });

        return folderHasBeenAdded.then(() => clearExtensionSettings());
    });

    this.beforeEach(() => assert.strictEqual(vscode.workspace.workspaceFolders!.length, 2));

    test("TaskMonitor: Compeletes only for starting matching task", async () => {
        // Primarily work with the default folder
        const targetFolder = vscode.workspace.workspaceFolders![0];

        // Configure Monitoring on the first project
        await applyExtensionSettings({
            monitoredTasks: [
                ECHO_TASK_CRITERIA
            ]
        }, targetFolder);

        // Start task monitoring
        const monitor = new impl.TaskMonitor();

        // Obtain the serve task from the *first* project
        const defaultEchoTask = (await findTargetTask([ECHO_TASK_CRITERIA], targetFolder))!;
        
        // Listen for the task from the first project
        let didObserveTaskStarting = false;
        const taskStartedPromise = monitor.waitForTask().then(() => didObserveTaskStarting = true);
        assert.ok(!monitor.isTargetTaskRunning(), "task should not be running");

        // Start the task from the *other* project, which shouldn't result
        // in the task triggering.
        const alternativeServeTask = (await findTargetTask([ALT_ECHO_TASK_CRITERIA], vscode.workspace.workspaceFolders![1]))!;
        const alternativeEchoTaskExited = waitForTaskProcessToEnd(alternativeServeTask);
        await vscode.tasks.executeTask(alternativeServeTask);

        // Check that we've completed the alternative task (Which shouldn't
        // trigger anything)
        const alternateExitCode = await alternativeEchoTaskExited;
        assert.strictEqual(alternateExitCode, 98, "Alternate Task had wrong exit code");
        assert.ok(!didObserveTaskStarting, "Monitor shouldn't have been triggered");

        // Now do the intended task.
        const echoTaskExited = waitForTaskProcessToEnd(defaultEchoTask);
        await vscode.tasks.executeTask(defaultEchoTask);
        const echoTaskExitCode = await echoTaskExited;
        assert.strictEqual(echoTaskExitCode, 99, "Echo exit code was wrong")
        
        await taskStartedPromise;
        assert.ok(didObserveTaskStarting);
        monitor.dispose();
    });

    this.afterAll(async () => {
        await clearExtensionSettings();
        
        if (vscode.workspace.workspaceFolders!.length === 1) {
            // We're in a good state, no need to clean up
            return;
        }

        const foldersAtTarget = waitForWorkspaceFoldersToReachTargetCount(1);

        vscode.workspace.updateWorkspaceFolders(1, vscode.workspace.workspaceFolders!.length - 1);

        return foldersAtTarget;
    });
});

suite("Command: Explicit Execution", function () {
    this.beforeEach(async () => {
        await clearExtensionSettings();
        assert.strictEqual(vscode.workspace.workspaceFolders!.length, 1);
    });

    test("Browser Opens via Command", async () => {
        await applyExtensionSettings({
            defaultUrl: "http://localhost:3000"
        }, vscode.workspace.workspaceFolders![0]);

        assert.ok(await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID));
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });

    test("Browser doesn't open via Command when no URL set", async () => {
        assert.ok(!await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID));
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });
});