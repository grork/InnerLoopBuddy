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

interface Throwaway {
    dispose(): any;
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
    const p = getPromiseAndCompletion<void>();
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (vscode.workspace.workspaceFolders!.length !== target) {
            return;
        }

        disposable.dispose();
        p.completion();
    });

    return p.promise;
}

function waitForTaskProcessToEnd(targetTask: vscode.Task): Promise<number> {
    const p = getPromiseAndCompletion<number>();
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task !== targetTask) {
            return;
        }

        disposable.dispose();
        p.completion(e.exitCode!);
    });

    return p.promise;
}

function getPromiseAndCompletion<T>(): { completion: (v: T) => any; promise: Promise<T> } {
    let completion: (v: T) => any = (v) => { };
    const promise = new Promise<T>((r) => completion = r);

    return {
        completion,
        promise
    };
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

    test("Event is raised when a matching task is started", async () => {
        const disposables: Throwaway[] = [];
        const echoTask = (await findTargetTask([ECHO_TASK_CRITERIA]))!;

        const taskOberserved = getPromiseAndCompletion<number>();
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        disposables.push(monitor);
        disposables.push(monitor.onDidMatchingTaskExecute((count) => taskOberserved.completion(count)));

        assert.ok(!monitor.isTargetTaskRunning(), "task should not be running");

        const processTerminated = waitForTaskProcessToEnd(echoTask);
        await vscode.tasks.executeTask(echoTask);

        const exitCode = await processTerminated;
        assert.strictEqual(exitCode, 99, "Wrong exit code");

        const observedTaskExecutions = await taskOberserved.promise;
        assert.strictEqual(observedTaskExecutions, 1, "Wrong number of task exections observed");

        (vscode.Disposable.from(...disposables)).dispose();
    });

    test("Event isn't raised when a non-matching task is executed", async () => {
        const disposables: Throwaway[] = [];

        let didObserveTaskStarting = -1;
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        disposables.push(monitor);
        disposables.push(monitor.onDidMatchingTaskExecute((count) => didObserveTaskStarting = count));

        assert.ok(!monitor.isTargetTaskRunning(), "task should not be running");

        // Execute the not-the-target-task
        const npmInstall = await findTargetTask([{ "definition": { "type": "shell" }, "name": "install" }]);
        assert.ok(!!npmInstall, "NPM Install Shell Task not found");

        const notShellTaskComplete = waitForTaskProcessToEnd(npmInstall);
        await vscode.tasks.executeTask(npmInstall);
        await notShellTaskComplete;

        assert.strictEqual(didObserveTaskStarting, -1, "Task shouldn't have been executed");

        vscode.Disposable.from(...disposables).dispose();
    });

    test("Event count accounts for the task having been running at instantiation", async () => {
        const disposables: Throwaway[] = [];
        const resolver = getTestTaskResolverForCriteria([SERVE_TASK_CRITERIA]);
        const serveTask = (await findTargetTask([SERVE_TASK_CRITERIA]))!;
        assert.ok(!impl.isTargetTaskRunning(resolver), "task should not be running");

        // Start the task & make sure it's running
        let runningTask = await vscode.tasks.executeTask(serveTask);
        assert.ok(await testSiteIsAvailable());

        // Instantiate the monitor, and ensure it sees the task running
        const monitor = new impl.TaskMonitor(resolver);
        disposables.push(monitor);
        assert.ok(monitor.isTargetTaskRunning(), "Task should have started");

        runningTask.terminate();
        assert.ok(await testSiteIsUnavailable());

        // Listen for the task starting event
        const taskOberserved = getPromiseAndCompletion<number>();
        disposables.push(monitor.onDidMatchingTaskExecute((c) => taskOberserved.completion(c)));

        // Start the stask
        runningTask = await vscode.tasks.executeTask(serveTask);
        assert.ok(await testSiteIsAvailable());
        runningTask.terminate();
        assert.ok(await testSiteIsUnavailable());

        assert.strictEqual(await taskOberserved.promise, 2, "Not enough task executions");

        vscode.Disposable.from(...disposables).dispose();
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
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");        
    });

    test("Browser doesn't open via Command when no URL set", async () => {
        assert.ok(!await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID));
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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

    this.beforeEach(() => {
        assert.strictEqual(vscode.workspace.workspaceFolders!.length, 2, "Not enough workspaces");
        return clearExtensionSettings();
    });

    test("TaskMonitor: Compeletes only for starting matching task", async () => {
        const disposables: Throwaway[] = [];

        // Primarily work with the default folder
        const targetFolder = vscode.workspace.workspaceFolders![0];

        // Configure Monitoring on the first project
        await applyExtensionSettings({ monitoredTasks: [ECHO_TASK_CRITERIA] }, targetFolder);

        // Obtain the serve task from the *first* project
        const defaultEchoTask = (await findTargetTask([ECHO_TASK_CRITERIA], targetFolder))!;

        // Start task monitoring
        const monitor = new impl.TaskMonitor();
        disposables.push(monitor);
        
        // Listen for the task from the first project
        const taskWasStarted = getPromiseAndCompletion<number>();
        let observedEventInvocations = 0;
        disposables.push(monitor.onDidMatchingTaskExecute((c) => {
            observedEventInvocations += 1;
            taskWasStarted.completion(c);
        }));
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
        assert.strictEqual(observedEventInvocations, 0, "Event shouldn't have been raised");

        // Now execute the target task.
        const echoTaskExited = waitForTaskProcessToEnd(defaultEchoTask);
        await vscode.tasks.executeTask(defaultEchoTask);
        const echoTaskExitCode = await echoTaskExited;
        assert.strictEqual(echoTaskExitCode, 99, "Echo exit code was wrong")
        
        assert.strictEqual(await taskWasStarted.promise, 1, "Wrong number of events");
        assert.strictEqual(observedEventInvocations, 1, "Should only see one event raised");
        
        vscode.Disposable.from(...disposables).dispose();
    });

    test("Command: Active Editor Picks Correct configuration", async () => {
        const defaultWorkspace = vscode.workspace.workspaceFolders![0];

        // Set a configuration with a URL for one project, but not the other
        await applyExtensionSettings({
            defaultUrl: "http://localhost:3000/"
        }, defaultWorkspace);

        // Open a document from the default projects
        const indexUri = vscode.Uri.joinPath(defaultWorkspace.uri, "index.html");
        await vscode.window.showTextDocument(indexUri);

        // Execute the command
        assert.ok(await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID), "Command Failed to execute");
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");

        // Open the second index (Which should fail the command)
        const index2Uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![1].uri, "index2.html");
        await vscode.window.showTextDocument(index2Uri);

        assert.ok(!(await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID)), "Command Shouldn't have executed");
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
});