import * as vscode from "vscode";
import * as _ from "lodash";
import * as monitor from "./taskmonitor";
import { BrowserManager } from "./browserManager";
import * as net from "net";

export const EXTENSION_ID = "codevoid.inner-loop-buddy";
export const DEFAULT_URL_SETTING_SECTION = "defaultUrl"
export const MATCHED_TASK_BEHAVIOUR_SETTING_SECTION = "matchedTaskBehavior";
export const OPEN_BROWSER_COMMAND_ID = `${EXTENSION_ID}.openDefaultUrl`;
export const PRINT_TASK_CRITERIA_COMMAND_ID = `${EXTENSION_ID}.printTaskCriteriaJson`;
export const START_CONFIGURE_TASK_CRITERIA_WIZARD_COMMAND_ID = `${EXTENSION_ID}.startCriteriaWizard`;

const AUTO_OPEN_DELAY_SETTING_SECTION = "autoOpenDelay";
const EDITOR_COLUMN_SETTING_SECTION = "editorColumn";
const PERFORM_AVAILABILITY_CHECK_SETTING_SECTION = "performAvailabilityCheckBeforeOpeningBrowser";
const PERFORM_AVAILABILITY_CHECK_TIMEOUT_SETTING_SECTION = "performAvailabilityCheckBeforeOpeningBrowserTimeout";
const SHOW_SETTINGS_BUTTON = "Configure in settings";
const AVAILABILITY_CHECK_INCREMENT_MS = 100;

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
 * Displays a warning message with the supplied message + button to take the
 * user to setting to configure th URL
 * @param message Message to display
 */
function displayPromptForConfiguringUrl(message: string) {
    vscode.window.showWarningMessage(message, SHOW_SETTINGS_BUTTON).then((result) => {
        if (result === SHOW_SETTINGS_BUTTON) {
            // Show the settings page prefiltered to our settings
            vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", { "query": `${EXTENSION_ID}.${DEFAULT_URL_SETTING_SECTION}` });
            return;
        }

        // Dismissed, so do nothing
        return;
    });
}

/**
 * Wraps setting up a socket to check if a port is listening, returns a promise
 * which completes with success or failure (but does not fail the promise)
 * @param host Host name to connect to
 * @param port Port to connect to
 * @param family IP family to use (4, 6)
 * 
 * @returns Promise that completes when the socket has accepted or rejected the
 *          connection
 */
function checkSocket(host: string, port: number, family: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const client = new net.Socket();
            
        // If there is any error, we'll consider the host unavailable
        client.on("error", () => {
            resolve(false);
        });

        // Attempt the connection; we assume it's available if we connect
        client.connect({ host, port, family }, () => {
            client.end();
            resolve(true);
        });
    });
}

/**
 * Given a host & port, will spin-wait(ish) until the host allows a socket to be
 * opened. If the timeout is reached, then the host is considered unavailable
 * @param host Host to connect to
 * @param port Post to connect to on the host
 * @param timeout total time in milliseconds to wait for availability
 * @returns True if available, false if not
 */
async function waitForHostToBeAvailable(host: string, port: number, timeout: number): Promise<boolean> {
    // Socket timeouts might be meaningful, and we'd like to only wait as long
    // as we need to. So calculate the deadline, and use that
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        // Various node versions, and the wild west of user configuration means
        // that we can't assume that the target is located on IPv4 only, or IPv6
        // We could ask them to declare it, but that seems wonky. So, we're
        // going to check IPv4, and if thats not successful, try IPv6. We'll do
        // this in the loop to give the target time to start up enough to accept
        // connections
        const available4 = await checkSocket(host, port, 4);

        if (available4) {
            return true;
        }

        // If it failed, it might be listening on the IPv6, so check that before
        // retrying
        const available6 = await checkSocket(host, port, 6);
        if (available6) {
            return true;
        }
        
        // Wait a small amount of time before trying again.
        await delay(AVAILABILITY_CHECK_INCREMENT_MS);
    }

    return false;
}

/**
 * Extension instance that manages the lifecycle of an extension in vscode.
 */
export class InnerLoopBuddyExtension {
    private _isInitialized: boolean = false;
    private taskMonitor?: monitor.TaskMonitor;
    private criteriaOutput?: vscode.OutputChannel;
    private browserManager: BrowserManager;

    constructor(private context: vscode.ExtensionContext) {
        this.browserManager = new BrowserManager(context.extensionUri);
        this.browserManager.handleExtensionActivation(context);
        context.subscriptions.push(this.browserManager);

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
    async openSimpleBrowser(scope: Maybe<vscode.ConfigurationScope>, autoOpenDelay: number = 0, manuallyInvoked: boolean = false): Promise<boolean> {
        const config = vscode.workspace.getConfiguration(EXTENSION_ID, scope);
        const defaultBrowserUrl = <string>config.get("defaultUrl");
        if (!defaultBrowserUrl) {
            displayPromptForConfiguringUrl("No default URL configured");

            return false;
        }

        // We definitely have a URL to open, so lets check which column we're
        // going to open to
        const rawViewColumnValue = <string>config.get(EDITOR_COLUMN_SETTING_SECTION, "Beside");
        const apiViewColumn = <vscode.ViewColumn>vscode.ViewColumn[rawViewColumnValue as keyof typeof vscode.ViewColumn];

        if (autoOpenDelay) {
            await delay(autoOpenDelay);
        }
        
        let url: vscode.Uri | null = null;
        try
        {
            url = vscode.Uri.parse(defaultBrowserUrl, true);
        }
        catch {/* nop */ }
        
        if (!url || (url.scheme !== "http" && url.scheme != "https")) {
            // We can't handle non-http URLs
            displayPromptForConfiguringUrl("Default URL must be a valid HTTP or HTTPS URL");
            return false;
        }

        // If configured to perform an availability check first, do so. But only
        // if we were not manually invoked (E.g. user explicitly invokved the
        // command)
        if (config.get<boolean>(PERFORM_AVAILABILITY_CHECK_SETTING_SECTION, true) && !manuallyInvoked) {
            let host = url.authority;
            let port = (url.scheme === "http") ? 80 : 443; // Assume a default port
            
            // The authority includes the port, so we might need to extract that
            if (host.indexOf(":") > -1) {
                const parts = host.split(":");
                host = parts[0];
                port = parseInt(parts[1]);
            }
            
            const serverAvailable = await waitForHostToBeAvailable(host, port, config.get<number>(PERFORM_AVAILABILITY_CHECK_TIMEOUT_SETTING_SECTION, 1000));
            if (!serverAvailable) {
                // Let the user know incase they made an error in the URL
                displayPromptForConfiguringUrl("Target URL is unavailable, please check the URL");
                return false;
            }
        }

        this.browserManager.show(url.toString(true), { viewColumn: apiViewColumn })
        return true;
    }

    /**
     * Prompt the user for a task to output criteria for, and then print to a
     * dedicated output channel if one is selected. Adds an 'All' item to
     * output all criteria
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
        const pickedItem = await vscode.window.showQuickPick(pickerItems, {
            title: "Which task would you like to print match criteria for?"
        });

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

    /**
     * Start a flow that walks the user through selecting a task they which to
     * monitor. Once they've selected it, based on their project will either add
     * it to the folder, or if they're in a code-workspace, prompt for the
     * location to add the configuration to.
     */
    async startTaskCriteriaWizard(): Promise<void> {
        const [taskPickerItems, ] = await getGroupedQuickPickItemsForTasks();

        const pickedTask = await vscode.window.showQuickPick(taskPickerItems, {
            title: "Which task would you like configuration to be added for?"
        });

        // Nothing was picked, nothing to process
        if (!pickedTask) {
            return;
        }

        let configurationScope = configurationScopeFromTaskScope(pickedTask.task!.scope);
        if (vscode.workspace.workspaceFile) {
            // If we have a workspace *file*, it means we have at least two
            // possible targets for our configuration. We need to ask the user
            // to make that choice for us.

            // Get the folders
            const configurationTargetPicks: (vscode.QuickPickItem & { folder?: vscode.WorkspaceFolder})[] = vscode.workspace.workspaceFolders!.map((wf) => {
                return {
                    label: wf.name,
                    folder: wf
                }
            });
            
            // Add a fixed workspace folder item
            configurationTargetPicks.push({
                label: "Workspace File"
            });

            const pickedTarget = await vscode.window.showQuickPick(configurationTargetPicks, {
                title: "Which folder should the configuration be added to?"
            });

            // No target picked, give up
            if (!pickedTarget) {
                return;
            }

            configurationScope = pickedTarget.folder;
        }

        // We need to determine where, what, and if, we should att configuration
        const configurationTarget = (configurationScope ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
        const criteriaToAdd = monitor.fromTaskToCriteria(pickedTask.task!);
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID, configurationScope);
        const existingCritera = <monitor.TaskCriteria[]>configuration.get(monitor.MONITORED_TASKS_SETTING_SECTION);

        // Don't add it & cause a duplicate if the item already exists
        const criteriaAlreadyExists = existingCritera.some((t) => _.isMatch(criteriaToAdd, t));
        if (!criteriaAlreadyExists) {
            existingCritera.push(criteriaToAdd);
            configuration.update(monitor.MONITORED_TASKS_SETTING_SECTION, existingCritera, configurationTarget);
        }

        await vscode.window.showInformationMessage("Configuration added!", {
            detail: "The configuration has been added to your workspace folder settings"
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    const instance = new InnerLoopBuddyExtension(context);

    context.subscriptions.push(vscode.commands.registerCommand(OPEN_BROWSER_COMMAND_ID, async () => instance.openSimpleBrowser(await getConfigurationScopeFromActiveEditor(DEFAULT_URL_SETTING_SECTION), undefined, true)));
    context.subscriptions.push(vscode.commands.registerCommand(PRINT_TASK_CRITERIA_COMMAND_ID, instance.printTaskCriteriaToChannel, instance));
    context.subscriptions.push(vscode.commands.registerCommand(START_CONFIGURE_TASK_CRITERIA_WIZARD_COMMAND_ID, instance.startTaskCriteriaWizard, instance));

    return instance;
}