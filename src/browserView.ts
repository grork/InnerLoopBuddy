import * as vscode from "vscode";
import { EXTENSION_ID } from "./extension";
import * as nodeCrypto from "crypto";

/**
 * Options for how to display the browser window e.g. which column to place it in
 */
export interface ShowOptions {
    readonly viewColumn?: vscode.ViewColumn;
}

/**
 * Messages received from the owned WebView
 */
enum FromWebViewMessageType {
    /**
     * Request to open a URL in the system browser
     */
    OpenInSystemBrowser = "open-in-system-browser",

    /**
     * The user changed the automatic browser cache bypass setting
     */
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed"
}

/**
 * Messages sent to the owned WebView
 */
enum ToWebViewMessageType {
    /**
     * Focus lock indicator setting has changed
     */
    FocusIndicatorLockEnabledStateChanged = "focus-lock-indicator-setting-changed",

    /**
     * Automatic browser cache bypass setting has changed
     */
    AutomaticBrowserCacheBybassStateChanged = "automatic-browser-cache-bypass-setting-changed",

    /**
     * Force an refresh of the focus lock state
     */
    RefreshFocusLockState = "refresh-focus-lock-state",

    /**
     * Request the WebView to open a specific URL
     */
    NavigateToUrl = "navigate-to-url"
}

const BROWSER_TITLE: string = "Inner Loop Buddy Browser";
const FOCUS_LOCK_SETTING_SECTION = "focusLockIndicator";
const AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION = "automaticBrowserCacheBypass";
export const BROWSER_VIEW_TYPE = `${EXTENSION_ID}.browser.view`;

function escapeAttribute(value: string | vscode.Uri): string {
    return value.toString().replace(/"/g, "&quot;");
}

/**
 * Generate a nonce for the content security policy attributes
 */
function getNonce(): string {
    // Favour the browser crypto, if not use nodes (compatible) API
    const actualCrypto = global.crypto ?? <Crypto>nodeCrypto.webcrypto;

    const values = new Uint8Array(64);
    actualCrypto.getRandomValues(values);

    return values.reduce<string>((p, v) => p += v.toString(16), "");
}

/**
 * A Browser view that can navigate to URLs and allow forward/back of navigation
 * that happens within that WebView
 */
export class BrowserView {
    private disposables: vscode.Disposable[] = [];
    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDispose = this._onDidDispose.event;

    /**
     * Creates a browser view & editor
     * 
     * @param extensionUri The base URI for resources to be loaded from
     * @param targetUrl URL to display
     * @param showOptions How the pane should be displayed
     * @param targetWebView If supplied, editor will be created in that pane. If
     *                      omitted, a new pane will be created
     * @returns 
     */
    public static create(
        extensionUri: vscode.Uri,
        targetUrl: string,
        showOptions?: ShowOptions,
        targetWebView?: vscode.WebviewPanel
    ): BrowserView {
        // Restore scenarios provide an existing Web View to attach to. If it's
        // not supplied, we assume we want to create a new one.
        if (!targetWebView) {
            targetWebView = vscode.window.createWebviewPanel(
                BROWSER_VIEW_TYPE,
                BROWSER_TITLE, {
                viewColumn: showOptions?.viewColumn ?? vscode.ViewColumn.Active,
                preserveFocus: true // Don't automatically switch focus to the pane
            }, {
                enableScripts: true, // We execute scripts
                enableForms: true, // We need form submissions
                retainContextWhenHidden: true, // Don't purge the page when it's no longer the active tab
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

        // When we're not longer the active editor, we need to re-evaluate the
        // display of the focus captured indicator.
        this.webViewPanel.onDidChangeViewState((e) => {
            this.webViewPanel.webview.postMessage({
                type: ToWebViewMessageType.RefreshFocusLockState
            });
        }, null, this.disposables);

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

    /**
     * Generates the HTML for the webview -- this is the actual editor HTML that
     * includes our interactive controls etc. Of note, it includes the URL that
     * will be navigated to when the editor renders.
     * 
     * Important: This does nonce / Content Security Policy calculations.
     * @param url URL to navigate to
     * @returns HTML as a string to pass to a web view
     */
    private getHtml(url: string): string {
        const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);

        const nonce = getNonce();

        const mainJs = this.extensionResourceUrl("out", "browser", "browserUi.js");
        const mainCss = this.extensionResourceUrl("out", "browser", "styles.css");
        const automaticBrowserBypass = configuration.get<boolean>(AUTOMATIC_BROWSER_CACHE_BYPASS_SETTING_SECTION, true);
        const settingsData = escapeAttribute(JSON.stringify({
            url: url,
            focusLockIndiciatorEnabled: configuration.get<boolean>(FOCUS_LOCK_SETTING_SECTION, true),
            automaticBrowserCacheBypass: automaticBrowserBypass
        }));

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

                <meta id="browser-settings" data-settings="${settingsData}">

                <link rel="stylesheet" type="text/css" href="${mainCss}" nonce="${nonce}">
            </head>
            <body>
                <header class="header">
                    <nav class="controls">
                        <button title="Back"
                                class="back-button icon">back</button>

                        <button title="Forward"
                                class="forward-button icon">forward</button>
                    </nav>

                    <input class="url-input" type="text">

                    <nav class="controls">
                        <input id="bypassCacheCheckbox"
                               type="checkbox" ${automaticBrowserBypass ? "checked" : ""}>
                        <label for="bypassCacheCheckbox">Bypass cache</label>
                        <button title="Reload"
                                class="reload-button icon">reload</button>
                        <button title="Open in system browser"
                                class="open-external-button icon">external</button>
                    </nav>
                </header>
                <div class="content">
                    <div class="iframe-focused-alert">Focus captured</div>
                    <iframe sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
                </div>

                <script src="${mainJs}" nonce="${nonce}"></script>
            </body>
            </html>`;
    }

    /**
     * Paths inside the webview need to reference unique & opaque URLs to access
     * local resources. This is a conveniance function to make those conversions
     * clearer
     * @param pathComponents Directory paths to combine to get final relative path
     * @returns the opaque url for the resource
     */
    private extensionResourceUrl(...pathComponents: string[]): vscode.Uri {
        return this.webViewPanel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...pathComponents));
    }

    public dispose() {
        this._onDidDispose.fire();
        
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables = [];
    }

    /**
     * Show a specific URL in this instance of the browser. This will also bring
     * the editor pane to the front in the requested column
     * @param url URL to navigate to
     * @param options What display options to use
     */
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