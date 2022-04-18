import * as vscode from "vscode";
import * as _ from "lodash";

export const EXTENSION_ID = "codevoid.inner-loop-buddy";
export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MONITORED_TASKS_SETTING_SECTION = "monitoredTasks";
export const TASK_BEHAVIOUR_SETTING_SECTION = "taskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;

const SHOW_SETTINGS_BUTTON = "Configure in settings";

/**
 * Tests don't want the extension doing it's "thing", but we can't explicitly
 * stop the tests from activating the extension. This flag disables init of the
 * task monitoring etc.
 */
let SKIP_EXTENSION_INIT = false;

/**
 * Called by tests to disable the task monitoring and other "automatic"
 * behaviour of the extension.
 */
export function disableAutomaticExtensionInit(): void {
    SKIP_EXTENSION_INIT = true;
}

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
 * When a matched execution is seen, the event raises this payload for the scope
 * and matches that have been seen so far.
 */
export interface MatchedExecutionOccured {
    /**
     * The number of occurances that a match has been seen executed *in this
     * scope*.
     */
    occurances: number;

    /**
     * The scope for which the occurance count is valid
     */
    scope: ActualTaskScope;
}

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
export function taskMatchesCriteria(task: vscode.Task, criteria: TaskCriteria[]): boolean {
    return criteria.some((c) => _.isMatch(task, c));
}

/**
 * Searches all currently executing tasks for one that matches the supplied
 * criteria.
 * @param resolver Callback to get criteria to find a matching task
 * @returns The matching criteria, if found.
 */
export function isMatchingTaskRunning(resolver: TaskCriteriaResolver): Maybe<vscode.Task> {
    const executingTask = vscode.tasks.taskExecutions.find((executingTask: vscode.TaskExecution) => {
        const criteria = resolver(executingTask.task.scope);
        return !!taskMatchesCriteria(executingTask.task, criteria);
    });

    return executingTask?.task;
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
    if (isWorkspaceTaskScope(scope)) {
        const folderConfiguration = vscode.workspace.getConfiguration(EXTENSION_ID, <vscode.WorkspaceFolder>scope);
        const folderCriteria: TaskCriteria[] = folderConfiguration.get(MONITORED_TASKS_SETTING_SECTION)!;
        criteria.push(...folderCriteria);
    }

    return criteria;
}

/**
 * Check if a scope is a workspace folder or 'global'
 */
function isWorkspaceTaskScope(taskScope: ActualTaskScope): boolean {
    return ((taskScope !== vscode.TaskScope.Global)
        && (taskScope !== vscode.TaskScope.Workspace));
}

/**
 * Given a Task Scope, turns it into a string-key to be used in a map etc.
 * This is needed because *folders* have a URI, which is a great key, the other
 * two scopes -- Global, Workspace -- are number, which isn't so nice, and also
 * splits the space in many cases (E.g. single workspace).
 * @param scope Scope to convert
 * @returns String representation of that Scope
 */
function keyFromScope(scope: ActualTaskScope): string {
    if (!isWorkspaceTaskScope(scope)) {
        return "global";
    }

    return (<vscode.WorkspaceFolder>scope!).uri.toString();
}

/**
 * Convience function to convert from task scope into a ConfigurationScope (Which
 * is basically undefined or a workspace folder)
 */
function configurationScopeFromTaskScope(taskScope: ActualTaskScope): Maybe<vscode.ConfigurationScope> {
    if (isWorkspaceTaskScope(taskScope)) {
        return <vscode.WorkspaceFolder>taskScope;
    }

    return undefined;
}

/**
 * Monitors the current session to task starts, and if they match the supplied
 * criteria, and raises the `onDidMatchingTaskExecute` event if one starts
 * after instantiation
 */
export class TaskMonitor {
    private subscriptions: { dispose(): any }[] = [];
    private matchingTaskExecutedEmitter = new vscode.EventEmitter<MatchedExecutionOccured>();
    private scopedOccurances = new Map<string, number>();
    
    /**
     * Constructs a new instance and *starts monitoring* for task executions
     * that match the supplied criteria.
     * @param criteriaResolver Called to resolve the configuration for the
     *        executing task
     */
    constructor(private criteriaResolver: TaskCriteriaResolver = getCriteriaFromConfigurationForTaskScope) {
        vscode.tasks.onDidStartTask(this.handleTaskStarting, this, this.subscriptions);
        const runningTask = this.isMatchingTaskRunning();
        if (runningTask) {
            // If it was already running, we must have executed it once
            this.scopedOccurances.set(keyFromScope(runningTask.scope), 1);
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
        if (!taskMatchesCriteria(e.execution.task, criteria)) {
            // Not our task, nothing to do
            return;
        }

        const key = keyFromScope(e.execution.task.scope);
        let executedCount = this.scopedOccurances.get(key) || 0;

        executedCount += 1;
        const payload = {
            occurances: executedCount,
            scope: e.execution.task.scope
        };

        this.scopedOccurances.set(key, executedCount);
        this.matchingTaskExecutedEmitter.fire(payload);
    }

    /**
     * Using the criteria resolver, looks to see if any matching tasks are
     * executing
     * @returns True if the task is currently executing
     */
    isMatchingTaskRunning(): Maybe<vscode.Task> {
        return isMatchingTaskRunning(this.criteriaResolver);
    }

    /**
     * When a task that matches the configured criteria executes this event will
     * be raised. It will only be raised for tasks that start *after* the
     * instance has been constructed. If you want to ask "is it running right
     * now", you should use `isMatchingTaskRunning`
     */
    get onDidMatchingTaskExecute(): vscode.Event<MatchedExecutionOccured> {
        return this.matchingTaskExecutedEmitter.event;
    }
}

/**
 * Extension instance that manages the lifecycle of an extension in vscode.
 */
export class InnerLoopBuddyExtension {
    private _isInitialized: boolean = false;
    private taskMonitor?: TaskMonitor;

    constructor(private context: vscode.ExtensionContext) {
        // Check if we're in a test
        if (SKIP_EXTENSION_INIT) {
            return;
        }

        this.initialize();
    }

    /**
     * Have we performed initialization; intended to be checked by testing
     */
    get isInitialized(): boolean {
        return this._isInitialized;
    }

    /**
     * Perform initalization, such as listening for events & checking for tasks
     * already running
     */
    initialize(): void {
        this._isInitialized = true;
        
        const taskMonitor = new TaskMonitor();
        this.taskMonitor = taskMonitor;
        taskMonitor.onDidMatchingTaskExecute(this.handleMatchedTaskExecution, this, this.context.subscriptions);

        const runningTask = taskMonitor.isMatchingTaskRunning();
        if (runningTask) {
            // This is the initialization path, we're going to make an
            // assumption because of that. Task is running, so we _should_ run
            // through the configuration for handling. Rather than factor a
            // method, out, we're going to 'fake' the event param and use the
            // event handler
            this.handleMatchedTaskExecution({ occurances: 1, scope: runningTask.scope });
        }
    }

    private handleMatchedTaskExecution(e: MatchedExecutionOccured): void {
        const configurationScope = configurationScopeFromTaskScope(e.scope);
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID, configurationScope);
        const behaviour: MonitoringType = configuration.get(TASK_BEHAVIOUR_SETTING_SECTION)!;
        
        switch (behaviour) {
            case MonitoringType.Everytime:
                this.openSimpleBrowser(configurationScope);
                break;
            
            case MonitoringType.OneTime:
                if (e.occurances < 2) {
                    this.openSimpleBrowser(configurationScope);
                }
                break;

            default:
            case MonitoringType.None:
                break;
        }
    }

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

        return vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(defaultBrowserUrl), { viewColumn: vscode.ViewColumn.Beside }).then(() => true);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log("Extension activated. State:" + SKIP_EXTENSION_INIT);
    const instance = new InnerLoopBuddyExtension(context);

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, async () => {
        return instance.openSimpleBrowser(await getConfigurationScopeFromActiveEditor(DEFAULT_URL_SETTING_SECTION));
    }));

    return instance;
}