import * as vscode from "vscode";
import * as _ from "lodash";

/**
 * The information to match a specific task when trying to open a browser. The
 * information is "deep equality" checked against the `vscode.Task` instance. If
 * and only if all the propertie are present, *and* those properties match.
 */
type TaskCriteria = { [name: string]: any };

type Maybe<T> = T | null;

export async function findTask(criteria: TaskCriteria): Promise<Maybe<vscode.Task>> {
    const foundTasks = await vscode.tasks.fetchTasks();
    let foundTask: Maybe<vscode.Task> = null;

    for (const task of foundTasks) {
        if (!_.isMatch(task, criteria)) {
            continue;
        }

        foundTask = task;
    }

    return foundTask;
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