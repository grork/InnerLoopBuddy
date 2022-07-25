import * as vscode from "vscode";
import { EXTENSION_ID } from "./extension";

export interface ShowOptions {
    readonly preserveFocus?: boolean;
    readonly viewColumn?: vscode.ViewColumn;
}

enum FromWebViewMessageType {
    OpenInSystemBrowser = "open-in-system-browser"
}

enum ToWebViewMessageType {
    FocusIndicatorLockEnabledStateChanged = "didChangeFocusLockIndicatorEnabled"
}

const BROWSER_TITLE: string = "Inner Loop Buddy Browser";
const FOCUS_LOCK_SETTING_SECTION = "focusLockIndicator.enabled";

export const BROWSER_VIEW_TYPE = `${EXTENSION_ID}.browser.view`;

export class BrowserView {
    private disposables: vscode.Disposable[] = [];
    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDispose = this._onDidDispose.event;

    public static create(
        extensionUri: vscode.Uri,
        targetUrl: string,
        showOptions?: ShowOptions,
        targetWebView?: vscode.WebviewPanel
    ): BrowserView {
        if (!targetWebView) {
            targetWebView = vscode.window.createWebviewPanel(
                BROWSER_VIEW_TYPE,
                BROWSER_TITLE, {
                viewColumn: showOptions?.viewColumn ?? vscode.ViewColumn.Active,
                preserveFocus: showOptions?.preserveFocus
            }, {
                enableScripts: true,
                enableForms: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, "out/browser")
                ]
            }
            );
        }

        return new BrowserView(extensionUri, targetUrl, targetWebView);
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        url: string,
        private webViewPanel: vscode.WebviewPanel,
    ) {
        this.disposables.push(this._onDidDispose);
        this.disposables.push(webViewPanel);

        vscode.workspace.onDidChangeConfiguration(this.handleConfigurationChanged, this, this.disposables);
        this.webViewPanel.webview.onDidReceiveMessage(this.handleWebViewMessage, this, this.disposables);
        this.webViewPanel.onDidDispose(this.dispose, this, this.disposables);

        this.show(url);
    }

    private handleWebViewMessage(payload: { type: FromWebViewMessageType, url: string }) {
        switch (payload.type) {
            case FromWebViewMessageType.OpenInSystemBrowser:
                try {
                    const url = vscode.Uri.parse(payload.url);
                    vscode.env.openExternal(url);
                } catch {
                    // Noop
                }
                break;
            
            default:
                debugger;
                break;
        }
    }

    private handleConfigurationChanged(e: vscode.ConfigurationChangeEvent) {
        if (!e.affectsConfiguration(`${EXTENSION_ID}.${FOCUS_LOCK_SETTING_SECTION}`)) {
            // Not of interest to us
            return;
        }

        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);
        this.webViewPanel.webview.postMessage({
            type: ToWebViewMessageType,
            focusLockEnabled: configuration.get<boolean>(FOCUS_LOCK_SETTING_SECTION, true)
        });
    }

    private getHtml(url: string) {
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);

        const nonce = getNonce();

        const mainJs = this.extensionResourceUrl("out/browser", "browserUi.js");
        const mainCss = this.extensionResourceUrl("out/browser", "styles.css");

        return /* html */ `<!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-type" content="text/html;charset=UTF-8">

                <meta http-equiv="Content-Security-Policy" content="
                    default-src 'none';
                    font-src ${this.webViewPanel.webview.cspSource};
                    style-src ${this.webViewPanel.webview.cspSource};
                    script-src 'nonce-${nonce}';
                    frame-src *;
                    ">

                <meta id="browser-settings" data-settings="${escapeAttribute(JSON.stringify({
            url: url,
            focusLockEnabled: configuration.get<boolean>(FOCUS_LOCK_SETTING_SECTION, true)
        }))}">

                <link rel="stylesheet" type="text/css" href="${mainCss}">
            </head>
            <body>
                <header class="header">
                    <nav class="controls">
                        <button
                            title="Back"
                            class="back-button icon">back</button>

                        <button
                            title="Forward"
                            class="forward-button icon">forward</i></button>

                        <button
                            title="Reload"
                            class="reload-button icon">reload</i></button>
                    </nav>

                    <input class="url-input" type="text">

                    <nav class="controls">
                        <button
                            title="Open in system browser"
                            class="open-external-button icon"><i class="codicon codicon-link-external"></i></button>
                    </nav>
                </header>
                <div class="content">
                    <div class="iframe-focused-alert">Focus Lock</div>
                    <iframe sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
                </div>

                <script src="${mainJs}" nonce="${nonce}"></script>
            </body>
            </html>`;
    }

    private extensionResourceUrl(...parts: string[]): vscode.Uri {
        return this.webViewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
    }

    public dispose() {
        this._onDidDispose.fire();
        
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables = [];
    }

    public show(url: string, options?: ShowOptions) {
        this.webViewPanel.webview.html = this.getHtml(url);
        this.webViewPanel.reveal(options?.viewColumn, options?.preserveFocus);
    }
}

function escapeAttribute(value: string | vscode.Uri): string {
    return value.toString().replace(/"/g, "&quot;");
}

function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 64; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
