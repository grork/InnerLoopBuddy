import * as vscode from "vscode";
import * as _ from "lodash";

export const EXTENSION_ID = "codevoid.simplebrowser-helper-extension";
export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MONITORED_TASKS_SETTING_SECTION = "monitoredTasks";
export const TASK_BEHAVIOUR_SETTING_SECTION = "taskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;

const SHOW_SETTINGS_BUTTON = "Configure in settings";

/**
 * The information to match a specific task when trying to open a browser. The
 * information is "deep equality" checked against the `vscode.Task` instance. If
 * and only if all the propertie are present, *and* those properties match.
 */
type TaskCriteria = { [name: string]: any };

/**
 * Type container for an instance or undefined (e.g. an optional)
 */
type Maybe<T> = T | undefined;

/**
 * Checks if the supplied task matches the criteria required
 * @param task Task to inspect for a match
 * @param criteria Criteria to search for in the task 
 * @returns True if the task matches the criteria
 */
function isTargetTask(task: vscode.Task, criteria: TaskCriteria[]): boolean {
    return criteria.some((c) => _.isMatch(task, c));
}

/**
 * Searches all tasks defined in this session for a match
 * @param criteria Criteria to find a matching task
 * @returns Promise containing the task if there is a match; undefined otherwise.
 */
export async function findTargetTask(criteria: TaskCriteria[]): Promise<Maybe<vscode.Task>> {
    const foundTasks = await vscode.tasks.fetchTasks();
    return foundTasks.find((task) => isTargetTask(task, criteria));
}

/**
 * Searches all currently executing tasks for one that matches the supplied
 * criteria.
 * @param criteria Criteria to find a matching task
 * @returns The matching criteria, if found.
 */
export function isTargetTaskRunning(criteria: TaskCriteria[]): Maybe<boolean> {
    return !!vscode.tasks.taskExecutions.find((executingTask:vscode.TaskExecution) => isTargetTask(executingTask.task, criteria));
}

/**
 * Monitors the current session to task starts, and if they match the supplied
 * criteria completes the promise available in waitForTask.
 */
export class TaskMonitor {
    private _subscriptions: { dispose(): any }[] = [];
    private _completionPromise: Promise<void>;
    private _resolvePromise?: () => void;
    
    /**
     * Constructs a new instance and *starts monitoring* for task executions
     * that match the supplied criteria.
     * @param criteria 
     */
    constructor(private criteria: TaskCriteria[]) {
        vscode.tasks.onDidStartTask(this.handleTaskStarting, this, this._subscriptions);
        this._completionPromise = new Promise((resolve, _) => {
            this._resolvePromise = resolve;
        });

        if (isTargetTaskRunning(criteria)) {
            this._resolvePromise!();
            this.dispose();
        }
    }

    dispose() {
        this._subscriptions.forEach((d) => d.dispose());
        this._subscriptions = [];
        this._resolvePromise = () => { };
    }

    /**
     * Obtain a promise that will complete (or already be completed) when a task
     * that matches the criteria supplied has started, or has already been
     * started.
     * @returns Promise that completes when the task starts
     */
    waitForTask(): Promise<void> {
        return this._completionPromise;
    }

    private handleTaskStarting(e: vscode.TaskStartEvent): void {
        if (!isTargetTask(e.execution.task, this.criteria)) {
            // Not our task, nothing to do
            return;
        }

        this._resolvePromise!();
        this.dispose();
    }
}

/**
 * Extension instance that manages the lifecycle of an extension in vscode.
 */
export class SimpleBrowserHelperExtension {
    openSimpleBrowser(): Thenable<boolean> {
        const config = vscode.workspace.getConfiguration(EXTENSION_ID);
        const defaultBrowserUrl = <string>config.get("defaultUrl");
        if (!defaultBrowserUrl) {
            vscode.window.showInformationMessage("No default URL configured", SHOW_SETTINGS_BUTTON).then((result) => {
                if (result === SHOW_SETTINGS_BUTTON) {
                    // Show the settings page prefiltered to our settings
                    vscode.commands.executeCommand("workbench.action.openSettings2", { "query": `${EXTENSION_ID}.${DEFAULT_URL_SETTING_SECTION}` });
                    return;
                }

                // Dismissed, so do nothing
                return;
            });

            return Promise.resolve(false);
        }

        return vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(defaultBrowserUrl)).then(() => true);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const instance = new SimpleBrowserHelperExtension();

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, () => instance.openSimpleBrowser()));
}