import * as vscode from "vscode";
import * as ext from "./extension";
import type { Maybe } from "./extension";
import * as _ from "lodash";

export const MONITORED_TASKS_SETTING_SECTION = "monitoredTasks";
export const MONITORING_MODE_SETTING_SECTION = "taskMonitoringMode";

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
 * When tasks start, should we match criteria, or just any task
 */
 export const enum MonitoringMode {
    /**
     * Only tasks that match one of the configured criteria
     */
    Matching = "matching",

    /**
     * All tasks that are executed; irrespective of if they match
     */
    All = "all"
}

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
type TaskMonitoringConfigurationResolver = (e: ActualTaskScope) => { criteria: TaskCriteria[], mode: MonitoringMode };

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
export function isMatchingTaskRunning(resolver: TaskMonitoringConfigurationResolver): Maybe<vscode.Task> {
    const executingTask = vscode.tasks.taskExecutions.find((executingTask: vscode.TaskExecution) => {
        const criteria = resolver(executingTask.task.scope);
        return !!taskMatchesCriteria(executingTask.task, criteria.criteria);
    });

    return executingTask?.task;
}

/**
 * Check if a scope is a workspace folder or 'global'
 */
export function isWorkspaceTaskScope(taskScope: ActualTaskScope): boolean {
    return ((taskScope !== vscode.TaskScope.Global)
        && (taskScope !== vscode.TaskScope.Workspace));
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
 * @param scope The scope for which to resolve the configuration
 */
function getMonitoringConfigurationForTaskScope(scope: ActualTaskScope): { criteria: TaskCriteria[], mode: MonitoringMode } {
    // Get the global/workspace configuration. 
    const criteria: TaskCriteria[] = vscode.workspace.getConfiguration(ext.EXTENSION_ID).get(MONITORED_TASKS_SETTING_SECTION, []);
    const resolvingScope = (isWorkspaceTaskScope(scope) ? <vscode.WorkspaceFolder>scope : undefined);

    // If it's been obtained from a specific workspace folder, lets use that.
    // Ultimately configuration will resolve
    if (resolvingScope) {
        const folderConfiguration = vscode.workspace.getConfiguration(ext.EXTENSION_ID, resolvingScope);
        const folderCriteria: TaskCriteria[] = folderConfiguration.get(MONITORED_TASKS_SETTING_SECTION)!;
        criteria.push(...folderCriteria);
    }

    const mode: MonitoringMode = <MonitoringMode>(vscode.workspace.getConfiguration(ext.EXTENSION_ID, resolvingScope).get(MONITORING_MODE_SETTING_SECTION));

    return {
        criteria,
        mode
    };
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
     * @param configurationResolver Called to resolve the configuration for the
     *        executing task
     */
    constructor(private configurationResolver: TaskMonitoringConfigurationResolver = getMonitoringConfigurationForTaskScope) {
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
        const config = this.configurationResolver(e.execution.task.scope);

        // If there are no matching tasks, and we're expected to only monitor
        // for matching tasks, theres nothing else to do -- we don't want to
        // raise the event
        if (!taskMatchesCriteria(e.execution.task, config.criteria) && config.mode === MonitoringMode.Matching) {
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
        return isMatchingTaskRunning(this.configurationResolver);
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
 * Properties from a task that are noisy, not useful, or generally confusing.
 * We don't want to output them 'cause they distract from helping someone create
 * criteria that will match their own task
 */
const propertiesToExclude = [
    "target",
    "detail",
    "problemMatchers",
    "scope",
    "hasDefinedMatchers",
    "options",
    "id",
];

/**
 * Check if the property + value are 'insteresting'. We filter things in
 * `propertiesToExclude`, and things that are `Function`s.
 * @returns True if this is not an interesting field
 */
function isUninteresting(prop: string, instance: any): boolean {
    if (prop.startsWith("_")) {
        return true;
    }

    if (instance[prop] instanceof Function) {
        return true;
    }

    return propertiesToExclude.includes(prop);
}

/**
 * Given an instance of _something_, convert it into something friendlier to
 * humans (E.g. just data). This isn't intended to be universal, and instead
 * scoped to the convesion of vscode.Task to something a human can put in their
 * configuration and use to match a task.
 *
 * This will recursively traverse the objects properties until it runs out of
 * things to simplify
 * @param instance Instance to simplify
 * @returns Object instance with simplified property values.
 */
function simplify(instance: any): any {
    const result: any = {};
    const og = instance;

    // We can't simplify strings, since they should just be strings. If we find
    // one, just return it
    if (typeof(instance) === "string") {
        return instance;
    }

    // Enumerate visible properties down the prototype chain.
    do {
        // Get the property names from the prototype
        for (const p of Object.getOwnPropertyNames(instance)) {
            if (isUninteresting(p, og)) {
                // We don't care about unintersting values
                continue;
            }

            // Get the value from the *original* object, not the 'prototype'
            // instance, which is unlikely to be where the values are stored. If
            // it is in the prototype, this will sill resolve it.
            let value = og[p];
            if (Array.isArray(value)) {
                // Arrays are special, handle them with care
                const items = (<[]>value).map(simplify);
                value = (items.length ? items : undefined);
            } else if (typeof value === "object") {
                // Objects should be simplified recursively
                value = simplify(value);
            }

            if (value === undefined) {
                continue;
            }
            
            result[p] = value;
        }
    } while (instance = Object.getPrototypeOf(instance));

    // If we've produced an empty object, then we should return undefined
    // rather than an empty object.
    if (Object.keys(result).length === 0) {
        return undefined;
    }

    return result;
}

/**
 * Convert from a vscode.Task to a TaskCriteria e.g. simplify it from an
 * instance of a class to a property bag of stuff
 * @param task Task to convert
 * @returns Simple data object of serializable fields
 */
export function fromTaskToCriteria(task: vscode.Task): TaskCriteria {
    const criteria = simplify(task);
    return criteria;
}