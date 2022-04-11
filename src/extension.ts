import * as vscode from "vscode";
import * as _ from "lodash";

/**
 * The information to match a specific task when trying to open a browser. The
 * information is "deep equality" checked against the `vscode.Task` instance. If
 * and only if all the propertie are present, *and* those properties match.
 */
type TaskCriteria = { [name: string]: any };

type Maybe<T> = T | undefined;

export async function findTargetTask(criteria: TaskCriteria): Promise<Maybe<vscode.Task>> {
    const foundTasks = await vscode.tasks.fetchTasks();
    return foundTasks.find((task) => _.isMatch(task, criteria));
}

export function isTargetTaskRunning(criteria: TaskCriteria): Maybe<boolean> {
    return !!vscode.tasks.taskExecutions.find((executingTask:vscode.TaskExecution) => _.isMatch(executingTask.task, criteria));
}

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand("simplebrowser-helper-extension.openDefaultUrl", () => {
        const config = vscode.workspace.getConfiguration("codevoid.simplebrowser-helper-extension");
        const defaultBrowserUrl = <string>config.get("defaultUrl");
        if (!defaultBrowserUrl) {
            return;
        }

        vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(defaultBrowserUrl));
    });

    context.subscriptions.push(disposable);
}