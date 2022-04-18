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

/**
 * Helper for disposables. VS code defines a specific *class*, but the contracts
 * are dependent on a simpler interface. Rather than having to type it
 * everywhere, lets have a type.
 */
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

/**
 * Adding a workspace folder is async, so we'd like to know when we've completed
 * adding a folder. However, the `updateWorkspaceFolders` method does not
 * provide a promise for completion. We need to listen for an event saying the
 * folders have changed. This wraps that in a promise.
 */
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

/**
 * Our simple tasks do terminate, but the `task.terminate` method doesn't
 * have a promise for completion. So we need to listen to an event signifying
 * that a tasks *process* has completed. This wraps that event in a promise.
 * 
 * NB: The process end event is unreliable. For simple tasks it's OK, but for
 * something like the HTTP server in these tests, it's unreliable.
 */
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

/**
 * Helper that gets a promise instance + it's completion callback in one call.
 * Mostly I don't like the declare, instantiate, extract dance in multiple
 * places
 * @returns an object with `completion` to complete (resolve) the promise, and
 *          `promise` for the promise that will be compelted.
 */
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
        const taskMatches = impl.taskMatchesCriteria(task, criteria);
        let isTargetScope = true;
        if (taskScope) {
            isTargetScope = task.scope == taskScope;
        }

        return taskMatches && isTargetScope;
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

    test("Extension can be obtained, and hasn't been initialized", () => {
        const extension = vscode.extensions.getExtension(impl.EXTENSION_ID);
        const instance: impl.InnerLoopBuddyExtension = extension!.exports;
        assert.ok(instance, "Extension hasn't been activated");
        assert.ok(!instance.isInitialized, "Extension shouldn't have been initialized");
    });

    test("Sample workspace was opened", () => {
        assert.ok(vscode.workspace.workspaceFile, "Should have opened an actual workspace file");
        assert.ok(vscode.workspace.workspaceFile.path.endsWith("/sample.code-workspace"), "Wrong workspace opened");
    });

    test("Opened workspace has appropriate echo task", async () => {
        const echoTask = await findTargetTask([ECHO_TASK_CRITERIA]);

        assert.ok(!!echoTask, "Echo task not found");
        assert.strictEqual(echoTask.definition.type, ECHO_TASK_TYPE, "Wrong type on found task");
        assert.strictEqual((<vscode.ShellExecution>echoTask.execution).commandLine, ECHO_TASK_COMMAND, "Wrong command on found task");
        assert.strictEqual(echoTask.scope, vscode.workspace.workspaceFolders![0], "Wrong scope on found task");
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

        // Begin monitoring the task
        const taskOberserved = getPromiseAndCompletion<impl.MatchedExecutionOccured>();
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        disposables.push(monitor);
        disposables.push(monitor.onDidMatchingTaskExecute((e) => taskOberserved.completion(e)));

        // We don't want it running yet
        assert.ok(!monitor.isMatchingTaskRunning(), "task should not be running");

        // Prepare to wait for the task completion
        const processTerminated = waitForTaskProcessToEnd(echoTask);

        // Actually execute the task
        await vscode.tasks.executeTask(echoTask);

        // Now wait for it's completion
        const exitCode = await processTerminated;
        assert.strictEqual(exitCode, 99, "Wrong exit code");

        // Make sure it observed the right number of times, and in the right scope
        const observedTaskExecutions = await taskOberserved.promise;
        assert.strictEqual<number>(observedTaskExecutions.occurances, 1, "Wrong number of task exections observed");
        assert.strictEqual<vscode.WorkspaceFolder>(observedTaskExecutions.scope, vscode.workspace.workspaceFolders![0], "Wrong scope");

        (vscode.Disposable.from(...disposables)).dispose();
    });

    test("Event isn't raised when a non-matching task is executed", async () => {
        const disposables: Throwaway[] = [];

        let didObserveTaskStarting = -1;

        // Monitor tasks being executed
        const monitor = new impl.TaskMonitor(getTestTaskResolverForCriteria([ECHO_TASK_CRITERIA]));
        disposables.push(monitor);
        disposables.push(monitor.onDidMatchingTaskExecute((e) => didObserveTaskStarting = e.occurances));

        // We dont want it runnign
        assert.ok(!monitor.isMatchingTaskRunning(), "task should not be running");

        // Execute the not-the-target-task
        const npmInstall = await findTargetTask([{ "definition": { "type": "shell" }, "name": "install" }]);
        assert.ok(!!npmInstall, "NPM Install Shell Task not found");

        // Wiat for it to wrap up
        const notShellTaskComplete = waitForTaskProcessToEnd(npmInstall);
        await vscode.tasks.executeTask(npmInstall);
        await notShellTaskComplete;

        // Really shouldn't have seen any tasks start
        assert.strictEqual(didObserveTaskStarting, -1, "Task shouldn't have been executed");

        vscode.Disposable.from(...disposables).dispose();
    });

    test("Event count accounts for the task having been running at instantiation", async () => {
        const disposables: Throwaway[] = [];
        const resolver = getTestTaskResolverForCriteria([SERVE_TASK_CRITERIA]);
        const serveTask = (await findTargetTask([SERVE_TASK_CRITERIA]))!;
        assert.ok(!impl.isMatchingTaskRunning(resolver), "task should not be running");

        // Start the task & make sure it's running
        let runningTask = await vscode.tasks.executeTask(serveTask);
        assert.ok(await testSiteIsAvailable(), "test site didn't start");

        // Instantiate the monitor, and ensure it sees the task running
        const monitor = new impl.TaskMonitor(resolver);
        disposables.push(monitor);
        assert.strictEqual(monitor.isMatchingTaskRunning()?.scope, vscode.workspace.workspaceFolders![0], "Task should have started in the right scope");

        runningTask.terminate();
        assert.ok(await testSiteIsUnavailable(), "test site still up");

        // Listen for the task starting event
        const taskOberserved = getPromiseAndCompletion<number>();
        disposables.push(monitor.onDidMatchingTaskExecute((e) => taskOberserved.completion(e.occurances)));

        // Start the stask
        runningTask = await vscode.tasks.executeTask(serveTask);
        assert.ok(await testSiteIsAvailable(), "test site didn't start");
        runningTask.terminate();
        assert.ok(await testSiteIsUnavailable(), "test site was still up");

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

        assert.ok(await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID), "Command indicated failure");
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");        
    });

    test("Browser doesn't open via Command when no URL set", async () => {
        assert.ok(!await vscode.commands.executeCommand(impl.OPEN_BROWSER_COMMAND_ID), "Command indicated failure");
        await delay(1 * 1000);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
});

suite("Multiroot", function () {
    this.timeout(20 * 1000);
    this.beforeAll(() => {
        assert.strictEqual(vscode.workspace.workspaceFolders!.length, 1, "We only want to add one folder");
        // Monitor the folder being added
        const folderHasBeenAdded = waitForWorkspaceFoldersToReachTargetCount(2);

        // The new folder is a _child_ of the `code-workspace` file, so we're
        // going to take the base URI of that (which doesn't include the file)
        // and append our second probject to it, and then add it
        const baseUri = vscode.workspace.workspaceFolders![0].uri;
        const secondProjectUri = vscode.Uri.joinPath(baseUri, "../sample-project2");
        vscode.workspace.updateWorkspaceFolders(1, null, { uri: secondProjectUri });

        // Wait for confirmation its been added, and then ensure it's settings
        // are reset to defaults.
        return folderHasBeenAdded.then(() => clearExtensionSettings());
    });

    this.afterAll(async () => {
        // Always clear settings
        await clearExtensionSettings();
        
        // Something already removed (or we failed to add) the second project
        if (vscode.workspace.workspaceFolders!.length === 1) {
            // We're in a good state, no need to clean up
            return;
        }

        // Monitor for it being added, and wait
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
        const taskWasStarted = getPromiseAndCompletion<impl.MatchedExecutionOccured>();
        let observedEventInvocations = 0;
        disposables.push(monitor.onDidMatchingTaskExecute((e) => {
            observedEventInvocations += 1;
            taskWasStarted.completion(e);
        }));
        assert.ok(!monitor.isMatchingTaskRunning(), "task should not be running");

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
        
        assert.strictEqual((await taskWasStarted.promise).occurances, 1, "Wrong number of events");
        assert.strictEqual((await taskWasStarted.promise).scope, vscode.workspace.workspaceFolders![0], "Wrong number of events");
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