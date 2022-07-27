import * as vscode from "vscode";
import { EXTENSION_ID } from "./extension";
import * as nodeCrypto from "crypto";

export interface ShowOptions {
    readonly viewColumn?: vscode.ViewColumn;
}

enum FromWebViewMessageType {
    OpenInSystemBrowser = "open-in-system-browser",
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed"
}

enum ToWebViewMessageType {
    FocusIndicatorLockEnabledStateChanged = "focus-lock-indicator-setting-changed",
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed",
    NavigateToUrl = "navigate-to-url"
}

const BROWSER_TITLE: string = "Inner Loop Buddy Browser";
const FOCUS_LOCK_SETTING_SECTION = "focusLockIndicator";
const AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION = "automaticBrowserCacheBypass";
export const BROWSER_VIEW_TYPE = `${EXTENSION_ID}.browser.view`;

function escapeAttribute(value: string | vscode.Uri): string {
    return value.toString().replace(/"/g, "&quot;");
}

function getNonce(): string {
    const actualCrypto = global.crypto ?? <Crypto>nodeCrypto.webcrypto;

    const values = new Uint8Array(64);
    actualCrypto.getRandomValues(values);

    return values.reduce<string>((p, v) => p += v.toString(16), "");
}

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
                preserveFocus: true
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

    private handleWebViewMessage(payload: { type: FromWebViewMessageType, url?: string, automaticBrowserCacheBypass?: boolean }) {
        switch (payload.type) {
            case FromWebViewMessageType.OpenInSystemBrowser:
                try {
                    const url = vscode.Uri.parse(payload.url!);
                    vscode.env.openExternal(url);
                } catch { /* Noop */ }
                break;
            
            case FromWebViewMessageType.AutomaticBrowserCacheBybassStateChanged:
                vscode.workspace.getConfiguration(EXTENSION_ID).update(AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION, payload.automaticBrowserCacheBypass);
                break;
            
            default:
                debugger;
                break;
        }
    }

    private handleConfigurationChanged(e: vscode.ConfigurationChangeEvent) {
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);

        if (e.affectsConfiguration(`${EXTENSION_ID}.${FOCUS_LOCK_SETTING_SECTION}`)) {
            this.webViewPanel.webview.postMessage({
                type: ToWebViewMessageType.FocusIndicatorLockEnabledStateChanged,
                focusLockIndicator: configuration.get<boolean>(FOCUS_LOCK_SETTING_SECTION, true)
            });
        }

        if (e.affectsConfiguration(`${EXTENSION_ID}.${AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION}`)) {
            this.webViewPanel.webview.postMessage({
                type: ToWebViewMessageType.AutomaticBrowserCacheBybassStateChanged,
                automaticBrowserCacheBypass: configuration.get<boolean>(AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION, true)
            });
        }
    }

    private getHtml(url: string) {
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);

        const nonce = getNonce();

        const mainJs = this.extensionResourceUrl("out/browser", "browserUi.js");
        const mainCss = this.extensionResourceUrl("out/browser", "styles.css");
        const automaticBrowserBypass = configuration.get<boolean>(AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION, true);

        return /* html */ `<!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-type" content="text/html;charset=UTF-8">

                <meta http-equiv="Content-Security-Policy" content="
                    default-src 'none';
                    font-src 'nonce-${nonce}';
                    style-src-elem 'nonce-${nonce}';
                    script-src-elem 'nonce-${nonce}';
                    frame-src *;
                    ">

                <meta id="browser-settings" data-settings="${escapeAttribute(JSON.stringify({
                    url: url,
                    focusLockIndiciatorEnabled: configuration.get<boolean>(FOCUS_LOCK_SETTING_SECTION, true),
                    automaticBrowserCacheBypass: automaticBrowserBypass
                }))}">

                <link rel="stylesheet" type="text/css" href="${mainCss}" nonce="${nonce}">
            </head>
            <body>
                <header class="header">
                    <nav class="controls">
                        <button
                            title="Back"
                            class="back-button icon">back</button>

                        <button
                            title="Forward"
                            class="forward-button icon">forward</button>
                    </nav>

                    <input class="url-input" type="text">

                    <nav class="controls">
                        <input id="bypassCacheCheckbox" type="checkbox" ${automaticBrowserBypass ? "checked" : ""}>
                        <label for="bypassCacheCheckbox">Bypass cache</label>
                        <button
                            title="Reload"
                            class="reload-button icon">reload</button>
                        <button
                            title="Open in system browser"
                            class="open-external-button icon">external</button>
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
        if (!this.webViewPanel.webview.html) {
            this.webViewPanel.webview.html = this.getHtml(url);
        } else {
            this.webViewPanel.webview.postMessage({
                type: ToWebViewMessageType.NavigateToUrl,
                url: url
            });

            options = undefined;
        }

        this.webViewPanel.reveal(options?.viewColumn, true);
    }
}