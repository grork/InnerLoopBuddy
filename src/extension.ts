import * as vscode from "vscode";
import * as _ from "lodash";

export const EXTENSION_ID = "codevoid.inner-loop-buddy";
export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MONITORED_TASKS_SETTING_SECTION = "monitoredTasks";
export const TASK_BEHAVIOUR_SETTING_SECTION = "taskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;

const SHOW_SETTINGS_BUTTON = "Configure in settings";

/**
 * What type of monitoring should happen
 */
export const enum MonitoringType {
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
export type TaskCriteria = { [name: string]: any };

/**
 * Helper type since the TaskScope in vscode.d.ts isn't exported, we need our own
 */
export type ActualTaskScope = vscode.TaskScope.Global | vscode.TaskScope.Workspace | vscode.WorkspaceFolder | undefined;

/**
 * Callback that given an ActualTaskScope will return task criteria *only* for
 * that scope.
 * 
 * Why have this at all? Tasks are defined at multiple levels -- global,
 * workspace, and folder. We want to match task criteria that is releveant e.g.
 * that which is defined for the scope the task is sourced from.
 */
type TaskCriteriaResolver = (e: ActualTaskScope) => TaskCriteria[];

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
export function isTargetTask(task: vscode.Task, criteria: TaskCriteria[]): boolean {
    return criteria.some((c) => _.isMatch(task, c));
}

/**
 * Searches all currently executing tasks for one that matches the supplied
 * criteria.
 * @param resolver Callback to get criteria to find a matching task
 * @returns The matching criteria, if found.
 */
export function isTargetTaskRunning(resolver: TaskCriteriaResolver): boolean {
    return !!vscode.tasks.taskExecutions.find((executingTask: vscode.TaskExecution) => {
        const criteria = resolver(executingTask.task.scope);
        return isTargetTask(executingTask.task, criteria);
    });
}

/**
 * Obtains a configuration scope from an active editor, or prompts for scope if
 * it can't be determined from the workspace itself. It does this by leveraging
 * the editor for a resource scope, checking if we have > 1 workspace, if the
 * probeSetting is set anywhere other than the workspace and using a picker if
 * there are more than workspace, and we need to disambiguate
 * @param probeSetting the configuration name that we're going to probe in the
 *                     multiroot workspace scenario
 * @returns 
 */
async function getConfigurationScopeFromActiveEditor(probeSetting: string): Promise<Maybe<vscode.ConfigurationScope>>  {
    let context = vscode.window.activeTextEditor;
    if (context) {
        return Promise.resolve(context.document.uri);
    }

    if (!(vscode.workspace.workspaceFolders?.length) && !vscode.workspace.workspaceFile) {
        // The empty workspace, so we don't have any idea what config to get
        return Promise.resolve(undefined);
    }

    // If there is only one workspace, provide that one workspace. In the case
    // of a *folder* being open, but *not* part of a workspace, 'undefined'
    // would work. However, a workspace (`.code-workspace`) with a single folder
    // when passed 'undefined' for configuration resolution will resolve *only*
    // the settings from the `.code-workspace` file. So, we always supply a
    // a folder to capture that scenario.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length === 1) {
        return Promise.resolve(vscode.workspace.workspaceFolders[0]);
    }

    // 1. No Editor (so no active context)
    // 2. We have more than one folder (so we *may* have conflicting settings)
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
 * Get the configured TaskCriteria from the configuration, for the supplied
 * scope and any scopes (e.g. workspace) that might encompass a specific
 * WorkspaceFolder.
 *
 * We *always* want the monitored tasks from the global level. This is because
 * if there are tasks defined on a folder level (along with the URL to open),
 * the critier might be a shared configuration defined globally. Merging them
 * lets us 'catch them all' -- and duplicates are fine since we'll stop at the
 * first match.
 * 
 * @param scope The scope for which to resolve the configuration at
 */
function getCriteriaFromConfigurationForTaskScope(scope: ActualTaskScope): TaskCriteria[] {
    // Get the global/workspace configuration. 
    const criteria: TaskCriteria[] = vscode.workspace.getConfiguration(EXTENSION_ID).get(MONITORED_TASKS_SETTING_SECTION, []);

    // If it's been obtained from a specific workspace folder, lets use that.
    // Ultimately configuration will resolve
    if ((scope !== vscode.TaskScope.Global)
        && (scope !== vscode.TaskScope.Workspace)) {
        const folderConfiguration = vscode.workspace.getConfiguration(EXTENSION_ID, <vscode.WorkspaceFolder>scope);
        const folderCriteria: TaskCriteria[] = folderConfiguration.get(MONITORED_TASKS_SETTING_SECTION)!;
        criteria.push(...folderCriteria);
    }

    return criteria;
}

/**
 * Monitors the current session to task starts, and if they match the supplied
 * criteria, and raises the `onDidMatchingTaskExecute` event if one starts
 * after instantiation
 */
export class TaskMonitor {
    private subscriptions: { dispose(): any }[] = [];
    private matchingTaskExecutedEmitter = new vscode.EventEmitter<number>();
    private executionsMatched: number = 0;
    
    /**
     * Constructs a new instance and *starts monitoring* for task executions
     * that match the supplied criteria.
     * @param criteriaResolver Called to resolve the configuration for the
     *        executing task
     */
    constructor(private criteriaResolver: TaskCriteriaResolver = getCriteriaFromConfigurationForTaskScope) {
        vscode.tasks.onDidStartTask(this.handleTaskStarting, this, this.subscriptions);
        if (this.isTargetTaskRunning()) {
            // If it was already running, we must have executed it once
            this.executionsMatched = 1;
        }
    }

    /**
     * Cleans up any suscriptions this instance has created
     */
    dispose() {
        vscode.Disposable.from(...this.subscriptions).dispose();
        this.subscriptions = [];
    }

    private handleTaskStarting(e: vscode.TaskStartEvent): void {
        const criteria = this.criteriaResolver(e.execution.task.scope);
        if (!isTargetTask(e.execution.task, criteria)) {
            // Not our task, nothing to do
            return;
        }

        this.executionsMatched += 1;
        this.matchingTaskExecutedEmitter.fire(this.executionsMatched);
    }

    /**
     * Using the criteria resolver, looks to see if any matching tasks are
     * executing
     * @returns True if the task is currently executing
     */
    isTargetTaskRunning(): boolean {
        return isTargetTaskRunning(this.criteriaResolver);
    }

    get onDidMatchingTaskExecute(): vscode.Event<number> {
        return this.matchingTaskExecutedEmitter.event;
    }
}

/**
 * Extension instance that manages the lifecycle of an extension in vscode.
 */
export class InnerLoopBuddyExtension {
    /**
     * Opens the Simple Browser at the URL stored in configuration
     * @param scope Configuration scope to source the URL to open from
     * @returns True if successfully opened
     */
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
    const instance = new InnerLoopBuddyExtension();

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, async () => {
        return instance.openSimpleBrowser(await getConfigurationScopeFromActiveEditor(DEFAULT_URL_SETTING_SECTION));
    }));
}