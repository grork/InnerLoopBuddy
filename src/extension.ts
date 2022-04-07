import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('simplebrowser-helper-extension.openDefaultUrl', () => {
        const config = vscode.workspace.getConfiguration("codevoid.simplebrowser-helper-extension");
        const defaultBrowserUrl = <string>config.get("defaultUrl");
        if (!defaultBrowserUrl) {
            return;
        }

        vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(defaultBrowserUrl));
    });

    context.subscriptions.push(disposable);
}