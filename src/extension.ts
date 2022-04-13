import * as vscode from "vscode";
import * as _ from "lodash";

export const EXTENSION_ID = "codevoid.simplebrowser-helper-extension";
export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MONITORED_TASKS_SETTING_SECTION = "monitoredTasks";
export const TASK_BEHAVIOUR_SETTING_SECTION = "taskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;

const SHOW_SETTINGS_BUTTON = "Configure in settings";

/**
 * What type of monitoring should happen
 */
const enum MonitoringType {
    /**
     * There is no monitoring, and only manual command invocation is available
     */
    None = "none",

    /**
     * The first time the task executes, or if it's already running on extension
     * startup
     */
    OneTime = "onetime",
    
    /**
     * Every time the task executes, and if it's already running on extension
     * startup
     */
    Everytime = "everytime"
}

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

async function getConfigurationScopeFromActiveEditor(probeSetting: string): Promise<Maybe<vscode.ConfigurationScope>>  {
    let context = vscode.window.activeTextEditor;
    if (context) {
        return Promise.resolve(context.document.uri);
    }

    if (!(vscode.workspace.workspaceFolders?.length) && !vscode.workspace.workspaceFile) {
        // The empty workspace, so we don't have any idea what config to get
        return Promise.resolve(undefined);
    }

    // If there is only one workspace, lets use that
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length === 1) {
        return Promise.resolve(vscode.workspace.workspaceFolders[0]);
    }

    // 1. No Editor (so no active context)
    // 2. We have more than one folder (so we *may* have conflicting settings
    //
    // There may not be a setting on a folder, but that doesn't mean there isn't
    // one on the workspace. Because there is more than one folder, those folders
    // could also be in conflict.
    //
    // We can determine if there is a *folder* setting by getting the configuration
    // section and `inspect()`ing it. This tells us what the value is at each
    // scope.
    let settingHasValueSet = 0;

    for (const folder of vscode.workspace.workspaceFolders!) {
        const folderConfiguration = vscode.workspace.getConfiguration(EXTENSION_ID, folder);
        const settingValueByScope = folderConfiguration.inspect(probeSetting);
        if (settingValueByScope?.workspaceFolderValue) {
            settingHasValueSet += 1;
        }
    }

    if (settingHasValueSet === 0) {
        // No per-folder settings, so return the workspaceFile scope
        return Promise.resolve(vscode.workspace.workspaceFile);
    }

    // There wasn't an active editor, and there was more than one workspace, so
    // show a picker to the user to allow them to chose
    return vscode.window.showWorkspaceFolderPick({
        placeHolder: "Workspace to open default browser for",
        ignoreFocusOut: true,
    });
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
    openSimpleBrowser(scope: Maybe<vscode.ConfigurationScope>): Thenable<boolean> {
        const config = vscode.workspace.getConfiguration(EXTENSION_ID, scope);
        const defaultBrowserUrl = <string>config.get("defaultUrl");
        if (!defaultBrowserUrl) {
            vscode.window.showInformationMessage("No default URL configured", SHOW_SETTINGS_BUTTON).then((result) => {
                if (result === SHOW_SETTINGS_BUTTON) {
                    // Show the settings page prefiltered to our settings
                    vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", { "query": `${EXTENSION_ID}.${DEFAULT_URL_SETTING_SECTION}` });
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

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, async () => {
        return instance.openSimpleBrowser(await getConfigurationScopeFromActiveEditor(DEFAULT_URL_SETTING_SECTION));
    }));
}