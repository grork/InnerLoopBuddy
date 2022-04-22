import * as vscode from "vscode";
import * as monitor from "./taskmonitor";

export const EXTENSION_ID = "codevoid.inner-loop-buddy";

export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MATCHED_TASK_BEHAVIOUR_SETTING_SECTION = "matchedTaskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;
export const PRINT_TASK_CRITERIA_COMMAND_ID = `${EXTENSION_ID}.printTaskCriteriaJson`;

const AUTO_OPEN_DELAY_SETTING_SECTION = "autoOpenDelay";
const EDITOR_COLUMN_SETTING_SECTION = "editorColumn";

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
export const enum MatchedTaskBehaviour {
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
 * Type container for an instance or undefined (e.g. an optional)
 */
export type Maybe<T> = T | undefined;

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function scopeToName(scope: monitor.ActualTaskScope): string {
    if (monitor.isWorkspaceTaskScope(scope)) {
        return (<vscode.WorkspaceFolder>scope).name;
    }

    return (scope === vscode.TaskScope.Workspace) ? "Workspace" : "Global";
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
function getConfigurationScopeFromActiveEditor(probeSetting: string): Thenable<Maybe<vscode.ConfigurationScope>> {
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
 * Convience function to convert from task scope into a ConfigurationScope (Which
 * is basically undefined or a workspace folder). However, there is a little
 * magic included.
 * 
 * Tasks & Configuration can be set on multiple levels: User (global),
 * Workspace, Folder. At each of these levels, you can also configure settings
 * for this extension -- but those might be divorced from the tasks themselves.
 * 
 * When the task itself executes, it's scope reflects it's source. When the task
 * is in a folder, this works out nicely because configuration in VS Code will
 * look to it's parent 'container'. However, this doesn't apply in reverse. A
 * task thats defined at the user level, in a multiroot workspace, you don't know
 * where to resolve configuration from -- folder? Which one? In the rare
 * workspace-but-single-folder scenario, you can just pick the single
 * Workspace folder.
 * 
 * But otherwise we're kinda SOL. We can guess by using the active editor, which
 * if it's not got configuration will still roll up to the parent level of
 * configuration.
 */
export function configurationScopeFromTaskScope(taskScope: monitor.ActualTaskScope): Maybe<vscode.ConfigurationScope> {
    if (monitor.isWorkspaceTaskScope(taskScope)) {
        return <vscode.WorkspaceFolder>taskScope;
    }

    if (vscode.workspace.workspaceFolders?.length === 1) {
        return vscode.workspace.workspaceFolders![0];
    }

    return vscode.window.activeTextEditor?.document.uri;
}

/**
 * Sorting function that places tasks in a humand friendly order:
 * - Items from a workspace, sorted alphabetically
 * - Items by source, sorted alphabetically
 */
function sortTasksByScopeThenSourceThenName(a: vscode.Task, b: vscode.Task): number {
    if (a.source == b.source
        && a.name === b.name
        && a.scope === b.scope) {
        return 0;
    }

    if (a.scope !== b.scope) {
        // Sort by workspace folder name if they're both folders
        if (monitor.isWorkspaceTaskScope(a.scope) && monitor.isWorkspaceTaskScope(b.scope)) {
            const nameA = (<vscode.WorkspaceFolder>a.scope).name;
            const nameB = (<vscode.WorkspaceFolder>b.scope).name

            return (nameA.localeCompare(nameB));
        }

        // Both are Actual scopes
        if (!monitor.isWorkspaceTaskScope(a.scope) && !monitor.isWorkspaceTaskScope(b.scope)) {
            const scopeA = <vscode.TaskScope>a.scope;
            const scopeB = <vscode.TaskScope>b.scope;

            return (scopeA - scopeB) * -1;
        }

        // A is a folder, but B is not, put A first
        if (monitor.isWorkspaceTaskScope(a.scope)) {
            return -1;
        }

        if (monitor.isWorkspaceTaskScope(b.scope)) {
            return 1;
        }
    }

    // Force the workspace items first
    if (a.source === "Workspace" && b.source !== "Workspace") {
        return -1;
    }

    if (a.source < b.source) {
        return -1;
    }

    if (a.source > b.source) {
        return 1;
    }

    return (a.name.localeCompare(b.name));
}

async function getGroupedQuickPickItemsForTasks(): Promise<[(vscode.QuickPickItem & { task?: vscode.Task })[], vscode.Task[]]> {
    let tasks = (await vscode.tasks.fetchTasks()).sort(sortTasksByScopeThenSourceThenName);
    const createdGroups = new Set<string>();

    const pickerItems = tasks.reduce((p: (vscode.QuickPickItem & { task?: vscode.Task })[], t: vscode.Task) => {
        const group = scopeToName(t.scope);
        if (!createdGroups.has(group)) {
            // Add seperator
            p.push({
                kind: vscode.QuickPickItemKind.Separator,
                label: group
            });
            createdGroups.add(group);
        }

        p.push({
            label: t.name,
            detail: t.detail,
            description: t.source,
            task: t
        })

        return p;
    }, []);

    return [pickerItems, tasks];
}

/**
 * Extension instance that manages the lifecycle of an extension in vscode.
 */
export class InnerLoopBuddyExtension {
    private _isInitialized: boolean = false;
    private taskMonitor?: monitor.TaskMonitor;
    private criteriaOutput?: vscode.OutputChannel;

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

        const taskMonitor = new monitor.TaskMonitor();
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

    private handleMatchedTaskExecution(e: monitor.MatchedExecutionOccured): void {
        const configurationScope = configurationScopeFromTaskScope(e.scope);
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID, configurationScope);
        const behaviour: MatchedTaskBehaviour = configuration.get(MATCHED_TASK_BEHAVIOUR_SETTING_SECTION)!;
        const autoOpenDelay = <number>configuration.get(AUTO_OPEN_DELAY_SETTING_SECTION);

        switch (behaviour) {
            case MatchedTaskBehaviour.Everytime:
                this.openSimpleBrowser(configurationScope, autoOpenDelay);
                break;

            case MatchedTaskBehaviour.OneTime:
                if (e.occurances < 2) {
                    this.openSimpleBrowser(configurationScope, autoOpenDelay);
                }
                break;

            default:
            case MatchedTaskBehaviour.None:
                break;
        }
    }

    /**
     * Opens the Simple Browser at the URL stored in configuration
     * @param scope Configuration scope to source the URL to open from
     * @returns True if successfully opened
     */
    async openSimpleBrowser(scope: Maybe<vscode.ConfigurationScope>, autoOpenDelay: number = 0): Promise<boolean> {
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

            return false;
        }

        // We definitely have a URL to open, so lets check which column we're
        // going to open to
        const rawViewColumnValue = <string>config.get(EDITOR_COLUMN_SETTING_SECTION, "Beside");
        const apiViewColumn = <vscode.ViewColumn>vscode.ViewColumn[rawViewColumnValue as keyof typeof vscode.ViewColumn];

        if (autoOpenDelay) {
            await delay(autoOpenDelay);
        }

        await vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(defaultBrowserUrl), { viewColumn: apiViewColumn });
        
        return true;
    }

    /**
     * Prompt the user for a task to output criteria for, and then print to a
     * dedicated output channel if one is selected. Adds an 'All' item to
     * output all criteria
     * @returns Promise that completes when the task is, uh, complete
     */
    async printTaskCriteriaToChannel(): Promise<void> {
        let [pickerItems, tasks] = await getGroupedQuickPickItemsForTasks();

        // Place an item for 'all' at the end. This doesn't contain a task,
        // which will be used to distinguished from real task items
        pickerItems.push({
            label: "",
            kind: vscode.QuickPickItemKind.Separator
        });

        pickerItems.push({
            label: "All",
            description: "Print criteria for all tasks",
        });

        // Show it, and wait for the user to pick something for us to operate on
        const pickedItem = await vscode.window.showQuickPick(pickerItems);
        if (!pickedItem) {
            // They didn't pick anything, so we don't need to do anything
            return;
        }

        // If we had a task, use that; otherwise use all the tasks
        if (pickedItem.task) {
            tasks = [pickedItem.task];
        }

        const criteria = tasks.map(monitor.fromTaskToCriteria);
        if (!this.criteriaOutput) {
            this.criteriaOutput = vscode.window.createOutputChannel("Inner Loop Buddy: Criteria Log");
        }
        
        this.criteriaOutput.clear();
        this.criteriaOutput.append(JSON.stringify(criteria, null, 4));
        this.criteriaOutput.show();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const instance = new InnerLoopBuddyExtension(context);

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, async () => instance.openSimpleBrowser(await getConfigurationScopeFromActiveEditor(DEFAULT_URL_SETTING_SECTION))));
    context.subscriptions.push(vscode.commands.registerCommand(PRINT_TASK_CRITERIA_COMMAND_ID, instance.printTaskCriteriaToChannel, instance));

    return instance;
}